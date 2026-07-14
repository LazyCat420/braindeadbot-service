import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAtomFeed } from "../src/routes/youtubeSync.js";

function entry(videoId: string, title: string): string {
  return `<entry><yt:videoId>${videoId}</yt:videoId><title>${title}</title></entry>`;
}

test("parses valid entries with id and title", () => {
  const xml = entry("dQw4w9WgXcQ", "Never Gonna") + entry("abcDEF12345", "Second Video");
  const result = parseAtomFeed(xml);
  assert.deepEqual(result, [
    { videoId: "dQw4w9WgXcQ", title: "Never Gonna" },
    { videoId: "abcDEF12345", title: "Second Video" },
  ]);
});

test("respects maxResultsCount", () => {
  const xml = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map((id, i) => entry(id, `V${i}`)).join("");
  assert.equal(parseAtomFeed(xml, 2).length, 2);
});

test("skips entries with malformed video ids", () => {
  const xml =
    entry("short", "Too Short") +
    entry("has spaces!!", "Bad Chars") +
    entry("goodid12345", "Good");
  const result = parseAtomFeed(xml);
  assert.equal(result.length, 1);
  assert.equal(result[0].videoId, "goodid12345");
});

test("skips entries missing a videoId element entirely", () => {
  const xml = "<entry><title>No Id Here</title></entry>" + entry("goodid12345", "Good");
  const result = parseAtomFeed(xml);
  assert.equal(result.length, 1);
});

test("decodes XML entities in titles", () => {
  const xml = entry("goodid12345", "Rock &amp; Roll &quot;Live&quot; &#39;26");
  const result = parseAtomFeed(xml);
  assert.equal(result[0].title, `Rock & Roll "Live" '26`);
});

test("falls back to Untitled when title is missing", () => {
  const xml = "<entry><yt:videoId>goodid12345</yt:videoId></entry>";
  const result = parseAtomFeed(xml);
  assert.equal(result[0].title, "Untitled");
});

test("returns empty array for empty or garbage input", () => {
  assert.deepEqual(parseAtomFeed(""), []);
  assert.deepEqual(parseAtomFeed("<feed>nothing here</feed>"), []);
});
