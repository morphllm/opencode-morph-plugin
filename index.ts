/**
 * OpenCode Morph Plugin v2
 *
 * Integrates Morph SDK for fast apply, WarpGrep codebase search, and shell env.
 * Uses MorphClient for shared config (API key, timeout, retries) across all tools.
 *
 * @see https://docs.morphllm.com/quickstart
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { MorphClient, WarpGrepClient, CompactClient } from "@morphllm/morphsdk";
import type { WarpGrepResult, CompactResult } from "@morphllm/morphsdk";
import type { Part, TextPart, ToolPart, Message } from "@opencode-ai/sdk";

// Config from environment — only MORPH_API_KEY is required
const MORPH_API_KEY = process.env.MORPH_API_KEY;
const MORPH_API_URL = "https://api.morphllm.com";
const MORPH_TIMEOUT = 30000;
const MORPH_WARP_GREP_TIMEOUT = 60000;
const MORPH_COMPACT_TIMEOUT = 120000;

// Compaction config — threshold and ratio are user-tunable
const COMPACT_CHAR_THRESHOLD = parseInt(
  process.env.MORPH_COMPACT_CHAR_THRESHOLD || "140000",
  10,
);
const COMPACT_PRESERVE_RECENT = 6;
const COMPACT_RATIO = parseFloat(
  process.env.MORPH_COMPACT_RATIO || "0.3",
);

/**
 * Feature flags — users can disable specific capabilities.
 * All default to true (enabled). Set to "false" to disable.
 */
const MORPH_EDIT_ENABLED = process.env.MORPH_EDIT !== "false";
const MORPH_WARPGREP_ENABLED = process.env.MORPH_WARPGREP !== "false";
const MORPH_COMPACT_ENABLED = process.env.MORPH_COMPACT !== "false";

/**
 * Agents that are blocked from using morph_edit by default.
 * Users can override by setting MORPH_ALLOW_READONLY_AGENTS=true
 */
const READONLY_AGENTS = ["plan", "explore"];
const ALLOW_READONLY_AGENTS =
  process.env.MORPH_ALLOW_READONLY_AGENTS === "true";

/** Plugin version */
const PLUGIN_VERSION = "2.0.0";

/** Canonical marker string used for lazy edit placeholders */
const EXISTING_CODE_MARKER = "// ... existing code ...";

/**
 * Shared MorphClient — FastApply uses morph.fastApply.applyEdit()
 * with MORPH_API_URL passed as per-call override.
 */
const morph = new MorphClient({
  apiKey: MORPH_API_KEY,
  timeout: MORPH_TIMEOUT,
});

/**
 * Separate WarpGrep client with its own timeout (typically longer than fast apply).
 */
const warpGrep = new WarpGrepClient({
  morphApiKey: MORPH_API_KEY,
  morphApiUrl: MORPH_API_URL,
  timeout: MORPH_WARP_GREP_TIMEOUT,
});

/**
 * Separate CompactClient for proactive context compaction.
 */
const compactClient = new CompactClient({
  morphApiKey: MORPH_API_KEY,
  morphApiUrl: MORPH_API_URL,
  timeout: MORPH_COMPACT_TIMEOUT,
});

/**
 * Cache for proactive compaction results.
 * Keyed by a hash of the message IDs that were compacted,
 * so we don't re-compact the same messages on every LLM call.
 */
let compactCache: {
  messageIdHash: string;
  result: CompactResult;
} | null = null;

/**
 * Normalize code_edit input from LLM tool calls.
 *
 * Agents frequently wrap tool arguments in markdown fences (```lang ... ```).
 * When this is nested inside Morph's <update> XML tag, it confuses the merge
 * model. This function strips a single outer fence pair using line-based parsing.
 */
function normalizeCodeEditInput(codeEdit: string): string {
  const trimmed = codeEdit.trim();
  const lines = trimmed.split("\n");

  if (lines.length < 3) return codeEdit;

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];

  if (/^```[\w-]*$/.test(firstLine) && /^```$/.test(lastLine)) {
    return lines.slice(1, -1).join("\n");
  }

  return codeEdit;
}

