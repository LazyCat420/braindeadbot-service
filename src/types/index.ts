export interface ScoreBody {
  name?: string;
  score?: number;
  altitude?: number;
  meters?: number;
  tunnelDepth?: number;
}

export interface ChannelRequest {
  channelId: string;
  artist?: string;
  maxResults?: number;
}

export interface YouTubeSyncBody {
  channels?: ChannelRequest[];
}

export interface RecordResult {
  type: string;
  id: string;
  title: string;
  artist: string;
}

export interface ResultObj {
  records: RecordResult[];
  syncedAt: string;
  errors?: string[];
}
