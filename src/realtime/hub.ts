/**
 * 🔌 Realtime hub — attaches a raw-ws server to the existing HTTP server.
 *
 * Shares the REST port (:5175) on the `/ws` path, so nothing new is exposed and
 * docker-compose / the deploy are untouched. Enforces the SAME origin allowlist
 * the REST CORS uses (an unauthenticated socket is exactly as sensitive as the
 * leaderboard write API), runs a ping/pong heartbeat to reap dead sockets, and
 * throttles floods per connection.
 *
 * All game logic lives in the lobby + sessions; this file is only transport +
 * message routing.
 */
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { decodeClient, type Facing } from "./protocol.js";
import type { Peer } from "./peer.js";
import { Lobby } from "./lobby.js";
import { SessionManager } from "./session.js";

const HEARTBEAT_MS = 30_000;
const MAX_NAME_LEN = 16;
/** Per-connection flood guard: soft-drop above SOFT, hard-close above HARD/sec. */
const SOFT_MSGS_PER_SEC = 120; // 15Hz move + inputs leave generous headroom
const HARD_MSGS_PER_SEC = 400;

interface HubOptions {
  /** Same set the REST CORS builds; an empty set means "allow all origins". */
  allowedOrigins: Set<string>;
  path?: string;
}

function sanitizeName(raw: unknown): string {
  if (typeof raw !== "string") return "Knight";
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LEN);
  return cleaned || "Knight";
}

export function attachRealtime(server: Server, opts: HubOptions): WebSocketServer {
  const sessions = new SessionManager();
  const lobby = new Lobby(sessions);

  const wss = new WebSocketServer({
    server,
    path: opts.path ?? "/ws",
    // ws defaults to a 100 MB frame cap — one oversized message would be fanned
    // out to every peer. Nothing legitimate here comes close to 64 KB.
    maxPayload: 64 * 1024,
    // Reject disallowed browser origins before the handshake completes. No
    // origin (curl, native clients, health checks) is allowed, exactly as the
    // REST CORS treats it.
    verifyClient: ({ origin }, done) => {
      if (!origin || opts.allowedOrigins.size === 0 || opts.allowedOrigins.has(origin)) {
        done(true);
        return;
      }
      done(false, 403, "Origin not allowed");
    },
  });

  wss.on("connection", (ws: WebSocket) => {
    let joined = false;
    let alive = true;
    let msgWindow = 0;
    let windowStart = Date.now();

    const peer: Peer = {
      id: randomUUID(),
      send(msg) {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify(msg));
          } catch {
            /* socket died between the readyState check and send — ignore */
          }
        }
      },
      close(code, reason) {
        try {
          ws.close(code, reason);
        } catch {
          /* already closed */
        }
      },
      name: "Knight",
      slot: -1,
      x: 0,
      z: 0,
      facing: "S",
      scene: "tavern",
      ready: false,
      readyAt: 0,
      sessionId: null,
      overflow: false,
    };

    ws.on("pong", () => {
      alive = true;
    });

    ws.on("message", (data: RawData) => {
      // ── Flood guard ──
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        msgWindow = 0;
      }
      if (++msgWindow > HARD_MSGS_PER_SEC) {
        peer.close(1008, "flood");
        return;
      }
      if (msgWindow > SOFT_MSGS_PER_SEC) return; // drop, don't disconnect

      const msg = decodeClient(data.toString());
      if (!msg) return;

      switch (msg.type) {
        case "hello": {
          if (joined) return; // one hello per connection
          joined = true;
          peer.name = sanitizeName(msg.name);
          lobby.join(peer, typeof msg.preferredSlot === "number" ? msg.preferredSlot : undefined);
          break;
        }
        case "move":
          if (isFinite(msg.x) && isFinite(msg.z)) lobby.move(peer, msg.x, msg.z, msg.facing as Facing, typeof msg.scene === "string" ? msg.scene : "tavern");
          break;
        case "ready":
          lobby.setReady(peer, !!msg.ready);
          break;
        case "session:hello":
          sessions.get(msg.sessionId)?.hello(peer);
          break;
        case "session:snapshot":
          if (peer.sessionId === msg.sessionId) sessions.get(msg.sessionId)?.relaySnapshot(peer.id, msg.snap);
          break;
        case "session:input":
          if (peer.sessionId === msg.sessionId) sessions.get(msg.sessionId)?.relayInput(peer.id, msg.input);
          break;
        case "session:event":
          if (peer.sessionId === msg.sessionId) sessions.get(msg.sessionId)?.relayEvent(peer.id, msg.event);
          break;
        case "session:leave":
          if (peer.sessionId) sessions.leave(peer.sessionId, peer.id);
          break;
        case "ping":
          peer.send({ type: "pong" });
          break;
      }
    });

    const cleanup = (): void => {
      if (peer.sessionId) sessions.leave(peer.sessionId, peer.id);
      if (joined) lobby.leave(peer);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);

    // Heartbeat: mark dead each round, terminate anything that didn't pong.
    const hb = setInterval(() => {
      if (!alive) {
        clearInterval(hb);
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        clearInterval(hb);
      }
    }, HEARTBEAT_MS);
    hb.unref?.(); // don't let the heartbeat alone keep the process alive
    ws.on("close", () => clearInterval(hb));
  });

  console.log(`Realtime hub attached on ${opts.path ?? "/ws"}`);
  return wss;
}