/**
 * Serialize a Part into a text representation for compaction input.
 * Tool outputs, text, and reasoning are included. Other part types are
 * represented as brief markers to preserve structure without bulk.
 */
function serializePart(part: Part): string {
  switch (part.type) {
    case "text":
      return (part as TextPart).text;
    case "tool": {
      const tp = part as ToolPart;
      const state = tp.state;
      if (state.status === "completed") {
        const inputStr = JSON.stringify(state.input).slice(0, 500);
        const outputStr = (state.output || "").slice(0, 2000);
        return `[Tool: ${tp.tool}] ${inputStr}\nOutput: ${outputStr}`;
      }
      if (state.status === "error") {
        return `[Tool: ${tp.tool}] Error: ${state.error}`;
      }
      return `[Tool: ${tp.tool}] ${state.status}`;
    }
    case "reasoning":
      return `[Reasoning] ${(part as { text: string }).text}`;
    default:
      return `[${part.type}]`;
  }
}

/**
 * Convert OpenCode messages to the format Morph compact expects.
 */
function messagesToCompactInput(
  messages: { info: Message; parts: Part[] }[],
): { role: string; content: string }[] {
  return messages
    .map((m) => ({
      role: m.info.role,
      content: m.parts.map(serializePart).join("\n"),
    }))
    .filter((m) => m.content.length > 0);
}

/**
 * Estimate total character count across all message parts.
 */
function estimateTotalChars(
  messages: { info: Message; parts: Part[] }[],
): number {
  let total = 0;
  for (const m of messages) {
    for (const part of m.parts) {
      if (part.type === "text") total += (part as TextPart).text.length;
      else if (part.type === "tool") {
        const tp = part as ToolPart;
        if (tp.state.status === "completed") {
          total += (tp.state.output || "").length;
          total += JSON.stringify(tp.state.input).length;
        }
      }
    }
  }
  return total;
}

/**
 * Simple hash of message IDs for cache keying.
 */
function hashMessageIds(messages: { info: Message }[]): string {
  return messages.map((m) => m.info.id).join("|");
}

/**
 * Format WarpGrep results for tool output
 */
function formatWarpGrepResult(result: WarpGrepResult): string {
  if (!result.success) {
    return `Search failed: ${result.error}`;
  }

  if (!result.contexts || result.contexts.length === 0) {
    return "No relevant code found. Try rephrasing your search term.";
  }

  const parts: string[] = [];
  parts.push("Relevant context found:");

  for (const ctx of result.contexts) {
    const rangeStr =
      !ctx.lines || ctx.lines === "*"
        ? "*"
        : ctx.lines.map(([s, e]) => `${s}-${e}`).join(",");
    parts.push(`- ${ctx.file}:${rangeStr}`);
  }

  parts.push("\nFile contents:\n");

  for (const ctx of result.contexts) {
    const rangeStr =
      !ctx.lines || ctx.lines === "*"
        ? ""
        : ` lines="${ctx.lines.map(([s, e]) => `${s}-${e}`).join(",")}"`;
    parts.push(`<file path="${ctx.file}"${rangeStr}>`);
    parts.push(ctx.content);
    parts.push("</file>\n");
  }

  return parts.join("\n");
}

