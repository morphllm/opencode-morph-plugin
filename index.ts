/**
 * OpenCode Morph Plugin v2
 *
 * Integrates Morph SDK for fast apply, WarpGrep codebase search, and shell env.
 * Uses MorphClient for shared config (API key, timeout, retries) across all tools.
 *
 * @see https://docs.morphllm.com/quickstart
 */

import { type Plugin, tool } from "@opencode-ai/plugin";
import { createHash } from "node:crypto";
import { MorphClient, WarpGrepClient, CompactClient } from "@morphllm/morphsdk";
import type { WarpGrepResult } from "@morphllm/morphsdk";
import type { Part, TextPart, ToolPart, Message } from "@opencode-ai/sdk";
import {
  matchCacheChunks,
  type ChunkSummary,
  type CompactFingerprint,
  createBoundedCompactCache,
} from "./compact-cache";

// Config from environment — only MORPH_API_KEY is required
const MORPH_API_KEY = process.env.MORPH_API_KEY;
const MORPH_API_URL = "https://api.morphllm.com";
const MORPH_TIMEOUT = 30000;
const MORPH_WARP_GREP_TIMEOUT = 60000;
const MORPH_COMPACT_TIMEOUT = 60000;
const GITHUB_RESOLVER_TIMEOUT = 10000;
const GITHUB_REPO_API_URL = "https://api.github.com/repos";
const GITHUB_REPO_SEARCH_URL = "https://api.github.com/search/repositories";
const GITHUB_REPO_SUGGESTION_LIMIT = 5;

// Compaction config — threshold and ratio are user-tunable
const COMPACT_CHAR_THRESHOLD = parseInt(
  process.env.MORPH_COMPACT_CHAR_THRESHOLD || "100000",
  10,
);
const COMPACT_PRESERVE_RECENT = parseInt(
  process.env.MORPH_COMPACT_PRESERVE_RECENT || "6",
  10,
);
const COMPACT_RATIO = parseFloat(
  process.env.MORPH_COMPACT_RATIO || "0.3",
);
const COMPACT_CHUNK_SIZE = parseInt(
  process.env.MORPH_COMPACT_CHUNK_SIZE || "20",
  10,
);

/**
 * Feature flags — users can disable specific capabilities.
 * All default to true (enabled). Set to "false" to disable.
 */
const MORPH_EDIT_ENABLED = process.env.MORPH_EDIT !== "false";
const MORPH_WARPGREP_ENABLED = process.env.MORPH_WARPGREP !== "false";
const MORPH_WARPGREP_GITHUB_ENABLED =
  process.env.MORPH_WARPGREP_GITHUB !== "false";
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
const COMPACT_CACHE_SCHEMA_VERSION = 2;

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
 * Separate CompactClient for context compaction.
 */
const compactClient = new CompactClient({
  morphApiKey: MORPH_API_KEY,
  morphApiUrl: MORPH_API_URL,
  timeout: MORPH_COMPACT_TIMEOUT,
});

/**
 * Cache compaction state per session using append-only discrete chunks.
 * Each chunk is an independent summary of a batch of messages, never
 * re-summarized — eliminating rolling-summary drift entirely.
 *
 * Bounded LRU cache capped at MAX_COMPACT_CACHE_SESSIONS entries.
 * Both reads and writes refresh recency; the least-recently-used session
 * is evicted first (Map preserves insertion order).
 */
const MAX_COMPACT_CACHE_SESSIONS = 50;
const compactCacheBySession =
  createBoundedCompactCache(MAX_COMPACT_CACHE_SESSIONS);

