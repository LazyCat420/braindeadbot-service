import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { getDb } from "./src/lib/db.js";

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

function rateLimiter(request: Request, response: Response, nextFunction: NextFunction) {
  const clientIpAddress = (request.headers["x-forwarded-for"] as string) || request.socket.remoteAddress || request.ip || "unknown";
  const requestCount = ipRequestCounts.get(clientIpAddress) || 0;
  if (requestCount >= MAX_REQUESTS) {
    return response.status(429).json({ error: "Too many requests. Please try again later." });
  }
  ipRequestCounts.set(clientIpAddress, requestCount + 1);
  nextFunction();
}

app.use(rateLimiter);

// Health Endpoint
app.get("/health", (request: Request, response: Response) => {
  response.json({ status: "ok" });
});

// Scores API
app.get("/api/scores", (request: Request, response: Response) => {
  try {
    const database = getDb();
    const scores = database
      .prepare(
        `SELECT id, name, score, altitude, meters, tunnel_depth AS tunnelDepth, created_at AS createdAt
         FROM raccoon_scores
         ORDER BY score DESC
         LIMIT 10`
      )
      .all();
    response.json({ scores });
  } catch (error: unknown) {
    console.error("Failed to fetch scores:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.status(500).json({ error: `Failed to fetch scores: ${errorMessage}` });
  }
});

interface ScoreBody {
  name?: string;
  score?: number;
  altitude?: number;
  meters?: number;
  tunnelDepth?: number;
}

app.post("/api/scores", (request: Request<{}, {}, ScoreBody>, response: Response) => {
  try {
    const { name = "???", score = 0, altitude = 0, meters = 0, tunnelDepth = 0 } = request.body;
    if (typeof name !== "string" || name.length === 0 || name.length > 12) {
      return response.status(400).json({ error: "Name must be 1-12 characters." });
    }
    if (typeof score !== "number" || score < 0 || isNaN(score) || !isFinite(score)) {
      return response.status(400).json({ error: "Score must be a valid non-negative number." });
    }
    if (
      typeof altitude !== "number" || isNaN(altitude) || !isFinite(altitude) ||
      typeof meters !== "number" || isNaN(meters) || !isFinite(meters) ||
      typeof tunnelDepth !== "number" || isNaN(tunnelDepth) || !isFinite(tunnelDepth)
    ) {
      return response.status(400).json({ error: "Altitude, meters, and tunnelDepth must be valid numbers." });
    }
    const database = getDb();
    const statement = database.prepare(
      `INSERT INTO raccoon_scores (name, score, altitude, meters, tunnel_depth)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = statement.run(
      name.slice(0, 12),
      Math.floor(score),
      Math.floor(altitude),
      Math.floor(meters),
      Math.floor(tunnelDepth)
    );
    response.json({ id: result.lastInsertRowid, message: "Score saved!" });
  } catch (error: unknown) {
    console.error("Failed to save score:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.status(500).json({ error: `Failed to save score: ${errorMessage}` });
  }
});

// YouTube Sync API
const RSS_BASE_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

interface YouTubeEntry {
  videoId: string;
  title: string;
}

function parseAtomFeed(feedXmlContent: string, maxResultsCount: number = 5): YouTubeEntry[] {
  const entries: YouTubeEntry[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(feedXmlContent)) !== null && entries.length < maxResultsCount) {
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

async function resolveHandleToChannelId(channelHandle: string): Promise<string | null> {
  try {
    const cleanHandle = channelHandle.startsWith("@") ? channelHandle : `@${channelHandle}`;
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 5000);
    const fetchResponse = await fetch(`https://www.youtube.com/${cleanHandle}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: abortController.signal
    });
    clearTimeout(timeoutId);
    if (!fetchResponse.ok) return null;
    const htmlContent = await fetchResponse.text();
    const channelIdMatch = htmlContent.match(/UC[a-zA-Z0-9_-]{22}/);
    return channelIdMatch ? channelIdMatch[0] : null;
  } catch (error: unknown) {
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

app.post("/api/youtube-sync", async (request: Request<{}, {}, YouTubeSyncBody>, response: Response) => {
  try {
    const { channels } = request.body;
    if (!Array.isArray(channels) || channels.length === 0) {
      return response.status(400).json({ error: "Request body must contain a non-empty 'channels' array." });
    }
    if (channels.length > 10) {
      return response.status(400).json({ error: "Cannot sync more than 10 channels at once." });
    }
    const allRecords: RecordResult[] = [];
    const syncErrors: string[] = [];
    for (const channel of channels as ChannelRequest[]) {
      if (!channel || typeof channel !== "object") {
        syncErrors.push("Invalid channel entry.");
        continue;
      }
      let channelId = channel.channelId as string;
      const artist = channel.artist as string;
      let maxResultsCount = typeof channel.maxResults === "number" ? channel.maxResults : 5;
      
      maxResultsCount = Math.min(Math.max(1, maxResultsCount), 15);
      if (typeof channelId !== "string" || !/^[a-zA-Z0-9_.\-@]+$/.test(channelId)) {
        syncErrors.push(`Invalid channel ID/handle format: ${String(channelId)}`);
        continue;
      }
      if (artist && (typeof artist !== "string" || artist.length > 100)) {
        syncErrors.push(`Invalid artist format/length: ${String(artist)}`);
        continue;
      }
      if (channelId.startsWith("@")) {
        const resolvedId = await resolveHandleToChannelId(channelId);
        if (!resolvedId) {
          syncErrors.push(`Could not resolve handle ${channelId} to a channel ID.`);
          continue;
        }
        channelId = resolvedId;
      }
      if (!channelId || !channelId.startsWith("UC")) {
        syncErrors.push(`Invalid channel ID: ${channelId}`);
        continue;
      }
      try {
        const rssFeedUrlString = `${RSS_BASE_URL}${channelId}`;
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), 8000);
        const fetchResponse = await fetch(rssFeedUrlString, { 
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: abortController.signal
        });
        clearTimeout(timeoutId);
        
        if (!fetchResponse.ok) {
          syncErrors.push(`RSS fetch failed for ${artist || channelId}: HTTP ${fetchResponse.status}`);
          continue;
        }
        const xmlContent = await fetchResponse.text();
        const feedEntries = parseAtomFeed(xmlContent, maxResultsCount);
        for (const entry of feedEntries) {
          allRecords.push({
            type: "youtube",
            id: entry.videoId,
            title: entry.title,
            artist: artist || "Unknown",
          });
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        syncErrors.push(`Error fetching RSS for ${artist || channelId}: ${errorMessage}`);
      }
    }
    
    interface ResultObj {
      records: RecordResult[];
      syncedAt: string;
      errors?: string[];
    }
    
    const syncResult: ResultObj = { records: allRecords, syncedAt: new Date().toISOString() };
    if (syncErrors.length > 0) syncResult.errors = syncErrors;
    response.json(syncResult);
  } catch (error: unknown) {
    console.error("YouTube sync error:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    response.status(500).json({ error: `Server error: ${errorMessage}` });
  }
});

const PORT = process.env.PORT || 5175;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
