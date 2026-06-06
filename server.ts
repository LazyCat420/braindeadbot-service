import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { getDb } from './src/lib/db.js';

const app = express();
app.use(cors());
app.use(express.json());

// Simple in-memory rate limiter
const ipRequestCounts = new Map<string, number>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS = 60; // 60 requests per minute

// Clear rate limits periodically
setInterval(() => {
  ipRequestCounts.clear();
}, RATE_LIMIT_WINDOW);

function rateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || req.ip || "unknown";
  const count = ipRequestCounts.get(ip) || 0;
  if (count >= MAX_REQUESTS) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }
  ipRequestCounts.set(ip, count + 1);
  next();
}

app.use(rateLimiter);

// Health Endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Scores API
app.get('/api/scores', (req: Request, res: Response) => {
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
  } catch (error: unknown) {
    console.error("Failed to fetch scores:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to fetch scores: ${errorMessage}` });
  }
});

interface ScoreBody {
  name?: string;
  score?: number;
  altitude?: number;
  meters?: number;
  tunnelDepth?: number;
}

app.post('/api/scores', (req: Request<{}, {}, ScoreBody>, res: Response) => {
  try {
    const { name = "???", score = 0, altitude = 0, meters = 0, tunnelDepth = 0 } = req.body;
    if (typeof name !== "string" || name.length === 0 || name.length > 12) {
      return res.status(400).json({ error: "Name must be 1-12 characters." });
    }
    if (typeof score !== "number" || score < 0 || isNaN(score) || !isFinite(score)) {
      return res.status(400).json({ error: "Score must be a valid non-negative number." });
    }
    if (
      typeof altitude !== "number" || isNaN(altitude) || !isFinite(altitude) ||
      typeof meters !== "number" || isNaN(meters) || !isFinite(meters) ||
      typeof tunnelDepth !== "number" || isNaN(tunnelDepth) || !isFinite(tunnelDepth)
    ) {
      return res.status(400).json({ error: "Altitude, meters, and tunnelDepth must be valid numbers." });
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
  } catch (error: unknown) {
    console.error("Failed to save score:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Failed to save score: ${errorMessage}` });
  }
});

// YouTube Sync API
const RSS_BASE = "https://www.youtube.com/feeds/videos.xml?channel_id=";

interface YouTubeEntry {
  videoId: string;
  title: string;
}

function parseAtomFeed(xml: string, maxResults: number = 5): YouTubeEntry[] {
  const entries: YouTubeEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null && entries.length < maxResults) {
    const block = match[1];
    const videoIdMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
    if (!videoIdMatch) continue;
    const rawVideoId = videoIdMatch[1].trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(rawVideoId)) {
      continue;
    }
    const titleMatch = block.match(/<title>([^<]+)<\/title>/);
    entries.push({
      videoId: rawVideoId,
      title: titleMatch ? titleMatch[1].trim() : "Untitled",
    });
  }
  return entries;
}

async function resolveHandleToChannelId(handle: string): Promise<string | null> {
  try {
    const cleanHandle = handle.startsWith("@") ? handle : `@${handle}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://www.youtube.com/${cleanHandle}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!res.ok) return null;
    const html = await res.text();
    const idMatch = html.match(/UC[a-zA-Z0-9_-]{22}/);
    return idMatch ? idMatch[0] : null;
  } catch {
    return null;
  }
}

interface ChannelRequest {
  channelId?: unknown;
  artist?: unknown;
  maxResults?: unknown;
}

interface YouTubeSyncBody {
  channels?: unknown;
}

interface RecordResult {
  type: string;
  id: string;
  title: string;
  artist: string;
}

app.post('/api/youtube-sync', async (req: Request<{}, {}, YouTubeSyncBody>, res: Response) => {
  try {
    const { channels } = req.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: "Request body must contain a non-empty 'channels' array." });
    }
    if (channels.length > 10) {
      return res.status(400).json({ error: "Cannot sync more than 10 channels at once." });
    }
    const allRecords: RecordResult[] = [];
    const errors: string[] = [];
    for (const channel of channels as ChannelRequest[]) {
      if (!channel || typeof channel !== "object") {
        errors.push("Invalid channel entry.");
        continue;
      }
      let channelId = channel.channelId as string;
      const artist = channel.artist as string;
      let maxResults = typeof channel.maxResults === "number" ? channel.maxResults : 5;
      
      maxResults = Math.min(Math.max(1, maxResults), 15);
      if (typeof channelId !== "string" || !/^[a-zA-Z0-9_.\-@]+$/.test(channelId)) {
        errors.push(`Invalid channel ID/handle format: ${String(channelId)}`);
        continue;
      }
      if (artist && (typeof artist !== "string" || artist.length > 100)) {
        errors.push(`Invalid artist format/length: ${String(artist)}`);
        continue;
      }
      if (channelId.startsWith("@")) {
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const fetchRes = await fetch(feedUrl, { 
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        
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
            artist: (artist as string) || "Unknown",
          });
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Error fetching RSS for ${artist || channelId}: ${errorMessage}`);
      }
    }
    
    interface ResultObj {
      records: RecordResult[];
      syncedAt: string;
      errors?: string[];
    }
    
    const resultObj: ResultObj = { records: allRecords, syncedAt: new Date().toISOString() };
    if (errors.length > 0) resultObj.errors = errors;
    res.json(resultObj);
  } catch (error: unknown) {
    console.error("YouTube sync error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: `Server error: ${errorMessage}` });
  }
});

const PORT = process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
