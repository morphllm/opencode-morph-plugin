export type CompactInputMessage = {
  role: string;
  content: string;
  name?: string;
};

export type ChunkSummary = {
  messageCount: number;
  messageDigests: string[];
  output: string;
  charCountSaved: number;
};

export type SessionCompactCache = {
  sessionID: string;
  configDigest: string;
  chunks: ChunkSummary[];
  totalMessagesCompacted: number;
};

export type CompactFingerprint = {
  messageDigests: string[];
  configDigest: string;
};

export function createBoundedCompactCache(maxSize: number) {
  const map = new Map<string, SessionCompactCache>();

  return {
    get(sessionID: string): SessionCompactCache | undefined {
      const entry = map.get(sessionID);
      if (entry) {
        map.delete(sessionID);
        map.set(sessionID, entry);
      }
      return entry;
    },

    set(sessionID: string, entry: SessionCompactCache) {
      map.delete(sessionID);
      map.set(sessionID, entry);
      if (map.size > maxSize) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },

    has(sessionID: string): boolean {
      return map.has(sessionID);
    },

    size(): number {
      return map.size;
    },
  };
}

export function matchCacheChunks(
  cache: SessionCompactCache,
  fingerprint: CompactFingerprint,
): {
  matchedChunks: ChunkSummary[];
  matchedMessageCount: number;
} {
  if (cache.configDigest !== fingerprint.configDigest) {
    return { matchedChunks: [], matchedMessageCount: 0 };
  }

  const matchedChunks: ChunkSummary[] = [];
  let matchedMessageCount = 0;

  for (const chunk of cache.chunks) {
    let chunkMatches = true;
    for (let i = 0; i < chunk.messageCount; i++) {
      if (
        matchedMessageCount + i >= fingerprint.messageDigests.length ||
        fingerprint.messageDigests[matchedMessageCount + i] !== chunk.messageDigests[i]
      ) {
        chunkMatches = false;
        break;
      }
    }
    if (!chunkMatches) break;
    matchedChunks.push(chunk);
    matchedMessageCount += chunk.messageCount;
  }

  return { matchedChunks, matchedMessageCount };
}
