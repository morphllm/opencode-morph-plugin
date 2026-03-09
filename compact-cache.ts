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
  firstMessageId: string;
  lastMessageId: string;
  messageCount: number;
  result: TResult;
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
): SessionCompactCache<TResult> {
  return {
    sessionID: messages[0]!.info.sessionID,
    firstMessageId: messages[0]!.info.id,
    lastMessageId: messages[messages.length - 1]!.info.id,
    messageCount: messages.length,
    result,
  };
}

export function canReuseCompactCache<TMessage extends CacheableMessage, TResult>(
  cache: SessionCompactCache<TResult>,
  messages: TMessage[],
): boolean {
  return (
    cache.sessionID === messages[0]!.info.sessionID &&
    cache.messageCount === messages.length &&
    cache.firstMessageId === messages[0]!.info.id &&
    cache.lastMessageId === messages[messages.length - 1]!.info.id
  );
}

export function canExtendCompactCache<
  TMessage extends CacheableMessage,
  TResult,
>(
  cache: SessionCompactCache<TResult>,
  messages: TMessage[],
): boolean {
  if (
    cache.sessionID !== messages[0]!.info.sessionID ||
    cache.messageCount >= messages.length ||
    cache.firstMessageId !== messages[0]!.info.id
  ) {
    return false;
  }

  return messages[cache.messageCount - 1]?.info.id === cache.lastMessageId;
}

export function buildCachedCompactInput<TResult extends ResultWithOutput>(
  cache: SessionCompactCache<TResult>,
): CompactInputMessage {
  return {
    role: "user",
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