/**
 * Normalize code_edit input from LLM tool calls.
 *
 * Agents frequently wrap tool arguments in markdown fences (```lang ... ```).
 * When this is nested inside Morph's XML tag, it confuses the merge
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
 * Tool outputs and visible text are included. Reasoning is intentionally
 * excluded so internal scratchpad-like content is never sent to Morph.
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
      return "";
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
      content: m.parts.map(serializePart).filter(Boolean).join("\n"),
    }))
    .filter((m) => m.content.length > 0);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildCompactConfigDigest(): string {
  return sha256(
    JSON.stringify({
      schemaVersion: COMPACT_CACHE_SCHEMA_VERSION,
      pluginVersion: PLUGIN_VERSION,
      compactRatio: COMPACT_RATIO,
      preserveRecent: COMPACT_PRESERVE_RECENT,
      morphApiUrl: MORPH_API_URL,
      compactModel: process.env.MORPH_COMPACT_MODEL || null,
      promptVersion: "default-v1",
    }),
  );
}

const COMPACT_CONFIG_DIGEST = buildCompactConfigDigest();

function buildCompactionFingerprint(
  messages: { info: Message; parts: Part[] }[],
): CompactFingerprint {
  const messageDigests = messages.map((message) =>
    sha256(
      JSON.stringify({
        id: message.info.id,
        role: message.info.role,
        content: message.parts.map(serializePart).filter(Boolean),
      }),
    ),
  );

  return {
    messageDigests,
    configDigest: COMPACT_CONFIG_DIGEST,
  };
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

function messageHasInFlightToolPart(message: { parts: Part[] }): boolean {
  return message.parts.some((part) => {
    if (part.type !== "tool") return false;
    const state = (part as ToolPart).state;
    return state.status === "pending" || state.status === "running";
  });
}

/**
 * Find the safe compaction boundary within olderMessages.
 * Returns the number of messages from the front that can be safely compacted.
 *
 * Instead of a binary defer-or-not decision, we walk backwards from the end
 * of olderMessages to find the last settled message. Everything before it
 * (inclusive) is safe to compact. Orphaned in-flight tool states deep in
 * history no longer block compaction — they get serialized as
 * "[Tool: x] pending" which Morph summarizes correctly.
 *
 * Returns 0 only if the entire recent window is still in-flight.
 */
function findSafeCompactionBoundary(
  olderMessages: { info: Message; parts: Part[] }[],
  recentMessages: { info: Message; parts: Part[] }[],
): number {
  // If the assistant is still mid-generation or recent tools are running,
  // defer entirely — the context is actively mutating.
  const lastMessage = recentMessages[recentMessages.length - 1];
  if (
    lastMessage?.info.role === "assistant" &&
    lastMessage.info.time.completed === undefined
  ) {
    return 0;
  }
  if (recentMessages.some(messageHasInFlightToolPart)) {
    return 0;
  }

  // Walk backwards from the end of olderMessages to skip any trailing
  // in-flight messages. We compact everything up to (including) the last
  // settled message.
  let boundary = olderMessages.length;
  while (boundary > 0 && messageHasInFlightToolPart(olderMessages[boundary - 1]!)) {
    boundary--;
  }

  return boundary;
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

type PublicRepoContextSearchArgs = {
  search_term: string;
  owner_repo?: string;
  github_url?: string;
  branch?: string;
};

type GitHubRepo = string; // "owner/repo"

type GitHubRepoSuggestion = {
  fullName: string;
  htmlUrl: string;
  description?: string;
  stars: number;
  ownerLogin: string;
  name: string;
};

type GitHubRepoLookupResult =
  | {
    status: "found";
    fullName: string;
    defaultBranch?: string;
    htmlUrl?: string;
  }
  | {
    status: "not_found";
    detail: string;
  }
  | {
    status: "unavailable";
    detail: string;
  };

const GITHUB_OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function tokenizeSuggestionQuery(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2);
}

function buildGitHubSuggestionQueries(
  repo: GitHubRepo,
  searchTerm: string,
): string[] {
  const [owner, repoName] = repo.split("/");
  const searchTokens = tokenizeSuggestionQuery(searchTerm).slice(0, 3);
  const queries = new Set<string>();

  if (owner) queries.add(`user:${owner}`);
  if (owner && repoName) queries.add(`${repoName} user:${owner}`);
  if (repoName) queries.add(repoName);
  if (searchTokens.length > 0 && repoName) {
    queries.add(`${repoName} ${searchTokens.join(" ")}`);
  }

  return Array.from(queries).slice(0, 4);
}

function formatPublicRepoResolutionFailure(
  repo: GitHubRepo,
  detail?: string,
  suggestions: GitHubRepoSuggestion[] = [],
): string {
  const parts: string[] = [
    `Repository not found: ${repo}\n\nThis repository does not exist or is private. Do NOT keep guessing other repo names.`,
  ];
  if (suggestions.length > 0) {
    const list = suggestions.map((s) => `- ${s.fullName}${s.description ? ` - ${s.description}` : ""}`).join("\n");
    parts.push(`Public repos found under this org:\n${list}\n\nIf one of these looks right, retry with that owner_repo.`);
  }
  parts.push(`If the package or SDK is closed-source or private:\n- Check the ecosystem registry or package page for repository metadata before guessing more names\n- Use the registry that matches the environment: npm for Node/TypeScript, crates.io for Rust, PyPI for Python, pkg.go.dev for Go, etc.\n- The real source repo may be under a different org or name\n- Stop trying variations and report that the source is not publicly available`);
  return parts.join("\n\n");
}

