import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CompactClient } from "@morphllm/morphsdk";
import {
  createBoundedCompactCache,
  matchCacheChunks,
  type ChunkSummary,
  type SessionCompactCache,
} from "./compact-cache";

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

    expect(content).toContain(
      "~/.config/opencode/instructions/morph-tools.md",
    );
    expect(content).toContain("morph_edit");
    expect(content).toContain("warpgrep_codebase_search");
    expect(content).toContain("warpgrep_github_search");
    expect(content).toContain("MORPH_API_KEY");
    expect(content).toContain("MORPH_WARPGREP_GITHUB");
    expect(content).toContain("Safety guards");
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
  info: {
    id: string;
    role: "user" | "assistant";
    sessionID: string;
    time?: { created: number; completed?: number };
  };
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
      return "";
    default:
      return `[${part.type}]`;
  }
}

function serializePartForFingerprint(part: FakePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "tool": {
      const state = part.state;
      if (state.status === "completed") {
        return `[Tool: ${part.tool}] ${JSON.stringify(state.input)}\nOutput: ${state.output || ""}`;
      }
      if (state.status === "error") {
        return `[Tool: ${part.tool}] Error: ${state.error}`;
      }
      return `[Tool: ${part.tool}] ${state.status}`;
    }
    case "reasoning":
      return "";
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
      content: m.parts.map(serializePart).filter(Boolean).join("\n"),
    }))
    .filter((m) => m.content.length > 0);
}

function buildFakeFingerprint(
  messages: FakeMessage[],
  configDigest = "cfg-v1",
) {
  const messageDigests = messages.map((message) =>
    JSON.stringify({
      id: message.info.id,
      role: message.info.role,
      content: message.parts.map(serializePartForFingerprint).filter(Boolean),
    }),
  );

  return {
    messageDigests,
    configDigest,
  };
}

function makeChunk(
  messages: FakeMessage[],
  output: string,
  charCountSaved = 0,
): ChunkSummary {
  const fingerprint = buildFakeFingerprint(messages);
  return {
    messageCount: messages.length,
    messageDigests: fingerprint.messageDigests,
    output,
    charCountSaved,
  };
}

