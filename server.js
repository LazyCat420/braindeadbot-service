import express from 'express';
import cors from 'cors';
import { getDb } from './src/lib/db.js';

const app = express();
app.use(cors());
app.use(express.json());

// Health Endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Scores API
app.get('/api/scores', (req, res) => {
  try {
    const db = getDb();
    const scores = db
      .prepare(
        `SELECT id, name, score, altitude, meters, tunnel_depth AS tunnelDepth, created_at AS createdAt
         FROM raccoon_scores
         ORDER BY score DESC
         LIMIT 10`
      )
      .all();
    res.json({ scores });
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch scores: ${err.message}` });
  }
});

app.post('/api/scores', (req, res) => {
  try {
    const { name = "???", score = 0, altitude = 0, meters = 0, tunnelDepth = 0 } = req.body;
    if (typeof name !== "string" || name.length === 0 || name.length > 12) {
      return res.status(400).json({ error: "Name must be 1-12 characters." });
    }
    if (typeof score !== "number" || score < 0) {
      return res.status(400).json({ error: "Score must be a non-negative number." });
    }
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO raccoon_scores (name, score, altitude, meters, tunnel_depth)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      name.slice(0, 12),
      Math.floor(score),
      Math.floor(altitude),
      Math.floor(meters),
      Math.floor(tunnelDepth)
    );
    res.json({ id: result.lastInsertRowid, message: "Score saved!" });
  } catch (err) {
    res.status(500).json({ error: `Failed to save score: ${err.message}` });
  }
});

// YouTube Sync API
const RSS_BASE = "https://www.youtube.com/feeds/videos.xml?channel_id=";

function parseAtomFeed(xml, maxResults = 5) {
  const entries = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null && entries.length < maxResults) {
    const block = match[1];
    const videoIdMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoIdMatch) continue;
    const titleMatch = block.match(/<title>([^<]+)<\/title>/);
    entries.push({
      videoId: videoIdMatch[1].trim(),
      title: titleMatch ? titleMatch[1].trim() : "Untitled",
    });
  }
  return entries;
}

async function resolveHandleToChannelId(handle) {
  try {
    const cleanHandle = handle.startsWith("@") ? handle : `@${handle}`;
    const res = await fetch(`https://www.youtube.com/${cleanHandle}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const idMatch = html.match(/UC[a-zA-Z0-9_-]{22}/);
    return idMatch ? idMatch[0] : null;
  } catch {
    return null;
  }
}

app.post('/api/youtube-sync', async (req, res) => {
  try {
    const { channels } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: "Request body must contain a non-empty 'channels' array." });
    }
    const allRecords = [];
    const errors = [];
    for (const channel of channels) {
      let { channelId, artist, maxResults = 5 } = channel;
      maxResults = Math.min(Math.max(1, maxResults), 15);
      if (channelId && channelId.startsWith("@")) {
        const resolved = await resolveHandleToChannelId(channelId);
        if (!resolved) {
          errors.push(`Could not resolve handle ${channelId} to a channel ID.`);
          continue;
        }
        channelId = resolved;
      }
      if (!channelId || !channelId.startsWith("UC")) {
        errors.push(`Invalid channel ID: ${channelId}`);
        continue;
      }
      try {
        const feedUrl = `${RSS_BASE}${channelId}`;
        const fetchRes = await fetch(feedUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!fetchRes.ok) {
          errors.push(`RSS fetch failed for ${artist || channelId}: HTTP ${fetchRes.status}`);
          continue;
        }
        const xml = await fetchRes.text();
        const entries = parseAtomFeed(xml, maxResults);
        for (const entry of entries) {
          allRecords.push({
            type: "youtube",
            id: entry.videoId,
            title: entry.title,
            artist: artist || "Unknown",
          });
        }
      } catch (err) {
        errors.push(`Error fetching RSS for ${artist || channelId}: ${err.message}`);
      }
    }
    const resultObj = { records: allRecords, syncedAt: new Date().toISOString() };
    if (errors.length > 0) resultObj.errors = errors;
    res.json(resultObj);
  } catch (err) {
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

const PORT = process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
