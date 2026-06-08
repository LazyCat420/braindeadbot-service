import { Router, Request, Response } from "express";
import { getDb } from "../lib/db.js";
import { getErrorMessage } from "../utils/error-handler.js";
import { YouTubeSyncBody, RecordResult, ResultObj } from "../types/index.js";

const router = Router();
const YOUTUBE_RSS_BASE_URL = "https://www.youtube.com/feeds/videos.xml?channel_id=";

export interface TransformedYouTubeEntry {
  videoId: string;
  title: string;
}

export function parseAtomFeed(feedXmlContent: string, maxResultsCount: number = 5): TransformedYouTubeEntry[] {
  const entries: TransformedYouTubeEntry[] = [];
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

export async function resolveHandleToChannelId(channelHandle: string): Promise<string | null> {
  const cleanHandle = channelHandle.startsWith("@") ? channelHandle.toLowerCase() : `@${channelHandle.toLowerCase()}`;
  
  // 1. Try to read from cache first
  try {
    const database = getDb();
    const cached = database.prepare("SELECT channel_id FROM youtube_handle_cache WHERE handle = ?").get(cleanHandle) as { channel_id: string } | undefined;
    if (cached) {
      return cached.channel_id;
    }
  } catch (error) {
    console.error("Cache read failed:", error);
  }

  // 2. Fetch and parse if not cached
  try {
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
    if (channelIdMatch) {
      const channelId = channelIdMatch[0];
      // Store in cache
      try {
        const database = getDb();
        database.prepare(
          "INSERT OR REPLACE INTO youtube_handle_cache (handle, channel_id, created_at) VALUES (?, ?, datetime('now'))"
        ).run(cleanHandle, channelId);
      } catch (err) {
        console.error("Failed to store handle cache:", err);
      }
      return channelId;
    }
    return null;
  } catch (error: unknown) {
    return null;
  }
}

export async function fetchYouTubeRss(channelId: string, artist: string, maxResultsCount: number): Promise<TransformedYouTubeEntry[]> {
  const rssFeedUrlString = `${YOUTUBE_RSS_BASE_URL}${channelId}`;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 8000);
  
  const fetchResponse = await fetch(rssFeedUrlString, { 
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: abortController.signal
  });
  
  clearTimeout(timeoutId);
  
  if (!fetchResponse.ok) {
    throw new Error(`RSS fetch failed for ${artist || channelId}: HTTP ${fetchResponse.status}`);
  }
  
  const xmlContent = await fetchResponse.text();
  return parseAtomFeed(xmlContent, maxResultsCount);
}

router.post("/", async (request: Request<{}, {}, YouTubeSyncBody>, response: Response): Promise<void | Response> => {
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
    
    for (const channel of channels) {
      if (!channel || typeof channel !== "object") {
        syncErrors.push("Invalid channel entry.");
        continue;
      }
      
      let channelId = channel.channelId;
      const artist = channel.artist;
      let maxResultsCount = typeof channel.maxResults === "number" ? channel.maxResults : 5;
      maxResultsCount = Math.min(Math.max(1, maxResultsCount), 15);
      
      if (typeof channelId !== "string" || !/^[a-zA-Z0-9_.\-@]+$/.test(channelId)) {
        syncErrors.push(`Invalid channel ID/handle format: ${String(channelId)}`);
        continue;
      }
      if (artist !== undefined && (typeof artist !== "string" || artist.length > 100)) {
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
      
      if (!channelId.startsWith("UC")) {
        syncErrors.push(`Invalid channel ID: ${channelId}`);
        continue;
      }
      
      try {
        const feedEntries = await fetchYouTubeRss(channelId, artist || "Unknown", maxResultsCount);
        for (const entry of feedEntries) {
          allRecords.push({
            type: "youtube",
            id: entry.videoId,
            title: entry.title,
            artist: artist || "Unknown",
          });
        }
      } catch (error: unknown) {
        syncErrors.push(`Error fetching RSS for ${artist || channelId}: ${getErrorMessage(error)}`);
      }
    }
    
    const syncResult: ResultObj = { records: allRecords, syncedAt: new Date().toISOString() };
    if (syncErrors.length > 0) {
      syncResult.errors = syncErrors;
    }
    
    response.json(syncResult);
  } catch (error: unknown) {
    console.error("YouTube sync error:", error);
    response.status(500).json({ error: `Server error: ${getErrorMessage(error)}` });
  }
});

export default router;