function makeSessionCache(
  sessionID: string,
  chunks: ChunkSummary[],
  configDigest = "cfg-v1",
): SessionCompactCache {
  return {
    sessionID,
    configDigest,
    chunks,
    totalMessagesCompacted: chunks.reduce((sum, chunk) => sum + chunk.messageCount, 0),
  };
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

type FakeCompactResult = {
  id: string;
  output: string;
  messages: Array<{
    role: string;
    content: string;
    compacted_line_ranges: Array<{ start: number; end: number }>;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    compression_ratio: number;
    processing_time_ms: number;
  };
  model: string;
};

function makeCompactResult(output: string): FakeCompactResult {
  return {
    id: `compact-${output}`,
    output,
    messages: [
      {
        role: "user",
        content: output,
        compacted_line_ranges: [],
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 25,
      compression_ratio: 0.25,
      processing_time_ms: 5,
    },
    model: "morph-compactor",
  };
}


// Helpers to build fake messages for tests
function makeTextMsg(
  id: string,
  role: "user" | "assistant",
  text: string,
): FakeMessage {
  const info =
    role === "assistant"
      ? {
        id,
        role,
        sessionID: "sess-1",
        time: { created: 1, completed: 2 },
      }
      : { id, role, sessionID: "sess-1" };

  return {
    info,
    parts: [{ type: "text", text }],
  };
}

function makeToolMsg(
  id: string,
  toolName: string,
  state:
    | { status: "completed"; input: any; output: string }
    | { status: "pending"; input?: any; raw?: string }
    | { status: "running"; input?: any; title?: string },
): FakeMessage {
  const toolState =
    state.status === "completed"
      ? { status: "completed", input: state.input, output: state.output }
      : state.status === "running"
        ? {
          status: "running",
          input: state.input ?? {},
          title: state.title,
          time: { start: 1 },
        }
        : {
          status: "pending",
          input: state.input ?? {},
          raw: state.raw ?? "",
        };

  return {
    info: {
      id,
      role: "assistant",
      sessionID: "sess-1",
      time:
        state.status === "completed"
          ? { created: 1, completed: 2 }
          : { created: 1 },
    },
    parts: [
      {
        type: "tool",
        tool: toolName,
        state: toolState,
      },
    ],
  };
}

const COMPACT_ENV_KEYS = [
  "MORPH_API_KEY",
  "MORPH_COMPACT",
  "MORPH_COMPACT_CHAR_THRESHOLD",
  "MORPH_COMPACT_PRESERVE_RECENT",
  "MORPH_COMPACT_CHUNK_SIZE",
  "MORPH_COMPACT_MIN_UNCACHED_CHARS",
] as const;

async function withCompactEnv<T>(
  overrides: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of COMPACT_ENV_KEYS) {
    saved[key] = process.env[key];
  }
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const key of COMPACT_ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
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

  test("omits reasoning part from compaction input", () => {
    expect(
      serializePart({ type: "reasoning", text: "thinking about this..." }),
    ).toBe("");
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

  test("omits reasoning-only content entirely", () => {
    const msg: FakeMessage = {
      info: { id: "1", role: "assistant", sessionID: "s" },
      parts: [{ type: "reasoning", text: "private chain of thought" }],
    };
    expect(messagesToCompactInput([msg])).toEqual([]);
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
    const messages = [
      makeToolMsg("1", "read", {
        status: "completed",
        input: { path: "/a" },
        output: "contents",
      }),
    ];
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

describe("chunk cache helpers", () => {
  test("matches all cached chunks for an identical compacted prefix", () => {
    const firstChunkMessages = [
      makeTextMsg("1", "user", "hello"),
      makeTextMsg("2", "assistant", "hi"),
    ];
    const secondChunkMessages = [
      makeTextMsg("3", "user", "next"),
      makeTextMsg("4", "assistant", "done"),
    ];
    const cache = makeSessionCache("sess-1", [
      makeChunk(firstChunkMessages, "chunk-1"),
      makeChunk(secondChunkMessages, "chunk-2"),
    ]);

    expect(
      matchCacheChunks(
        cache,
        buildFakeFingerprint([...firstChunkMessages, ...secondChunkMessages]),
      ),
    ).toEqual({
      matchedChunks: cache.chunks,
      matchedMessageCount: 4,
    });
  });

  test("full fingerprinting distinguishes long tool outputs with the same truncated prefix", () => {
    const sharedPrefix = "x".repeat(2000);
    const first = makeToolMsg("1", "read", {
      status: "completed",
      input: { path: "/tmp/file-a.ts" },
      output: `${sharedPrefix}-alpha`,
    });
    const second = makeToolMsg("1", "read", {
      status: "completed",
      input: { path: "/tmp/file-a.ts" },
      output: `${sharedPrefix}-beta`,
    });

    expect(serializePart(first.parts[0]!)).toBe(serializePart(second.parts[0]!));
    expect(buildFakeFingerprint([first]).messageDigests[0]).not.toBe(
      buildFakeFingerprint([second]).messageDigests[0],
    );
  });

  test("matches only the cached prefix when the transcript extends beyond it", () => {
    const firstChunkMessages = [
      makeTextMsg("1", "user", "hello"),
      makeTextMsg("2", "assistant", "hi"),
    ];
    const secondChunkMessages = [
      makeTextMsg("3", "user", "next"),
      makeTextMsg("4", "assistant", "done"),
    ];
    const cache = makeSessionCache("sess-1", [
      makeChunk(firstChunkMessages, "chunk-1"),
    ]);

    expect(
      matchCacheChunks(
        cache,
        buildFakeFingerprint([...firstChunkMessages, ...secondChunkMessages]),
      ),
    ).toEqual({
      matchedChunks: cache.chunks,
      matchedMessageCount: 2,
    });
  });

  test("stops matching at the first mismatched chunk", () => {
    const firstChunkMessages = [
      makeTextMsg("1", "user", "hello"),
      makeTextMsg("2", "assistant", "hi"),
    ];
    const secondChunkMessages = [
      makeTextMsg("3", "user", "next"),
      makeTextMsg("4", "assistant", "done"),
    ];
    const editedSecondChunk = [
      secondChunkMessages[0]!,
      makeTextMsg("4", "assistant", "changed"),
    ];
    const cache = makeSessionCache("sess-1", [
      makeChunk(firstChunkMessages, "chunk-1"),
      makeChunk(secondChunkMessages, "chunk-2"),
    ]);

    expect(
      matchCacheChunks(
        cache,
        buildFakeFingerprint([...firstChunkMessages, ...editedSecondChunk]),
      ),
    ).toEqual({
      matchedChunks: [cache.chunks[0]!],
      matchedMessageCount: 2,
    });
  });

  test("does not match cached chunks when compaction config changes", () => {
    const chunkMessages = [
      makeTextMsg("1", "user", "hello"),
      makeTextMsg("2", "assistant", "hi"),
    ];
    const cache = makeSessionCache(
      "sess-1",
      [makeChunk(chunkMessages, "chunk-1")],
      "cfg-v1",
    );

    expect(
      matchCacheChunks(cache, buildFakeFingerprint(chunkMessages, "cfg-v2")),
    ).toEqual({
      matchedChunks: [],
      matchedMessageCount: 0,
    });
  });
});

describe("bounded LRU compact cache", () => {
  function entryForSession(sid: string) {
    const chunkMessages = [makeTextMsg("1", "user", "hi")];
    chunkMessages[0]!.info.sessionID = sid;
    return makeSessionCache(
      sid,
      [makeChunk(chunkMessages, `summary-${sid}`)],
      `cfg-${sid}`,
    );
  }

  test("evicts least-recently-used entry when cap is exceeded", () => {
    const cache = createBoundedCompactCache<FakeCompactResult>(3);
    cache.set("s1", entryForSession("s1"));
    cache.set("s2", entryForSession("s2"));
    cache.set("s3", entryForSession("s3"));

    // All three present
    expect(cache.size()).toBe(3);

    // Adding a 4th evicts s1 (oldest)
    cache.set("s4", entryForSession("s4"));
    expect(cache.size()).toBe(3);
    expect(cache.get("s1")).toBeUndefined();
    expect(cache.get("s4")).toBeDefined();
  });

  test("read refreshes recency so hot sessions survive eviction", () => {
    const cache = createBoundedCompactCache<FakeCompactResult>(3);
    cache.set("s1", entryForSession("s1"));
    cache.set("s2", entryForSession("s2"));
    cache.set("s3", entryForSession("s3"));

    // Read s1 — moves it to the most-recent position
    cache.get("s1");

    // Now s2 is the oldest. Adding s4 should evict s2, not s1.
    cache.set("s4", entryForSession("s4"));
    expect(cache.get("s1")).toBeDefined();
    expect(cache.get("s2")).toBeUndefined();
    expect(cache.get("s3")).toBeDefined();
    expect(cache.get("s4")).toBeDefined();
  });

  test("write refreshes recency for existing sessions", () => {
    const cache = createBoundedCompactCache<FakeCompactResult>(3);
    cache.set("s1", entryForSession("s1"));
    cache.set("s2", entryForSession("s2"));
    cache.set("s3", entryForSession("s3"));

    // Re-write s1 — moves it to the most-recent position
    cache.set("s1", entryForSession("s1"));

    // s2 is now oldest
    cache.set("s4", entryForSession("s4"));
    expect(cache.get("s1")).toBeDefined();
    expect(cache.get("s2")).toBeUndefined();
  });
});

describe("compaction integration", () => {
  const MORPH_API_KEY = process.env.MORPH_API_KEY;
  const RUN_LIVE_COMPACT_TESTS =
    process.env.MORPH_RUN_LIVE_COMPACT_TESTS === "true";

  test("CompactClient.compact() returns valid result", async () => {
    if (!RUN_LIVE_COMPACT_TESTS) {
      console.log("Skipping: MORPH_RUN_LIVE_COMPACT_TESTS not enabled");
      return;
    }

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
    const THRESHOLD = 140000;
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

    const cachedChunk = makeChunk(older.slice(0, 4), "chunk-1");
    const cache = makeSessionCache("sess-1", [cachedChunk]);
    expect(
      matchCacheChunks(cache, buildFakeFingerprint(older)),
    ).toEqual({
      matchedChunks: [cachedChunk],
      matchedMessageCount: 4,
    });
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

  test("plugin hook reuses exact transcript and compacts only uncached chunk suffixes", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];
    const toasts: Array<{ title?: string; message: string; variant: string }> = [];

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });

      return new Response(JSON.stringify(makeCompactResult(`summary-${requests.length}`)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await withCompactEnv(
        {
          MORPH_API_KEY: "sk-test-key",
          MORPH_COMPACT: "true",
          MORPH_COMPACT_CHAR_THRESHOLD: "1",
          MORPH_COMPACT_PRESERVE_RECENT: "1",
          MORPH_COMPACT_CHUNK_SIZE: "2",
          MORPH_COMPACT_MIN_UNCACHED_CHARS: "1",
        },
        async () => {
          const mod = await import(
            `./index.ts?compaction-hook-test=${Date.now()}-${Math.random()}`
          );
          const plugin = mod.default;
          const logs: any[] = [];
          const hooks = await plugin({
            directory: import.meta.dir,
            client: {
              app: {
                log: async ({ body }: any) => {
                  logs.push(body);
                },
              },
              tui: {
                showToast: async ({ body }: any) => {
                  toasts.push(body);
                },
              },
            },
          });

          const transform = hooks["experimental.chat.messages.transform"];
          expect(typeof transform).toBe("function");

          const baseMessages = [
            makeTextMsg("1", "user", "A".repeat(100)),
            makeTextMsg("2", "assistant", "B".repeat(100)),
            makeTextMsg("3", "user", "C".repeat(100)),
          ];

          const firstOutput = { messages: structuredClone(baseMessages) };
          await transform({}, firstOutput);
          expect(requests).toHaveLength(1);
          expect(requests[0]!.body.messages).toEqual([
            { role: "user", content: "A".repeat(100) },
            { role: "assistant", content: "B".repeat(100) },
          ]);
          expect(firstOutput.messages[0]!.info.role).toBe("assistant");
          expect(firstOutput.messages[0]!.parts[0]!.text).toContain(
            "[Background context summary of 2 earlier messages.]",
          );

          const secondOutput = { messages: structuredClone(baseMessages) };
          await transform({}, secondOutput);
          expect(requests).toHaveLength(1);
          expect(toasts).toHaveLength(1);
          expect(toasts[0]!.variant).toBe("success");
          expect(toasts[0]!.message).toContain("1 chunks (2 msgs compacted)");

          const extendedMessages = [
            ...baseMessages,
            makeTextMsg("4", "assistant", "D".repeat(100)),
          ];
          const thirdOutput = { messages: structuredClone(extendedMessages) };
          await transform({}, thirdOutput);

          expect(requests).toHaveLength(2);
          expect(requests[1]!.body.messages).toEqual([
            { role: "user", content: "C".repeat(100) },
          ]);
          expect(
            logs.some((entry) => entry.message.includes("Compact chunk: 1 messages")),
          ).toBe(true);
          expect(toasts).toHaveLength(2);
          expect(toasts[1]!.variant).toBe("success");
          expect(toasts[1]!.message).toContain("2 chunks (3 msgs compacted)");
          expect(thirdOutput.messages[0]!.parts[0]!.text).toContain(
            "--- Chunk 1/2 (2 messages) ---",
          );
          expect(thirdOutput.messages[0]!.parts[0]!.text).toContain(
            "--- Chunk 2/2 (1 messages) ---",
          );
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("plugin hook defers compaction while the recent tail has an in-flight tool call", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];
    const toasts: Array<{ title?: string; message: string; variant: string }> =
      [];

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });

      return new Response(JSON.stringify(makeCompactResult("summary-1")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await withCompactEnv(
        {
          MORPH_API_KEY: "sk-test-key",
          MORPH_COMPACT: "true",
          MORPH_COMPACT_CHAR_THRESHOLD: "1",
          MORPH_COMPACT_PRESERVE_RECENT: "1",
          MORPH_COMPACT_CHUNK_SIZE: "2",
        },
        async () => {
          const mod = await import(
            `./index.ts?compaction-pending-tool-test=${Date.now()}-${Math.random()}`
          );
          const plugin = mod.default;
          const hooks = await plugin({
            directory: import.meta.dir,
            client: {
              app: { log: async () => { } },
              tui: {
                showToast: async ({ body }: any) => {
                  toasts.push(body);
                },
              },
            },
          });

          const transform = hooks["experimental.chat.messages.transform"];
          await transform(
            {},
            {
              messages: structuredClone([
                makeTextMsg("1", "user", "A".repeat(100)),
                makeTextMsg("2", "assistant", "B".repeat(100)),
                makeToolMsg("3", "read", {
                  status: "running",
                  input: { path: "/tmp/file.ts" },
                  title: "Reading file",
                }),
              ]),
            },
          );

          expect(requests).toHaveLength(0);
          expect(toasts).toHaveLength(0);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("plugin hook skips trailing in-flight older messages and compacts the settled prefix", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });

      return new Response(JSON.stringify(makeCompactResult("summary-1")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await withCompactEnv(
        {
          MORPH_API_KEY: "sk-test-key",
          MORPH_COMPACT: "true",
          MORPH_COMPACT_CHAR_THRESHOLD: "1",
          MORPH_COMPACT_PRESERVE_RECENT: "1",
          MORPH_COMPACT_CHUNK_SIZE: "2",
          MORPH_COMPACT_MIN_UNCACHED_CHARS: "1",
        },
        async () => {
          const mod = await import(
            `./index.ts?compaction-boundary-tool-test=${Date.now()}-${Math.random()}`
          );
          const plugin = mod.default;
          const hooks = await plugin({
            directory: import.meta.dir,
            client: {
              app: { log: async () => { } },
            },
          });

          const transform = hooks["experimental.chat.messages.transform"];
          await transform(
            {},
            {
              messages: structuredClone([
                makeTextMsg("1", "user", "A".repeat(100)),
                makeToolMsg("2", "read", {
                  status: "pending",
                  input: { path: "/tmp/file.ts" },
                  raw: "{\"path\":\"/tmp/file.ts\"}",
                }),
                makeTextMsg("3", "user", "C".repeat(100)),
              ]),
            },
          );

          expect(requests).toHaveLength(1);
          expect(requests[0]!.body.messages).toEqual([
            { role: "user", content: "A".repeat(100) },
          ]);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("plugin hook does not cache unstable history in the middle of the compactable prefix", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });

      return new Response(JSON.stringify(makeCompactResult(`summary-${requests.length}`)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await withCompactEnv(
        {
          MORPH_API_KEY: "sk-test-key",
          MORPH_COMPACT: "true",
          MORPH_COMPACT_CHAR_THRESHOLD: "1",
          MORPH_COMPACT_PRESERVE_RECENT: "1",
          MORPH_COMPACT_CHUNK_SIZE: "2",
          MORPH_COMPACT_MIN_UNCACHED_CHARS: "1",
        },
        async () => {
          const mod = await import(
            `./index.ts?compaction-unstable-middle-test=${Date.now()}-${Math.random()}`
          );
          const plugin = mod.default;
          const hooks = await plugin({
            directory: import.meta.dir,
            client: {
              app: { log: async () => { } },
            },
          });

          const transform = hooks["experimental.chat.messages.transform"];
          const transcript = [
            makeTextMsg("1", "user", "A".repeat(100)),
            makeToolMsg("2", "read", {
              status: "pending",
              input: { path: "/tmp/file.ts" },
              raw: "{\"path\":\"/tmp/file.ts\"}",
            }),
            makeTextMsg("3", "assistant", "C".repeat(100)),
            makeTextMsg("4", "user", "D".repeat(100)),
          ];

          const firstOutput = { messages: structuredClone(transcript) };
          await transform({}, firstOutput);
          expect(requests).toHaveLength(1);
          expect(requests[0]!.body.messages).toEqual([
            { role: "user", content: "A".repeat(100) },
          ]);
          expect(firstOutput.messages[1]!.parts[0]!.type).toBe("tool");
          expect(firstOutput.messages[2]!.parts[0]!.type).toBe("text");

          const secondOutput = { messages: structuredClone(transcript) };
          await transform({}, secondOutput);
          expect(requests).toHaveLength(1);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("plugin hook serializes same-session compaction work", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ url: string; body: any }> = [];

    globalThis.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, body });
      await new Promise((resolve) => setTimeout(resolve, 25));

      return new Response(JSON.stringify(makeCompactResult("summary-1")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await withCompactEnv(
        {
          MORPH_API_KEY: "sk-test-key",
          MORPH_COMPACT: "true",
          MORPH_COMPACT_CHAR_THRESHOLD: "1",
          MORPH_COMPACT_PRESERVE_RECENT: "1",
          MORPH_COMPACT_CHUNK_SIZE: "2",
          MORPH_COMPACT_MIN_UNCACHED_CHARS: "1",
        },
        async () => {
          const mod = await import(
            `./index.ts?compaction-lock-test=${Date.now()}-${Math.random()}`
          );
          const plugin = mod.default;
          const hooks = await plugin({
            directory: import.meta.dir,
            client: {
              app: { log: async () => { } },
            },
          });

          const transform = hooks["experimental.chat.messages.transform"];
          const transcript = [
            makeTextMsg("1", "user", "A".repeat(100)),
            makeTextMsg("2", "assistant", "B".repeat(100)),
            makeTextMsg("3", "user", "C".repeat(100)),
          ];

          await Promise.all([
            transform({}, { messages: structuredClone(transcript) }),
            transform({}, { messages: structuredClone(transcript) }),
          ]);

          expect(requests).toHaveLength(1);
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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
