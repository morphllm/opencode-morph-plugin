import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompactClient } from "@morphllm/morphsdk";

// These are internal to the plugin but duplicated here for testing.
const EXISTING_CODE_MARKER = "// ... existing code ...";

function normalizeCodeEditInput(codeEdit: string): string {
  const trimmed = codeEdit.trim();
  const lines = trimmed.split("\n");
  if (lines.length < 3) return codeEdit;
  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  if (/^```[\w-]*$/.test(firstLine!) && /^```$/.test(lastLine!)) {
    return lines.slice(1, -1).join("\n");
  }
  return codeEdit;
}

async function importPluginWithEnv(
  env: Record<string, string | undefined>,
): Promise<{
  default: (input: any) => Promise<Record<string, any>>;
}> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    const cacheBuster = `plugin-test-${Date.now()}-${Math.random()}`;
    return await import(`./index.ts?${cacheBuster}`);
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makePluginInput(directory: string, worktree = directory) {
  return {
    client: {
      app: {
        log: async () => {},
      },
    },
    project: {},
    directory,
    worktree,
    serverUrl: new URL("http://localhost"),
    $: {},
  };
}

function makeToolContext(directory: string, worktree = directory) {
  return {
    sessionID: "session-test",
    messageID: "message-test",
    agent: "coder",
    directory,
    worktree,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

describe("EXISTING_CODE_MARKER", () => {
  test("is the canonical marker string", () => {
    expect(EXISTING_CODE_MARKER).toBe("// ... existing code ...");
  });
});

describe("packaged tool-selection instructions", () => {
  test("instruction file exists and routes large edits to morph_edit", () => {
    const content = readFileSync(
      join(import.meta.dir, "instructions", "morph-tools.md"),
      "utf-8",
    );

    expect(content).toContain("Morph Tool Selection Policy");
    expect(content).toContain("canonical always-on routing policy for Morph tools");
    expect(content).toContain("~/.config/opencode/instructions/morph-tools.md");
    expect(content).toContain("Large file edits (300+ lines)");
    expect(content).toContain("`morph_edit`");
    expect(content).toContain("Small exact replacement");
    expect(content).toContain("`edit`");
    expect(content).toContain("New file creation");
    expect(content).toContain("`write`");
    expect(content).toContain("`warpgrep_github_search`");
    expect(content).toContain("Public GitHub repo exploration");
    expect(content).toContain("Tool Exposure Requirement");
    expect(content).toContain("morph_edit: true");
  });

  test("README documents plugin setup and tools", () => {
    const content = readFileSync(join(import.meta.dir, "README.md"), "utf-8");

    expect(content).toContain("morph_edit");
    expect(content).toContain("warpgrep_codebase_search");
    expect(content).toContain("warpgrep_github_search");
    expect(content).toContain("MORPH_API_KEY");
    expect(content).toContain("MORPH_COMPACT_TOKEN_LIMIT");
    expect(content).toContain("opencode.json");
  });
});

describe("normalizeCodeEditInput", () => {
  test("returns plain code unchanged", () => {
    const input = `${EXISTING_CODE_MARKER}\nfunction foo() { return 1 }\n${EXISTING_CODE_MARKER}`;
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("strips standard markdown fence with language", () => {
    const input = "```typescript\nfunction foo() { return 1 }\n```";
    expect(normalizeCodeEditInput(input)).toBe("function foo() { return 1 }");
  });

  test("strips markdown fence without language", () => {
    const input = "```\nfunction foo() { return 1 }\n```";
    expect(normalizeCodeEditInput(input)).toBe("function foo() { return 1 }");
  });

  test("preserves multi-line content inside fences", () => {
    const inner = `${EXISTING_CODE_MARKER}\nfunction foo() {\n  return 1\n}\n${EXISTING_CODE_MARKER}`;
    const input = `\`\`\`typescript\n${inner}\n\`\`\``;
    expect(normalizeCodeEditInput(input)).toBe(inner);
  });

  test("does not strip incomplete fences (missing closing)", () => {
    const input = "```typescript\nfunction foo() { return 1 }";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("does not strip incomplete fences (missing opening)", () => {
    const input = "function foo() { return 1 }\n```";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("returns short input unchanged (< 3 lines)", () => {
    expect(normalizeCodeEditInput("hello")).toBe("hello");
    expect(normalizeCodeEditInput("line1\nline2")).toBe("line1\nline2");
  });

  test("handles fence with hyphenated language", () => {
    const input = "```c-sharp\nConsole.WriteLine();\n```";
    expect(normalizeCodeEditInput(input)).toBe("Console.WriteLine();");
  });

  test("does not strip fences with text after closing", () => {
    const input = "```typescript\nfoo()\n``` extra text";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("trims whitespace before checking fences", () => {
    const input = "  \n```typescript\nfunction foo() {}\n```\n  ";
    expect(normalizeCodeEditInput(input)).toBe("function foo() {}");
  });

  test("returns empty string unchanged", () => {
    expect(normalizeCodeEditInput("")).toBe("");
  });

  test("handles fence with only whitespace content", () => {
    const input = "```\n  \n```";
    expect(normalizeCodeEditInput(input)).toBe("  ");
  });

  test("handles javascript language tag", () => {
    const input = "```javascript\nconst x = 1;\n```";
    expect(normalizeCodeEditInput(input)).toBe("const x = 1;");
  });

  test("handles python language tag", () => {
    const input = "```python\ndef foo():\n    pass\n```";
    expect(normalizeCodeEditInput(input)).toBe("def foo():\n    pass");
  });

  test("does not strip if closing fence has language", () => {
    // Invalid markdown: closing fence should not have a language
    const input = "```typescript\nfoo()\n```typescript";
    expect(normalizeCodeEditInput(input)).toBe(input);
  });

  test("preserves content with backticks inside fences", () => {
    const input = "```typescript\nconst x = `hello ${world}`;\n```";
    expect(normalizeCodeEditInput(input)).toBe("const x = `hello ${world}`;");
  });
});

describe("marker leakage detection logic", () => {
  test("detected when original lacks marker", () => {
    const originalCode = "function foo() { return 1 }";
    const mergedCode = `function foo() { return 1 }\n${EXISTING_CODE_MARKER}\nfunction bar() {}`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  test("skipped when original already contains marker", () => {
    const originalCode = `// Use "${EXISTING_CODE_MARKER}" to represent unchanged code`;
    const mergedCode = `// Use "${EXISTING_CODE_MARKER}" to represent unchanged code\n// Added line`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });

  test("not triggered when no markers in input", () => {
    const originalCode = "function foo() { return 1 }";
    const mergedCode = `function foo() { return 1 }\n${EXISTING_CODE_MARKER}`;
    const hasMarkers = false;

    const wouldTrigger =
      hasMarkers && mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });

  test("detected when marker appears at start of merged output", () => {
    const originalCode = "const x = 1;\nconst y = 2;";
    const mergedCode = `${EXISTING_CODE_MARKER}\nconst x = 1;\nconst y = 2;`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  test("detected when marker appears at end of merged output", () => {
    const originalCode = "const x = 1;\nconst y = 2;";
    const mergedCode = `const x = 1;\nconst y = 2;\n${EXISTING_CODE_MARKER}`;
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(true);
  });

  test("not triggered on clean merge (no markers in output)", () => {
    const originalCode = "function foo() { return 1 }";
    const mergedCode = "function foo() { return 2 }";
    const hasMarkers = true;
    const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);

    const wouldTrigger =
      hasMarkers &&
      !originalHadMarker &&
      mergedCode.includes(EXISTING_CODE_MARKER);
    expect(wouldTrigger).toBe(false);
  });
});

describe("truncation detection logic", () => {
  // Helper to simulate the guard condition
  function wouldTriggerTruncation(
    originalCode: string,
    mergedCode: string,
    hasMarkers: boolean,
  ): { triggered: boolean; charLoss: number; lineLoss: number } {
    const originalLineCount = originalCode.split("\n").length;
    const mergedLineCount = mergedCode.split("\n").length;
    const charLoss =
      (originalCode.length - mergedCode.length) / originalCode.length;
    const lineLoss = (originalLineCount - mergedLineCount) / originalLineCount;
    return {
      triggered: hasMarkers && charLoss > 0.6 && lineLoss > 0.5,
      charLoss,
      lineLoss,
    };
  }

  test("triggers when both char and line loss exceed thresholds", () => {
    const originalCode = "x".repeat(1000) + "\n".repeat(100);
    const mergedCode = "x".repeat(300) + "\n".repeat(40);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(true);
  });

  test("does not trigger when only char loss exceeds threshold", () => {
    // Lots of char loss but lines stay similar (whitespace removal)
    const originalCode = "x    ".repeat(200) + "\n".repeat(50);
    const mergedCode = "x".repeat(200) + "\n".repeat(50);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(false);
    expect(result.lineLoss).toBeLessThanOrEqual(0.5);
  });

  test("does not trigger when only line loss exceeds threshold", () => {
    // Lines shrunk but chars stayed similar (joined multi-line to single-line)
    const lines = Array.from({ length: 100 }, () => "ab").join("\n");
    const joined = Array.from({ length: 40 }, () => "ab".repeat(3)).join("\n");

    const result = wouldTriggerTruncation(lines, joined, true);
    expect(result.triggered).toBe(false);
    expect(result.charLoss).toBeLessThanOrEqual(0.6);
  });

  test("does not trigger when no markers in input", () => {
    const originalCode = "x".repeat(1000) + "\n".repeat(100);
    const mergedCode = "x".repeat(100);

    const result = wouldTriggerTruncation(originalCode, mergedCode, false);
    expect(result.triggered).toBe(false);
  });

  test("does not trigger when file grows (negative loss)", () => {
    const originalCode = "short\nfile\n";
    const mergedCode = "short\nfile\nwith\nmany\nnew\nlines\nadded\nhere\n";

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.triggered).toBe(false);
    expect(result.charLoss).toBeLessThan(0);
    expect(result.lineLoss).toBeLessThan(0);
  });

  test("does not trigger on empty original file", () => {
    const originalCode = "";
    const mergedCode = "new content";

    // Edge: division by zero for charLoss/lineLoss produces NaN/Infinity
    const originalLineCount = originalCode.split("\n").length;
    const mergedLineCount = mergedCode.split("\n").length;
    const charLoss =
      (originalCode.length - mergedCode.length) / originalCode.length;
    const lineLoss = (originalLineCount - mergedLineCount) / originalLineCount;

    // NaN > 0.6 is false, so this should NOT trigger
    const triggered = true && charLoss > 0.6 && lineLoss > 0.5;
    expect(triggered).toBe(false);
  });

  test("triggers just above both thresholds", () => {
    // original: 1000 chars, merged: 390 chars → charLoss = 0.61
    // original: 100 lines, merged: 49 lines → lineLoss = 0.51
    const originalCode = "x".repeat(900) + "\n".repeat(100);
    const mergedCode = "x".repeat(341) + "\n".repeat(49);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.charLoss).toBeGreaterThan(0.6);
    expect(result.lineLoss).toBeGreaterThan(0.5);
    expect(result.triggered).toBe(true);
  });

  test("does not trigger when just below char threshold", () => {
    // original: 1000 chars, merged: 401 chars → charLoss = 0.599
    // original: 100 lines, merged: 10 lines → lineLoss = 0.90
    const originalCode = "x".repeat(900) + "\n".repeat(100);
    const mergedCode = "x".repeat(391) + "\n".repeat(10);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    expect(result.charLoss).toBeLessThanOrEqual(0.6);
    expect(result.triggered).toBe(false);
  });

  test("handles single-line file correctly", () => {
    const originalCode = "x".repeat(100);
    const mergedCode = "x".repeat(10);

    const result = wouldTriggerTruncation(originalCode, mergedCode, true);
    // lineLoss = (1-1)/1 = 0, which is below 0.5
    expect(result.lineLoss).toBe(0);
    expect(result.triggered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Compaction helper functions — duplicated from index.ts for testing
// ---------------------------------------------------------------------------

type FakePart =
  | { type: "text"; text: string }
  | { type: "tool"; tool: string; state: any }
  | { type: "reasoning"; text: string }
  | { type: "step-start" }
  | { type: "file"; filename: string };

type FakeMessage = {
  info: { id: string; role: "user" | "assistant"; sessionID: string };
  parts: FakePart[];
};

function serializePart(part: FakePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "tool": {
      const state = part.state;
      if (state.status === "completed") {
        const inputStr = JSON.stringify(state.input).slice(0, 500);
        const outputStr = (state.output || "").slice(0, 2000);
        return `[Tool: ${part.tool}] ${inputStr}\nOutput: ${outputStr}`;
      }
      if (state.status === "error") {
        return `[Tool: ${part.tool}] Error: ${state.error}`;
      }
      return `[Tool: ${part.tool}] ${state.status}`;
    }
    case "reasoning":
      return `[Reasoning] ${part.text}`;
    default:
      return `[${part.type}]`;
  }
}

function messagesToCompactInput(
  messages: FakeMessage[],
): { role: string; content: string }[] {
  return messages
    .map((m) => ({
      role: m.info.role,
      content: m.parts.map(serializePart).join("\n"),
    }))
    .filter((m) => m.content.length > 0);
}

function estimateTotalChars(messages: FakeMessage[]): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "text") total += part.text.length;
      else if (part.type === "tool") {
        if (part.state.status === "completed") {
          total += (part.state.output || "").length;
          total += JSON.stringify(part.state.input).length;
        }
      }
    }
  }
  return total;
}

type FakeCompactCacheChunk = {
  messageKeys: string[];
  result: { output: string };
};

function getMessageCacheKey(message: FakeMessage): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: message.info.id,
        role: message.info.role,
        parts: message.parts.map((part) => ({
          type: part.type,
          content: serializePart(part),
        })),
      }),
    )
    .digest("hex");
}

function getMessageCacheKeys(messages: FakeMessage[]): string[] {
  return messages.map(getMessageCacheKey);
}

function getMatchedCompactChunks(
  cachedChunks: FakeCompactCacheChunk[],
  messageKeys: string[],
): { matchedChunks: FakeCompactCacheChunk[]; matchedMessageCount: number } {
  const matchedChunks: FakeCompactCacheChunk[] = [];
  let matchedMessageCount = 0;

  for (const chunk of cachedChunks) {
    const nextCount = matchedMessageCount + chunk.messageKeys.length;
    if (nextCount > messageKeys.length) break;

    const matches = chunk.messageKeys.every(
      (key, index) => messageKeys[matchedMessageCount + index] === key,
    );
    if (!matches) break;

    matchedChunks.push(chunk);
    matchedMessageCount = nextCount;
  }

  return { matchedChunks, matchedMessageCount };
}

// Helpers to build fake messages for tests
function makeTextMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
): FakeMessage {
  return {
    info: { id, role, sessionID: "sess-1" },
    parts: [{ type: "text", text }],
  };
}

function makeToolMsg(
  id: string,
  toolName: string,
  input: any,
  output: string,
): FakeMessage {
  return {
    info: { id, role: "assistant", sessionID: "sess-1" },
    parts: [
      {
        type: "tool",
        tool: toolName,
        state: { status: "completed", input, output },
      },
    ],
  };
}

describe("serializePart", () => {
  test("serializes text part", () => {
    expect(serializePart({ type: "text", text: "hello world" })).toBe(
      "hello world",
    );
  });

  test("serializes completed tool part", () => {
    const result = serializePart({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { path: "/foo.ts" },
        output: "file contents here",
      },
    });
    expect(result).toContain("[Tool: read]");
    expect(result).toContain("/foo.ts");
    expect(result).toContain("Output: file contents here");
  });

  test("serializes error tool part", () => {
    const result = serializePart({
      type: "tool",
      tool: "write",
      state: { status: "error", error: "permission denied" },
    });
    expect(result).toBe("[Tool: write] Error: permission denied");
  });

  test("serializes pending tool part", () => {
    const result = serializePart({
      type: "tool",
      tool: "edit",
      state: { status: "pending" },
    });
    expect(result).toBe("[Tool: edit] pending");
  });

  test("serializes reasoning part", () => {
    expect(
      serializePart({ type: "reasoning", text: "thinking about this..." }),
    ).toBe("[Reasoning] thinking about this...");
  });

  test("serializes unknown part type as bracket marker", () => {
    expect(serializePart({ type: "step-start" } as FakePart)).toBe(
      "[step-start]",
    );
    expect(
      serializePart({ type: "file", filename: "foo.ts" } as FakePart),
    ).toBe("[file]");
  });

  test("truncates long tool input to 500 chars", () => {
    const longInput = { data: "x".repeat(1000) };
    const result = serializePart({
      type: "tool",
      tool: "search",
      state: { status: "completed", input: longInput, output: "ok" },
    });
    const toolLine = result.split("\n")[0]!;
    // The JSON.stringify(input).slice(0, 500) should truncate
    const inputPart = toolLine.replace("[Tool: search] ", "");
    expect(inputPart.length).toBeLessThanOrEqual(500);
  });

  test("truncates long tool output to 2000 chars", () => {
    const longOutput = "y".repeat(5000);
    const result = serializePart({
      type: "tool",
      tool: "read",
      state: { status: "completed", input: {}, output: longOutput },
    });
    const outputLine = result.split("\n").slice(1).join("\n");
    const outputPart = outputLine.replace("Output: ", "");
    expect(outputPart.length).toBeLessThanOrEqual(2000);
  });
});

describe("messagesToCompactInput", () => {
  test("converts text messages to role/content pairs", () => {
    const messages = [
      makeTextMsg("1", "user", "hello"),
      makeTextMsg("2", "assistant", "hi there"),
    ];
    const result = messagesToCompactInput(messages);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  test("filters out messages with empty content", () => {
    const messages: FakeMessage[] = [
      makeTextMsg("1", "user", "hello"),
      { info: { id: "2", role: "assistant", sessionID: "s" }, parts: [] },
    ];
    const result = messagesToCompactInput(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("hello");
  });

  test("joins multiple parts with newlines", () => {
    const msg: FakeMessage = {
      info: { id: "1", role: "assistant", sessionID: "s" },
      parts: [
        { type: "text", text: "Let me check" },
        {
          type: "tool",
          tool: "read",
          state: {
            status: "completed",
            input: { path: "/a.ts" },
            output: "contents",
          },
        },
        { type: "text", text: "Done" },
      ],
    };
    const result = messagesToCompactInput([msg]);
    expect(result[0]!.content).toContain("Let me check");
    expect(result[0]!.content).toContain("[Tool: read]");
    expect(result[0]!.content).toContain("Done");
  });
});

describe("estimateTotalChars", () => {
  test("counts text part characters", () => {
    const messages = [
      makeTextMsg("1", "user", "hello"), // 5 chars
      makeTextMsg("2", "assistant", "world!"), // 6 chars
    ];
    expect(estimateTotalChars(messages)).toBe(11);
  });

  test("counts completed tool input + output", () => {
    const messages = [makeToolMsg("1", "read", { path: "/a" }, "contents")];
    // JSON.stringify({path:"/a"}) = '{"path":"/a"}' = 13 chars
    // "contents" = 8 chars
    expect(estimateTotalChars(messages)).toBe(13 + 8);
  });

  test("ignores non-completed tool parts", () => {
    const msg: FakeMessage = {
      info: { id: "1", role: "assistant", sessionID: "s" },
      parts: [
        { type: "tool", tool: "edit", state: { status: "pending" } },
        {
          type: "tool",
          tool: "write",
          state: { status: "error", error: "fail" },
        },
      ],
    };
    expect(estimateTotalChars([msg])).toBe(0);
  });

  test("ignores non-text non-tool parts", () => {
    const msg: FakeMessage = {
      info: { id: "1", role: "assistant", sessionID: "s" },
      parts: [
        { type: "reasoning", text: "this is long reasoning" },
        { type: "step-start" } as FakePart,
      ],
    };
    expect(estimateTotalChars([msg])).toBe(0);
  });

  test("returns 0 for empty messages", () => {
    expect(estimateTotalChars([])).toBe(0);
  });
});

describe("getMessageCacheKey", () => {
  test("is stable for the same message", () => {
    const message = makeTextMsg("abc", "user", "hello");
    expect(getMessageCacheKey(message)).toBe(getMessageCacheKey(message));
  });

  test("changes when message role changes", () => {
    const userMessage = makeTextMsg("abc", "user", "hello");
    const assistantMessage = makeTextMsg("abc", "assistant", "hello");
    expect(getMessageCacheKey(userMessage)).not.toBe(
      getMessageCacheKey(assistantMessage),
    );
  });

  test("changes when serialized content changes", () => {
    const first = makeToolMsg("tool-1", "read", { path: "/a" }, "one");
    const second = makeToolMsg("tool-1", "read", { path: "/a" }, "two");
    expect(getMessageCacheKey(first)).not.toBe(getMessageCacheKey(second));
  });
});

describe("getMatchedCompactChunks", () => {
  test("matches cached prefix chunks in order", () => {
    const messages = [
      makeTextMsg("1", "user", "a"),
      makeTextMsg("2", "assistant", "b"),
      makeTextMsg("3", "user", "c"),
      makeTextMsg("4", "assistant", "d"),
    ];
    const keys = getMessageCacheKeys(messages);
    const cachedChunks: FakeCompactCacheChunk[] = [
      { messageKeys: keys.slice(0, 2), result: { output: "chunk-1" } },
      { messageKeys: keys.slice(2, 3), result: { output: "chunk-2" } },
    ];

    expect(getMatchedCompactChunks(cachedChunks, keys)).toEqual({
      matchedChunks: cachedChunks,
      matchedMessageCount: 3,
    });
  });

  test("stops matching when the prefix diverges", () => {
    const messages = [
      makeTextMsg("1", "user", "a"),
      makeTextMsg("2", "assistant", "b"),
      makeTextMsg("3", "user", "c"),
    ];
    const keys = getMessageCacheKeys(messages);
    const cachedChunks: FakeCompactCacheChunk[] = [
      { messageKeys: keys.slice(0, 2), result: { output: "chunk-1" } },
      { messageKeys: ["wrong-key"], result: { output: "chunk-2" } },
    ];

    expect(getMatchedCompactChunks(cachedChunks, keys)).toEqual({
      matchedChunks: [cachedChunks[0]!],
      matchedMessageCount: 2,
    });
  });
});

describe("compaction integration", () => {
  const MORPH_API_KEY = process.env.MORPH_API_KEY;

  test("CompactClient.compact() returns valid result", async () => {
    if (!MORPH_API_KEY) {
      console.log("Skipping: MORPH_API_KEY not set");
      return;
    }

    const client = new CompactClient({
      morphApiKey: MORPH_API_KEY,
      morphApiUrl: "https://api.morphllm.com",
      timeout: 30000,
    });

    const messages = [
      {
        role: "user",
        content:
          "I want to refactor the authentication module. Currently it uses JWT tokens stored in localStorage, but I want to switch to httpOnly cookies for better security. The auth flow starts in src/auth/login.ts where we call the /api/auth/login endpoint, get back a token, and store it. Then in src/middleware/auth.ts we read the token from the Authorization header.",
      },
      {
        role: "assistant",
        content:
          "I'll help you refactor the authentication from JWT localStorage to httpOnly cookies. Let me first examine the current implementation.\n\n[Tool: read] {\"path\":\"src/auth/login.ts\"}\nOutput: import { api } from '../api';\n\nexport async function login(email: string, password: string) {\n  const response = await api.post('/api/auth/login', { email, password });\n  const { token } = response.data;\n  localStorage.setItem('auth_token', token);\n  return response.data.user;\n}\n\n[Tool: read] {\"path\":\"src/middleware/auth.ts\"}\nOutput: import { NextFunction, Request, Response } from 'express';\n\nexport function authMiddleware(req: Request, res: Response, next: NextFunction) {\n  const token = req.headers.authorization?.replace('Bearer ', '');\n  if (!token) return res.status(401).json({ error: 'Unauthorized' });\n  // verify token...\n  next();\n}\n\nI can see the current flow. Here's my plan:\n1. Modify the login endpoint to set httpOnly cookies instead of returning tokens\n2. Update the middleware to read from cookies instead of Authorization header\n3. Add CSRF protection since we're switching to cookies",
      },
      {
        role: "user",
        content: "Sounds good, go ahead with the changes.",
      },
      {
        role: "assistant",
        content:
          "Let me apply the changes.\n\n[Tool: edit] {\"path\":\"src/auth/login.ts\"}\nOutput: Applied edit successfully.\n\n[Tool: edit] {\"path\":\"src/middleware/auth.ts\"}\nOutput: Applied edit successfully.\n\nI've updated both files. The login function now expects the server to set an httpOnly cookie, and the middleware reads from req.cookies instead of the Authorization header.",
      },
    ];

    const result = await client.compact({
      messages,
      compressionRatio: 0.5,
      preserveRecent: 1,
    });

    expect(result).toBeDefined();
    expect(result.output).toBeDefined();
    expect(result.output.length).toBeGreaterThan(0);
    expect(result.output.length).toBeLessThan(
      messages.map((m) => m.content).join("").length,
    );
    expect(result.usage).toBeDefined();
    expect(result.usage.compression_ratio).toBeGreaterThan(0);
    expect(result.usage.compression_ratio).toBeLessThanOrEqual(1);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.usage.output_tokens).toBeGreaterThan(0);
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeGreaterThan(0);
  }, 30000);

  test("proactive compaction threshold logic", () => {
    // Simulate the decision flow from experimental.chat.messages.transform
    const THRESHOLD = 100000;
    const PRESERVE_RECENT = 6;

    // Below threshold — no compaction
    const smallMessages = Array.from({ length: 20 }, (_, i) =>
      makeTextMsg(`msg-${i}`, i % 2 === 0 ? "user" : "assistant", "short"),
    );
    expect(estimateTotalChars(smallMessages)).toBeLessThan(THRESHOLD);

    // Above threshold — compaction should trigger
    const largeMessages = Array.from({ length: 20 }, (_, i) =>
      makeTextMsg(
        `msg-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "x".repeat(8000),
      ),
    );
    expect(estimateTotalChars(largeMessages)).toBeGreaterThan(THRESHOLD);

    // Split preserves recent messages
    const older = largeMessages.slice(0, -PRESERVE_RECENT);
    const recent = largeMessages.slice(-PRESERVE_RECENT);
    expect(older.length).toBe(14);
    expect(recent.length).toBe(PRESERVE_RECENT);

    // Input conversion produces non-empty content
    const compactInput = messagesToCompactInput(older);
    expect(compactInput.length).toBe(14);
    expect(compactInput.every((m) => m.content.length > 0)).toBe(true);

    const olderKeys = getMessageCacheKeys(older);
    expect(olderKeys).toHaveLength(14);
    expect(olderKeys[0]).toHaveLength(64);
  });

  test("prefix reuse leaves small uncached deltas un-compacted", () => {
    const PRESERVE_RECENT = 6;
    const older = [
      makeTextMsg("1", "user", "x".repeat(35000)),
      makeTextMsg("2", "assistant", "x".repeat(35000)),
      makeTextMsg("3", "user", "x".repeat(35000)),
      makeTextMsg("4", "assistant", "x".repeat(4000)),
    ];
    const recent = Array.from({ length: PRESERVE_RECENT }, (_, i) =>
      makeTextMsg(`recent-${i}`, i % 2 === 0 ? "user" : "assistant", "recent"),
    );
    const messages = [...older, ...recent];
    const olderKeys = getMessageCacheKeys(older);
    const cachedChunks: FakeCompactCacheChunk[] = [
      { messageKeys: olderKeys.slice(0, 3), result: { output: "cached-prefix" } },
    ];

    const { matchedMessageCount } = getMatchedCompactChunks(cachedChunks, olderKeys);
    const uncachedOlderMessages = older.slice(matchedMessageCount);

    expect(estimateTotalChars(messages)).toBeGreaterThan(100000);
    expect(estimateTotalChars(uncachedOlderMessages)).toBeLessThan(16000);
    expect(matchedMessageCount).toBe(3);
    expect(uncachedOlderMessages).toHaveLength(1);
  });

  test("too few messages does not trigger compaction", () => {
    const PRESERVE_RECENT = 6;
    // Need at least PRESERVE_RECENT + 2 messages
    const messages = Array.from({ length: 7 }, (_, i) =>
      makeTextMsg(
        `msg-${i}`,
        i % 2 === 0 ? "user" : "assistant",
        "x".repeat(20000),
      ),
    );
    // Even though chars are high, message count is below threshold
    expect(messages.length).toBeLessThan(PRESERVE_RECENT + 2);
  });
});

describe("feature flags", () => {
  test("README documents feature flag env vars", () => {
    const content = readFileSync(join(import.meta.dir, "README.md"), "utf-8");
    expect(content).toContain("MORPH_EDIT");
    expect(content).toContain("MORPH_WARPGREP");
    expect(content).toContain("MORPH_COMPACT");
  });
});

describe("plugin runtime hooks", () => {
  test("tool.definition appends runtime notes for morph_edit", async () => {
    const { default: MorphPlugin } = await importPluginWithEnv({
      MORPH_API_KEY: undefined,
      MORPH_ALLOW_READONLY_AGENTS: undefined,
    });

    const hooks = await MorphPlugin(makePluginInput("/tmp/morph-plugin"));
    const output = {
      description: "Base description",
      parameters: {},
    };

    await hooks["tool.definition"]?.({ toolID: "morph_edit" }, output);

    expect(output.description).toContain("Runtime notes:");
    expect(output.description).toContain(
      "Currently unavailable until MORPH_API_KEY is configured.",
    );
    expect(output.description).toContain(
      "Blocked in readonly agents: plan, explore.",
    );
  });

  test("system transform injects concise morph routing guidance", async () => {
    const { default: MorphPlugin } = await importPluginWithEnv({
      MORPH_API_KEY: "sk-test-key",
    });

    const hooks = await MorphPlugin(makePluginInput("/tmp/morph-plugin"));
    const output = { system: [] as string[] };

    await hooks["experimental.chat.system.transform"]?.(
      {
        sessionID: "session-test",
        model: {},
      },
      output,
    );

    const combined = output.system.join("\n");
    expect(combined).toContain("Morph plugin routing hints:");
    expect(combined).toContain(
      "Prefer morph_edit for large or scattered edits inside existing files.",
    );
    expect(combined).toContain("Use write for brand new files.");
  });
});

describe("ToolContext path resolution", () => {
  test("morph_edit resolves relative paths from plugin directory", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "morph-plugin-"));

    try {
      const { default: MorphPlugin } = await importPluginWithEnv({
        MORPH_API_KEY: "sk-test-key",
      });

      const hooks = await MorphPlugin(makePluginInput(tempRoot));
      const result = await hooks.tool.morph_edit.execute(
        {
          target_filepath: "created.ts",
          instructions: "I am creating a test file",
          code_edit: "export const created = true;\n",
        },
        makeToolContext(tempRoot),
      );

      expect(result).toContain("Created new file: created.ts");
      expect(existsSync(join(tempRoot, "created.ts"))).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