function resolvePublicRepoLocator(
  args: PublicRepoContextSearchArgs,
): { repo: GitHubRepo } | { error: string } {
  const ownerRepo = args.owner_repo?.trim();
  const githubUrl = args.github_url?.trim();

  if (ownerRepo && githubUrl) {
    return {
      error: `Error: Provide either owner_repo or github_url, not both.

Use owner_repo for values like "owner/repo" or github_url for full URLs like "https://github.com/owner/repo".`,
    };
  }

  if (!ownerRepo && !githubUrl) {
    return {
      error: `Error: Missing repository target.

Provide exactly one of:
- owner_repo: "owner/repo"
- github_url: "https://github.com/owner/repo"`,
    };
  }

  if (ownerRepo) {
    if (!GITHUB_OWNER_REPO_PATTERN.test(ownerRepo)) {
      return {
        error: `Error: owner_repo must be a GitHub repository in "owner/repo" format.

Received: "${ownerRepo}"

Examples:
- "owner/repo"
- "org/project"
- "team/package"

If you have a full URL, use github_url instead.`,
      };
    }

    return { repo: ownerRepo };
  }

  let parsed: URL;
  try {
    parsed = new URL(githubUrl!);
  } catch {
    return {
      error: `Error: github_url must be a valid GitHub repository URL.

Received: "${githubUrl}"

Example:
- "https://github.com/owner/repo"`,
    };
  }

  if (!["github.com", "www.github.com"].includes(parsed.hostname)) {
    return {
      error: `Error: github_url must point to github.com.

Received host: "${parsed.hostname}"

Example:
- "https://github.com/owner/repo"`,
    };
  }

  const pathParts = parsed.pathname
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (pathParts.length < 2) {
    return {
      error: `Error: github_url must include both owner and repository name.

Received: "${githubUrl}"

Example:
- "https://github.com/owner/repo"`,
    };
  }

  const owner = pathParts[0]!;
  const repoName = pathParts[1]!.replace(/\.git$/, "");
  const canonicalRepo = `${owner}/${repoName}`;

  if (!GITHUB_OWNER_REPO_PATTERN.test(canonicalRepo)) {
    return {
      error: `Error: github_url did not resolve to a valid GitHub owner/repo locator.

Received: "${githubUrl}"`,
    };
  }

  return { repo: canonicalRepo };
}

function githubHeaders(): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "@morphllm/opencode-morph-plugin",
  };
}