const MorphPlugin: Plugin = async ({ directory, client }) => {
  const log = async (
    level: "debug" | "info" | "warn" | "error",
    message: string,
  ) => {
    try {
      await client.app.log({
        body: {
          service: "morph",
          level,
          message,
        },
      });
    } catch {
      process.stderr.write(`[morph] ${message}\n`);
    }
  };

  if (!MORPH_API_KEY) {
    await log(
      "warn",
      "MORPH_API_KEY not set - morph tools will be disabled",
    );
  } else {
    const features = [
      MORPH_EDIT_ENABLED && "edit",
      MORPH_WARPGREP_ENABLED && "warpgrep",
      MORPH_COMPACT_ENABLED && "compact",
    ].filter(Boolean);
    await log("info", `Plugin v${PLUGIN_VERSION} loaded [${features.join(", ")}]`);
  }

  // Build tool map conditionally based on feature flags
  const tools: Record<string, ReturnType<typeof tool>> = {};

  if (MORPH_EDIT_ENABLED) {
    tools.morph_edit = tool({
        description: `Edit existing files using partial code snippets with "// ... existing code ..." markers. Morph's AI merges your changes into the full file.

WHEN TO USE morph_edit vs edit:
- morph_edit: large files (300+ lines), multiple scattered changes, complex refactoring, whitespace-sensitive edits
- native edit: small exact string replacements, simple renames, single-line fixes (faster, no API call)
- native write: creating new files from scratch

FORMAT — use "// ... existing code ..." to represent unchanged sections:
// ... existing code ...
FIRST_EDIT
// ... existing code ...
SECOND_EDIT
// ... existing code ...

CRITICAL RULES:
- ALWAYS wrap changes with markers at start AND end (omitting markers DELETES surrounding code)
- Include 1-2 unique context lines around each edit to anchor the location precisely
- Write a specific 'instructions' param: "I am adding X to function Y" not "update code"
- Preserve exact indentation
- For deletions: show surrounding context, omit the deleted lines
- Batch multiple edits to the same file in one call

DISAMBIGUATION — when a file has repeated patterns, include enough unique context:
  BAD:  just "return result;" (matches many places)
  GOOD: include the unique function signature above it

FALLBACK: If morph_edit fails (API error, timeout), use the native 'edit' tool with exact oldString/newString matching.`,

        args: {
          target_filepath: tool.schema
            .string()
            .describe("Path of the file to modify"),
          instructions: tool.schema
            .string()
            .describe(
              "Brief first-person description of what you're changing. Used to disambiguate uncertainty in the edit.",
            ),
          code_edit: tool.schema
            .string()
            .describe(
              'The code changes wrapped with "// ... existing code ..." markers for unchanged sections',
            ),
        },

        async execute(args, context) {
          const { target_filepath, instructions, code_edit } = args;
          const normalizedCodeEdit = normalizeCodeEditInput(code_edit);

          // Guard 1: Block readonly agents
          if (
            !ALLOW_READONLY_AGENTS &&
            READONLY_AGENTS.includes(context.agent)
          ) {
            await log(
              "debug",
              `Blocked morph_edit in readonly agent: ${context.agent}`,
            );
            return `Error: morph_edit is not available in ${context.agent} mode.

The ${context.agent} agent is read-only and cannot modify files.

Options:
1. Switch to 'build' mode (Tab key) to make changes
2. Use the native 'edit' tool if permitted by your agent config
3. Set MORPH_ALLOW_READONLY_AGENTS=true to override this restriction`;
          }

          const filepath = target_filepath.startsWith("/")
            ? target_filepath
            : `${directory}/${target_filepath}`;

          if (!MORPH_API_KEY) {
            return `Error: MORPH_API_KEY not configured.

To use morph_edit, set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys

Alternatively, use the native 'edit' tool for this change.`;
          }

          // Read the original file
          let originalCode: string;
          try {
            const file = Bun.file(filepath);
            if (!(await file.exists())) {
              if (!normalizedCodeEdit.includes(EXISTING_CODE_MARKER)) {
                await Bun.write(filepath, normalizedCodeEdit);
                return `Created new file: ${target_filepath}\n\nLines: ${normalizedCodeEdit.split("\n").length}`;
              }
              return `Error: File not found: ${target_filepath}

The file doesn't exist and the code_edit contains lazy markers.
For new files, provide the complete content without "${EXISTING_CODE_MARKER}" markers.`;
            }
            originalCode = await file.text();
          } catch (err) {
            const error = err as Error;
            return `Error reading file ${target_filepath}: ${error.message}`;
          }

          // Guard 2: Pre-flight marker check
          const hasMarkers = normalizedCodeEdit.includes(EXISTING_CODE_MARKER);
          const originalLineCount = originalCode.split("\n").length;

          if (!hasMarkers && originalLineCount > 10) {
            return `Error: Missing "${EXISTING_CODE_MARKER}" markers.

Your code_edit would replace the entire file (${originalLineCount} lines) because it contains no markers.
This is almost certainly unintended and would cause code loss.

To fix, wrap your changes with markers:
${EXISTING_CODE_MARKER}
YOUR_CHANGES_HERE
${EXISTING_CODE_MARKER}

If you truly want to replace the entire file, use the 'write' tool instead.`;
          }

          if (!hasMarkers && originalLineCount > 3) {
            await log(
              "warn",
              `No markers in code_edit for ${target_filepath} (${originalLineCount} lines). Proceeding with full replacement.`,
            );
          }

          // Call Morph SDK to merge the edit
          const startTime = Date.now();
          const result = await morph.fastApply.applyEdit(
            {
              originalCode,
              codeEdit: normalizedCodeEdit,
              instructions,
              filepath: target_filepath,
            },
            {
              morphApiUrl: MORPH_API_URL,
              generateUdiff: true,
            },
          );
          const apiDuration = Date.now() - startTime;

          if (!result.success || !result.mergedCode) {
            return `Morph API failed: ${result.error}

Suggestion: Try using the native 'edit' tool instead with exact string replacement.
The edit tool requires matching the exact text in the file.`;
          }

          const mergedCode = result.mergedCode;

          // Guard 3: Marker leakage detection
          const originalHadMarker = originalCode.includes(EXISTING_CODE_MARKER);
          if (
            hasMarkers &&
            !originalHadMarker &&
            mergedCode.includes(EXISTING_CODE_MARKER)
          ) {
            await log(
              "warn",
              `Marker leakage detected in merged output for ${target_filepath}`,
            );
            return `Morph API produced unsafe output for ${target_filepath}.

Detected placeholder marker text ("${EXISTING_CODE_MARKER}") in merged output.
This means the merge model treated markers as literal code instead of expanding them.

No file changes were written.

Options:
1. Retry with more concrete surrounding context in code_edit
2. Use the native 'edit' tool for exact string replacement
3. Break the change into smaller, more targeted edits`;
          }

          // Guard 4: Catastrophic truncation detection
          const mergedLineCount = mergedCode.split("\n").length;
          const charLoss =
            (originalCode.length - mergedCode.length) / originalCode.length;
          const lineLoss =
            (originalLineCount - mergedLineCount) / originalLineCount;

          if (hasMarkers && charLoss > 0.6 && lineLoss > 0.5) {
            await log(
              "warn",
              `Catastrophic truncation detected for ${target_filepath}: ${Math.round(charLoss * 100)}% char loss, ${Math.round(lineLoss * 100)}% line loss`,
            );
            return `Morph API produced a potentially destructive merge for ${target_filepath}.

Original: ${originalLineCount} lines (${originalCode.length} chars)
Merged:   ${mergedLineCount} lines (${mergedCode.length} chars)
Loss:     ${Math.round(charLoss * 100)}% characters, ${Math.round(lineLoss * 100)}% lines

Because markers were provided, this large shrink is likely unintended.
No file changes were written.

Options:
1. Retry with more precise anchors in code_edit
2. Use the native 'edit' tool for exact string replacement
3. Break the change into smaller edits`;
          }

          // Write the merged result
          try {
            await Bun.write(filepath, mergedCode);
          } catch (err) {
            const error = err as Error;
            return `Error writing file ${target_filepath}: ${error.message}`;
          }

          // Use SDK-provided diff and change stats
          const udiff = result.udiff || "No changes detected";
          const { linesAdded, linesRemoved } = result.changes;
          const originalLines = originalCode.split("\n").length;
          const mergedLines = mergedCode.split("\n").length;

          return `Applied edit to ${target_filepath}

+${linesAdded} -${linesRemoved} lines | ${originalLines} -> ${mergedLines} total | ${apiDuration}ms

\`\`\`diff
${udiff.slice(0, 3000)}${udiff.length > 3000 ? "\n... (truncated)" : ""}
\`\`\``;
        },
    });
  }

  if (MORPH_WARPGREP_ENABLED) {
    tools.warpgrep_codebase_search = tool({
        description: `Fast agentic codebase search. Uses ripgrep, file reading, and directory listing across multiple turns to find relevant code contexts.

Use this for exploratory searches like "Find the authentication flow", "How does error handling work", "Where is the database connection configured". Returns relevant file sections with line numbers.

For exact keyword searches (specific function names, variable names), prefer grep/ripgrep directly.`,

        args: {
          search_term: tool.schema
            .string()
            .describe(
              "Natural language search query describing what to find in the codebase",
            ),
        },

        async execute(args, context) {
          if (!MORPH_API_KEY) {
            return `Error: MORPH_API_KEY not configured.

To use warpgrep_codebase_search, set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys`;
          }

          const startTime = Date.now();

          try {
            const generator = warpGrep.execute({
              searchTerm: args.search_term,
              repoRoot: directory,
              streamSteps: true,
            });

            let turnCount = 0;
            let result: WarpGrepResult;

            for (;;) {
              const { value, done } = await generator.next();
              if (done) {
                result = value;
                break;
              }
              turnCount = value.turn;
              await log(
                "debug",
                `WarpGrep turn ${value.turn}: ${value.toolCalls?.map((tc: { name: string }) => tc.name).join(", ") ?? "..."}`,
              );
            }

            const duration = Date.now() - startTime;
            const contextCount = result.contexts?.length ?? 0;

            await log(
              "info",
              `WarpGrep: ${contextCount} contexts in ${turnCount} turns (${duration}ms)`,
            );

            return formatWarpGrepResult(result);
          } catch (err) {
            const error = err as Error;
            const duration = Date.now() - startTime;
            await log(
              "error",
              `WarpGrep failed after ${duration}ms: ${error.message}`,
            );
            return `WarpGrep search failed: ${error.message}

Try rephrasing your search term or using grep for exact keyword searches.`;
          }
        },
    });
  }

  // Build hooks object, conditionally including compaction hooks
  const hooks: Record<string, any> = {
    tool: tools,
  };

  // Customize tool output display in TUI
  hooks["tool.execute.after"] = async (input: any, output: any) => {
      if (input.tool === "morph_edit") {
        const fileMatch = output.output.match(/Applied edit to (.+?)\n/);
        const statsMatch = output.output.match(/\+(\d+) -(\d+) lines/);
        const timingMatch = output.output.match(/\| (\d+)ms/);
        const createdMatch = output.output.match(/Created new file: (.+?)\n/);
        const linesMatch = output.output.match(/Lines: (\d+)/);
        const errorMatch = output.output.match(/^Error:/);
        const blockedMatch = output.output.match(
          /not available in (.+?) mode/,
        );
        const apiFailMatch = output.output.match(/^Morph API failed:/);
        const unsafeMatch = output.output.match(
          /^Morph API produced unsafe output for (.+?)\./,
        );
        const truncationMatch = output.output.match(
          /^Morph API produced a potentially destructive merge for (.+?)\./,
        );

        if (createdMatch) {
          const lines = linesMatch?.[1] || "?";
          output.title = `Morph: ${createdMatch[1]} (new, ${lines} lines)`;
        } else if (fileMatch && statsMatch) {
          const timing = timingMatch ? ` (${timingMatch[1]}ms)` : "";
          output.title = `Morph: ${fileMatch[1]} +${statsMatch[1]}/-${statsMatch[2]}${timing}`;
        } else if (unsafeMatch) {
          output.title = `Morph: blocked (marker leakage) ${unsafeMatch[1]}`;
        } else if (truncationMatch) {
          output.title = `Morph: blocked (truncation) ${truncationMatch[1]}`;
        } else if (blockedMatch) {
          output.title = `Morph: blocked (${blockedMatch[1]} mode)`;
        } else if (apiFailMatch) {
          output.title = `Morph: API failed`;
        } else if (errorMatch) {
          output.title = `Morph: failed`;
        }

        output.metadata = {
          ...output.metadata,
          provider: "morph",
          version: PLUGIN_VERSION,
        };
      }

      if (input.tool === "warpgrep_codebase_search") {
        const fileMatches = output.output.match(/<file path="[^"]+"/g);
        const failMatch = output.output.match(
          /^(Search failed|WarpGrep search failed):/,
        );
        const noResultMatch = output.output.match(/^No relevant code found/);

        if (failMatch) {
          output.title = "WarpGrep: search failed";
        } else if (noResultMatch) {
          output.title = "WarpGrep: no results";
        } else if (fileMatches) {
          output.title = `WarpGrep: ${fileMatches.length} contexts`;
        }

        output.metadata = {
          ...output.metadata,
          provider: "morph",
          version: PLUGIN_VERSION,
        };
      }
  };

  if (MORPH_COMPACT_ENABLED) {
    // Proactive compaction: compress older messages via Morph before the LLM
    // sees them. This preempts OpenCode's built-in auto-compact (95% context).
    // Messages stay in the DB untouched; the LLM just sees a compressed view.
    hooks["experimental.chat.messages.transform"] = async (_input: any, output: any) => {
      if (!MORPH_API_KEY) return;

      const messages = output.messages;
      if (messages.length < COMPACT_PRESERVE_RECENT + 2) return;

      const totalChars = estimateTotalChars(messages);
      if (totalChars < COMPACT_CHAR_THRESHOLD) return;

      // Split: older messages to compact, recent messages to keep intact
      const olderMessages = messages.slice(0, -COMPACT_PRESERVE_RECENT);
      const recentMessages = messages.slice(-COMPACT_PRESERVE_RECENT);

      if (olderMessages.length === 0) return;

      // Check cache — if we've already compacted these exact messages, reuse
      const currentHash = hashMessageIds(olderMessages);
      if (compactCache && compactCache.messageIdHash === currentHash) {
        // Rebuild output from cached compaction
        const compactedMsg = buildCompactedMessage(
          olderMessages[0]!,
          compactCache.result,
          olderMessages.length,
        );
        output.messages = [compactedMsg, ...recentMessages];
        return;
      }

      // Convert to compact API format and call Morph
      const compactInput = messagesToCompactInput(olderMessages);
      if (compactInput.length === 0) return;

      try {
        const result = await compactClient.compact({
          messages: compactInput,
          compressionRatio: COMPACT_RATIO,
          preserveRecent: 0, // we handle preservation ourselves
        });

        // Cache the result
        compactCache = { messageIdHash: currentHash, result };

        const compactedMsg = buildCompactedMessage(
          olderMessages[0]!,
          result,
          olderMessages.length,
        );
        output.messages = [compactedMsg, ...recentMessages];

        await log(
          "info",
          `Compact: ${olderMessages.length} messages → ${Math.round(result.usage.compression_ratio * 100)}% kept (${result.usage.processing_time_ms}ms)`,
        );
      } catch (err) {
        // On failure, leave messages unchanged — OpenCode's built-in compact
        // will handle context overflow if needed
        await log(
          "warn",
          `Compact failed: ${(err as Error).message}. Falling back to native compaction.`,
        );
      }
    };

    // When OpenCode's native compaction triggers, log it
    hooks["experimental.session.compacting"] = async (_input: any, output: any) => {
      await log("debug", "OpenCode native compaction triggered");
      // We could add extra context here but the proactive compaction
      // via messages.transform should prevent this from firing often
      output.context.push(
        "Note: Morph compact plugin is active. Older messages may already be compressed.",
      );
    };
  }

  return hooks;
};

/**
 * Build a synthetic message containing the compacted output.
 * Uses the first old message's metadata as a template.
 */
function buildCompactedMessage(
  templateMsg: { info: Message; parts: Part[] },
  result: CompactResult,
  messageCount: number,
): { info: Message; parts: Part[] } {
  return {
    info: {
      ...templateMsg.info,
      role: "user" as const,
    } as Message,
    parts: [
      {
        id: `morph-compact-${Date.now()}`,
        sessionID: templateMsg.info.sessionID,
        messageID: templateMsg.info.id,
        type: "text" as const,
        text: `[Morph Compact: ${messageCount} messages compressed, ${Math.round(result.usage.compression_ratio * 100)}% kept]\n\n${result.output}`,
      } as TextPart,
    ],
  };
}

export default MorphPlugin;
