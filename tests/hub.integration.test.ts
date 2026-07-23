/**
 * Realtime hub integration test — real HTTP server, real ws clients.
 *
 * The lobby has unit coverage with fakes; this exercises the actual transport:
 * origin gating, the JSON envelope, hello/welcome, room snapshots, join/leave
 * fan-out, movement relay, and the ready → party:forming pipeline end to end.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { attachRealtime } from "../src/realtime/hub.js";
import type { ServerMessage } from "../src/realtime/protocol.js";

const ORIGIN = "http://localhost:5174";

function listen(): Promise<{ server: Server; port: number; teardown: () => void }> {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = attachRealtime(server, { allowedOrigins: new Set([ORIGIN]) });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        teardown: () => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.close();
        },
      }),
    );
  });
}

/** A test client that records every frame and can await a specific type. */
function client(port: number, origin = ORIGIN) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const seen: ServerMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as ServerMessage;
    seen.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].type === m.type) {
        waiters[i].resolve(m);
        waiters.splice(i, 1);
      }
    }
  });
  return {
    ws,
    seen,
    open: () =>
      new Promise<void>((r, j) => {
        if (ws.readyState === WebSocket.OPEN) return r();
        ws.once("open", () => r());
        ws.once("error", j);
      }),
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    // Resolve with the next (or already-seen) frame of `type`.
    next: <T extends ServerMessage["type"]>(type: T) =>
      new Promise<Extract<ServerMessage, { type: T }>>((resolve) => {
        const hit = seen.find((m) => m.type === type);
        if (hit) return resolve(hit as Extract<ServerMessage, { type: T }>);
        waiters.push({ type, resolve: resolve as (m: ServerMessage) => void });
      }),
    close: () => ws.close(),
  };
}

test("origin gating: a disallowed origin is rejected", async () => {
  const { server, port, teardown } = await listen();
  try {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: "http://evil.example" });
    await new Promise<void>((resolve, reject) => {
      bad.once("open", () => reject(new Error("evil origin should not connect")));
      bad.once("error", () => resolve()); // handshake rejected
      bad.once("unexpected-response", () => resolve());
    });
  } finally {
    teardown();
  }
});

test("two clients: welcome, room snapshot, join fan-out, move relay, ready → forming", async () => {
  const { server, port, teardown } = await listen();
  const a = client(port);
  const b = client(port);
  try {
    await a.open();
    a.send({ type: "hello", name: "AAA" });
    const wa = await a.next("welcome");
    assert.equal(wa.slot, 0);

    await b.open();
    b.send({ type: "hello", name: "BBB" });
    const wb = await b.next("welcome");
    assert.equal(wb.slot, 1);

    // B's room snapshot already contains A.
    const snap = await b.next("room:state");
    assert.equal(snap.players.length, 1);
    assert.equal(snap.players[0].name, "AAA");

    // A hears B arrive.
    const join = await a.next("player:join");
    assert.equal(join.player.name, "BBB");

    // A moves → B receives the relayed position.
    a.send({ type: "move", x: 1.5, z: 2, facing: "E" });
    const mv = await b.next("player:move");
    assert.equal(mv.id, wa.id);
    assert.equal(mv.x, 1.5);
    assert.equal(mv.facing, "E");

    // Both ready → a party countdown forms at 10s.
    a.send({ type: "ready", ready: true });
    b.send({ type: "ready", ready: true });
    const forming = await a.next("party:forming");
    assert.equal(forming.seconds, 10);
    assert.equal(forming.members.length, 2);
  } finally {
    a.close();
    b.close();
    teardown();
  }
});
