import type { CompactResult } from "@morphllm/morphsdk";

export type CompactInputMessage = {
  role: string;
  content: string;
  name?: string;
};

type CacheableMessage = {
  info: {
    sessionID: string;
    id: string;
  };
};

type ResultWithOutput = {
  output: string;
};

export type SessionCompactCache<TResult = CompactResult> = {
  sessionID: string;
  messageCount: number;
  messageDigests: string[];
  prefixDigest: string;
  configDigest: string;
  result: TResult;
  incrementalCount: number;
};

export type CompactFingerprint = {
  messageDigests: string[];
  prefixDigest: string;
  configDigest: string;
};

export function createBoundedCompactCache<TResult>(maxSize: number) {
  const map = new Map<string, SessionCompactCache<TResult>>();

  return {
    get(sessionID: string): SessionCompactCache<TResult> | undefined {
      const entry = map.get(sessionID);
      if (entry) {
        map.delete(sessionID);
        map.set(sessionID, entry);
      }
      return entry;
    },

    set(sessionID: string, entry: SessionCompactCache<TResult>) {
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

export function buildCompactCacheEntry<
  TMessage extends CacheableMessage,
  TResult,
>(
  messages: TMessage[],
  result: TResult,
  fingerprint: CompactFingerprint,
  incrementalCount: number = 0,
): SessionCompactCache<TResult> {
  return {
    sessionID: messages[0]!.info.sessionID,
    messageCount: messages.length,
    messageDigests: fingerprint.messageDigests,
    prefixDigest: fingerprint.prefixDigest,
    configDigest: fingerprint.configDigest,
    result,
    incrementalCount,
  };
}

export function canReuseCompactCache<TResult>(
  cache: SessionCompactCache<TResult>,
  sessionID: string,
  fingerprint: CompactFingerprint,
): boolean {
  return (
    cache.sessionID === sessionID &&
    cache.messageCount === fingerprint.messageDigests.length &&
    cache.configDigest === fingerprint.configDigest &&
    cache.prefixDigest === fingerprint.prefixDigest
  );
}

export function canExtendCompactCache<TResult>(
  cache: SessionCompactCache<TResult>,
  sessionID: string,
  fingerprint: CompactFingerprint,
  maxIncrementalExtensions: number = 10,
): boolean {
  if (
    cache.sessionID !== sessionID ||
    cache.configDigest !== fingerprint.configDigest ||
    cache.messageCount >= fingerprint.messageDigests.length
  ) {
    return false;
  }

  if (cache.incrementalCount >= maxIncrementalExtensions) {
    return false;
  }

  if (cache.messageDigests.length !== cache.messageCount) {
    return false;
  }

  return cache.messageDigests.every(
    (digest, index) => fingerprint.messageDigests[index] === digest,
  );
}

export function buildCachedCompactInput<TResult extends ResultWithOutput>(
  cache: SessionCompactCache<TResult>,
): CompactInputMessage {
  return {
    role: "assistant",
    content: `[Morph Compact summary of ${cache.messageCount} earlier messages]\n\n${cache.result.output}`,
  };
}

export function buildIncrementalCompactInput<
  TMessage extends CacheableMessage,
  TResult extends ResultWithOutput,
>(
  cache: SessionCompactCache<TResult>,
  messages: TMessage[],
  messagesToCompactInput: (messages: TMessage[]) => CompactInputMessage[],
): CompactInputMessage[] {
  const deltaMessages = messages.slice(cache.messageCount);
  return [buildCachedCompactInput(cache), ...messagesToCompactInput(deltaMessages)];
}