async function withGitHubTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GITHUB_RESOLVER_TIMEOUT);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function lookupGitHubRepository(
  repo: GitHubRepo,
): Promise<GitHubRepoLookupResult> {
  return withGitHubTimeout(async (signal) => {
    try {
      const response = await fetch(`${GITHUB_REPO_API_URL}/${repo}`, {
        headers: githubHeaders(),
        signal,
      });

      if (response.status === 404) return { status: "not_found", detail: "GitHub repository not found" };
      if (!response.ok) return { status: "unavailable", detail: `GitHub repo lookup failed with status ${response.status}` };

      const body = (await response.json()) as {
        full_name?: string;
        default_branch?: string;
        html_url?: string;
      };

      return {
        status: "found",
        fullName: body.full_name || repo,
        defaultBranch: body.default_branch,
        htmlUrl: body.html_url,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown GitHub repo lookup error";
      return { status: "unavailable", detail: message };
    }
  });
}

async function fetchGitHubRepoSuggestions(
  repo: GitHubRepo,
  searchTerm: string,
): Promise<GitHubRepoSuggestion[]> {
  return withGitHubTimeout(async (signal) => {
    const queries = buildGitHubSuggestionQueries(repo, searchTerm);

    const results = await Promise.all(
      queries.map(async (query) => {
        const url = new URL(GITHUB_REPO_SEARCH_URL);
        url.searchParams.set("q", query);
        url.searchParams.set("sort", "stars");
        url.searchParams.set("order", "desc");
        url.searchParams.set("per_page", String(GITHUB_REPO_SUGGESTION_LIMIT));

        const response = await fetch(url.toString(), { headers: githubHeaders(), signal });
        if (!response.ok) return [];

        const body = (await response.json()) as {
          items?: Array<{
            full_name?: string;
            html_url?: string;
            description?: string | null;
            stargazers_count?: number;
            name?: string;
            owner?: { login?: string };
          }>;
        };

        return (body.items || []).filter(
          (item) => item.full_name && item.html_url && item.name && item.owner?.login,
        );
      }),
    );

    const candidates = new Map<string, GitHubRepoSuggestion>();
    for (const items of results) {
      for (const item of items) {
        if (!candidates.has(item.full_name!)) {
          candidates.set(item.full_name!, {
            fullName: item.full_name!,
            htmlUrl: item.html_url!,
            description: item.description || undefined,
            stars: item.stargazers_count || 0,
            ownerLogin: item.owner!.login!,
            name: item.name!,
          });
        }
      }
    }

    return Array.from(candidates.values()).slice(0, GITHUB_REPO_SUGGESTION_LIMIT);
  });
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

  const showToast = async (
    variant: "info" | "success" | "warning" | "error",
    message: string,
    title = "Morph Compact",
    duration = 2000,
  ) => {
    try {
      await client.tui?.showToast({
        body: {
          title,
          message,
          variant,
          duration,
        },
      });
    } catch {
      // TUI feedback is best-effort; keep compaction non-blocking.
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
      MORPH_WARPGREP_GITHUB_ENABLED && "warpgrep-github",
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

      async execute(args) {
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

          for (; ;) {
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

  if (MORPH_WARPGREP_GITHUB_ENABLED) {
    tools.warpgrep_github_search = tool({
      description: `Grounded code context search for public GitHub repositories. Uses Morph's hosted WarpGrep to search indexed public repos without cloning them locally.

PREFER this tool over web search or docs fetching when the question is about how an open-source library or SDK works internally. If the user asks how something works in a library or package from any ecosystem, find its GitHub repo and search it here instead of fetching docs URLs.

Use this when:
- User asks how an external library/SDK works (auth, retries, sessions, internals)
- You need to understand implementation details of any open-source dependency
- Docs URLs are failing or returning 404s — search the source instead
- User asks about a framework or tool they didn't provide a repo for — infer the canonical GitHub repo from the matching ecosystem (npm, crates.io, PyPI, pkg.go.dev, etc.) before guessing owner/repo variants

This tool is for public remote repos. For the current checked-out workspace, use warpgrep_codebase_search instead.

Provide exactly one repository locator:
- owner_repo: "owner/repo"
- github_url: "https://github.com/owner/repo"`,

      args: {
        search_term: tool.schema
          .string()
          .describe(
            "Natural language query describing what to find or understand in the public repository",
          ),
        owner_repo: tool.schema
          .string()
          .optional()
          .describe(
            'GitHub repository in "owner/repo" format, for example "owner/repo"',
          ),
        github_url: tool.schema
          .string()
          .optional()
          .describe(
            'Full GitHub repository URL, for example "https://github.com/owner/repo"',
          ),
        branch: tool.schema
          .string()
          .optional()
          .describe(
            "Optional branch name to search instead of the repository default branch",
          ),
      },

      async execute(args) {
        if (!MORPH_API_KEY) {
          return `Error: MORPH_API_KEY not configured.

To use warpgrep_github_search, set the MORPH_API_KEY environment variable.
Get your API key at: https://morphllm.com/dashboard/api-keys`;
        }

        const locator = resolvePublicRepoLocator(args);
        if ("error" in locator) {
          return locator.error;
        }
        const repo = locator.repo;

        const startTime = Date.now();
        const repoLookup = await lookupGitHubRepository(repo);

        if (repoLookup.status === "not_found") {
          const suggestions = await fetchGitHubRepoSuggestions(repo, args.search_term).catch(() => []);
          return formatPublicRepoResolutionFailure(repo, repoLookup.detail, suggestions);
        }

        if (repoLookup.status === "unavailable") {
          await log("warn", `GitHub repo lookup unavailable for ${repo}: ${repoLookup.detail}`);
        }

        try {
          const result = await warpGrep.searchGitHub({
            searchTerm: args.search_term,
            github: repo,
            branch: args.branch,
          });

          const duration = Date.now() - startTime;
          const contextCount = result.contexts?.length ?? 0;

          await log("info", `Public repo context: ${repo} → ${contextCount} contexts (${duration}ms)`);

          if (!result.success) {
            const suggestions = await fetchGitHubRepoSuggestions(repo, args.search_term).catch(() => []);
            return formatPublicRepoResolutionFailure(repo, result.error, suggestions);
          }

          return `Repository: ${repo}\n\n${formatWarpGrepResult(result)}`;
        } catch (err) {
          const error = err as Error;
          const duration = Date.now() - startTime;
          await log("error", `Public repo context search failed for ${repo} after ${duration}ms: ${error.message}`);
          const suggestions = await fetchGitHubRepoSuggestions(repo, args.search_term).catch(() => []);
          return formatPublicRepoResolutionFailure(repo, error.message, suggestions);
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
    const morphMeta = { ...output.metadata, provider: "morph", version: PLUGIN_VERSION };

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

      output.metadata = morphMeta;
    }

    if (input.tool === "warpgrep_codebase_search") {
      const fileMatches = output.output.match(/<file path="[^"]+"/g);
      const failMatch = output.output.match(
        /^(Search failed|WarpGrep search failed):/,
      );
      const noResultMatch = output.output.match(/^No relevant code found/m);

      if (failMatch) {
        output.title = "WarpGrep: search failed";
      } else if (noResultMatch) {
        output.title = "WarpGrep: no results";
      } else if (fileMatches) {
        output.title = `WarpGrep: ${fileMatches.length} contexts`;
      }

      output.metadata = morphMeta;
    }

    if (input.tool === "warpgrep_github_search") {
      const repoMatch = output.output.match(/^Repository: (.+?)$/m);
      const fileMatches = output.output.match(/<file path="[^"]+"/g);
      const repo = repoMatch?.[1];

      if (output.output.match(/^Repository resolution failed/m)) {
        output.title = repo ? `Public repo: unresolved (${repo})` : "Public repo: unresolved";
      } else if (output.output.match(/^Public repo context search failed/)) {
        output.title = repo ? `Public repo: failed (${repo})` : "Public repo: search failed";
      } else if (output.output.match(/^Repository: .+\n\nNo relevant code found/m)) {
        output.title = repo ? `Public repo: no results (${repo})` : "Public repo: no results";
      } else if (fileMatches) {
        output.title = repo
          ? `Public repo: ${repo} (${fileMatches.length} contexts)`
          : `Public repo: ${fileMatches.length} contexts`;
      }

      output.metadata = morphMeta;
    }
  };

  if (MORPH_COMPACT_ENABLED) {
    // Compaction: compress older messages via Morph before the LLM
    // sees them. This preempts OpenCode's built-in auto-compact (95% context).
    // Messages stay in the DB untouched; the LLM just sees a compressed view.
    //
    // Architecture: append-only discrete chunks.
    // Each chunk is an independent summary of COMPACT_CHUNK_SIZE messages.
    // Old chunks are never re-summarized, eliminating rolling-summary drift.
    // Only the newest unmatched batch is sent to Morph on each cycle.
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

      // Find safe boundary — skip trailing in-flight messages instead of
      // deferring entirely. This means orphaned tool states deep in history
      // never block compaction.
      const safeBoundary = findSafeCompactionBoundary(olderMessages, recentMessages);
      if (safeBoundary === 0) return;

      const compactableMessages = olderMessages.slice(0, safeBoundary);
      const skippedMessages = olderMessages.slice(safeBoundary);

      const sessionID = compactableMessages[0]!.info.sessionID;
      const fingerprint = buildCompactionFingerprint(compactableMessages);

      // Check existing cache for this session
      const sessionCache = compactCacheBySession.get(sessionID);
      const { matchedChunks, matchedMessageCount } = sessionCache
        ? matchCacheChunks(sessionCache, fingerprint)
        : { matchedChunks: [] as ChunkSummary[], matchedMessageCount: 0 };

      // If the entire compactable prefix is already cached, reuse it.
      if (matchedMessageCount === compactableMessages.length && matchedChunks.length > 0) {
        const compactedMsg = buildCompactedMessage(
          compactableMessages[0]!,
          matchedChunks,
          compactableMessages.length,
          totalChars,
        );
        output.messages = [compactedMsg, ...skippedMessages, ...recentMessages];
        return;
      }

      // Determine which messages still need compaction
      const uncachedMessages = compactableMessages.slice(matchedMessageCount);
      if (uncachedMessages.length === 0) return;

      // Batch uncached messages into chunks of COMPACT_CHUNK_SIZE
      const newChunks: ChunkSummary[] = [];
      let totalCompactTime = 0;
      for (let i = 0; i < uncachedMessages.length; i += COMPACT_CHUNK_SIZE) {
        const batch = uncachedMessages.slice(i, i + COMPACT_CHUNK_SIZE);
        const compactInput = messagesToCompactInput(batch);
        if (compactInput.length === 0) continue;

        try {
          const result = await compactClient.compact({
            messages: compactInput,
            compressionRatio: COMPACT_RATIO,
            preserveRecent: 0,
          });

          const batchDigests = fingerprint.messageDigests.slice(
            matchedMessageCount + i,
            matchedMessageCount + i + batch.length,
          );

          newChunks.push({
            messageCount: batch.length,
            messageDigests: batchDigests,
            output: result.output,
            charCountSaved: estimateTotalChars(batch) - result.output.length,
          });

          totalCompactTime += result.usage.processing_time_ms;

          await log(
            "info",
            `Compact chunk: ${batch.length} messages → ${Math.round(result.usage.compression_ratio * 100)}% kept (${result.usage.processing_time_ms}ms)`,
          );
        } catch (err) {
          // If a chunk fails, stop here — we'll use whatever we've built so far
          // plus the raw remaining messages. Don't let one failure lose everything.
          await log(
            "warn",
            `Compact chunk failed: ${(err as Error).message}. Keeping ${batch.length} messages raw.`,
          );
          break;
        }
      }

      const allChunks = [...matchedChunks, ...newChunks];
      if (allChunks.length === 0) return;

      // Persist updated cache
      const totalCompactedMessages = allChunks.reduce((sum, c) => sum + c.messageCount, 0);
      compactCacheBySession.set(sessionID, {
        sessionID,
        configDigest: fingerprint.configDigest,
        chunks: allChunks,
        totalMessagesCompacted: totalCompactedMessages,
      });

      // Any messages beyond what we successfully chunked stay raw
      const unchunkedMessages = compactableMessages.slice(totalCompactedMessages);

      const compactedMsg = buildCompactedMessage(
        compactableMessages[0]!,
        allChunks,
        totalCompactedMessages,
        totalChars,
      );
      output.messages = [compactedMsg, ...unchunkedMessages, ...skippedMessages, ...recentMessages];

      await showToast(
        "success",
        `${allChunks.length} chunks (${totalCompactedMessages} msgs compacted) | ${totalCompactTime}ms`,
      );
    };

    // When OpenCode's native compaction triggers, log it
    hooks["experimental.session.compacting"] = async (_input: any, output: any) => {
      await log("debug", "OpenCode native compaction triggered");
      // We could add extra context here but the compaction
      // via messages.transform should prevent this from firing often
      output.context.push(
        "Note: Morph compact plugin is active. Older messages may already be compressed.",
      );
    };
  }

  return hooks;
};

/**
 * Build a synthetic message containing the compacted output from discrete chunks.
 * Each chunk's summary is concatenated with a separator — old chunks are never
 * re-summarized, preserving fidelity across arbitrarily long sessions.
 */
function buildCompactedMessage(
  templateMsg: { info: Message; parts: Part[] },
  chunks: ChunkSummary[],
  messageCount: number,
  originalCharCount?: number,
): { info: Message; parts: Part[] } {
  const totalSavedChars = chunks.reduce((s, c) => s + c.charCountSaved, 0);
  const compressedCharCount = chunks.reduce((s, c) => s + c.output.length, 0);

  let statsLine: string;
  if (originalCharCount !== undefined) {
    const savedK = totalSavedChars > 1000 ? `${Math.round(totalSavedChars / 1000)}K` : totalSavedChars;
    const origK = originalCharCount > 1000 ? `${Math.round(originalCharCount / 1000)}K` : originalCharCount;
    const compK = compressedCharCount > 1000 ? `${Math.round(compressedCharCount / 1000)}K` : compressedCharCount;
    statsLine = `[Morph Compact: ${messageCount} msgs (${origK} chars) → ${chunks.length} chunks (${compK} chars) | saved ${savedK} chars]`;
  } else {
    statsLine = `[Morph Compact: ${messageCount} messages → ${chunks.length} chunks]`;
  }

  const chunkTexts = chunks.map((chunk, i) =>
    `--- Chunk ${i + 1}/${chunks.length} (${chunk.messageCount} messages) ---\n${chunk.output}`
  );

  return {
    info: {
      ...templateMsg.info,
      role: "assistant" as const,
    } as Message,
    parts: [
      {
        id: `morph-compact-${Date.now()}`,
        sessionID: templateMsg.info.sessionID,
        messageID: templateMsg.info.id,
        type: "text" as const,
        text: `${statsLine}\n[Background context summary of ${messageCount} earlier messages.]\n\n${chunkTexts.join("\n\n")}`,
      } as TextPart,
    ],
  };
}

export default MorphPlugin;
