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
import { isAbsolute, resolve as resolvePath } from "node:path";

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
// Approximate: ~3 characters per token (rough estimate for threshold math)
const CHARS_PER_TOKEN = 3;

// Compact when effective context reaches this fraction of model's max context window
const COMPACT_CONTEXT_THRESHOLD = parseFloat(
  process.env.MORPH_COMPACT_CONTEXT_THRESHOLD || "0.7",
);

// Number of recent messages to keep uncompacted (full fidelity for the LLM).
// Default 1 = keep only the latest user prompt; compact all prior messages.
const COMPACT_PRESERVE_RECENT = parseInt(
  process.env.MORPH_COMPACT_PRESERVE_RECENT || "1",
  10,
);
const COMPACT_RATIO = parseFloat(
  process.env.MORPH_COMPACT_RATIO || "0.3",
);

// Optional fixed token limit — overrides the percentage-based threshold.
// e.g. MORPH_COMPACT_TOKEN_LIMIT=20000 → compact at 20k tokens regardless of model window
const COMPACT_TOKEN_LIMIT = process.env.MORPH_COMPACT_TOKEN_LIMIT
  ? parseInt(process.env.MORPH_COMPACT_TOKEN_LIMIT, 10)
  : null;

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

/** Canonical marker string used for lazy edit placeholders */
const EXISTING_CODE_MARKER = "// ... existing code ...";
const MORPH_ROUTING_HINT_HEADER = "Morph plugin routing hints:";

/**
 * Shared MorphClient — FastApply uses morph.fastApply.applyEdit()
 * with MORPH_API_URL passed as per-call override.
 */
const morph = MORPH_API_KEY
  ? new MorphClient({
      apiKey: MORPH_API_KEY,
      timeout: MORPH_TIMEOUT,
    })
  : null;

/**
 * Separate WarpGrep client with its own timeout (typically longer than fast apply).
 */
const warpGrep = MORPH_API_KEY
  ? new WarpGrepClient({
      morphApiKey: MORPH_API_KEY,
      morphApiUrl: MORPH_API_URL,
      timeout: MORPH_WARP_GREP_TIMEOUT,
    })
  : null;

/**
 * Separate CompactClient for context compaction.
 */
const compactClient = MORPH_API_KEY
  ? new CompactClient({
      morphApiKey: MORPH_API_KEY,
      morphApiUrl: MORPH_API_URL,
      timeout: MORPH_COMPACT_TIMEOUT,
    })
  : null;

/**
 * Model context window size in tokens. Updated from chat.params hook.
 * Default is conservative — actual value captured on first LLM call.
 */
let modelContextTokens = 200_000;

/**
 * Frozen compaction state. Once messages are compacted, the result is
 * frozen and reused identically on every subsequent messages.transform call.
 * This preserves prompt cache stability (the prefix bytes never change).
 *
 * On re-compaction, the old frozen block is discarded entirely and a new
 * one is built from only the uncompacted messages (never double-compact).
 */
let compactionState: {
  frozenMessages: { info: Message; parts: Part[] }[];
  compactedUpToIndex: number;
  frozenChars: number;
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


function resolveSessionFilepath(
  targetFilepath: string,
  sessionDirectory: string,
): string {
  return isAbsolute(targetFilepath)
    ? targetFilepath
    : resolvePath(sessionDirectory, targetFilepath);
}

function resolveSessionRepoRoot(
  sessionDirectory: string,
  sessionWorktree: string,
): string {
  return sessionWorktree || sessionDirectory;
}

function appendRuntimeNotes(description: string, notes: string[]): string {
  if (notes.length === 0) return description;

  return `${description}\n\nRuntime notes:\n${notes.map((note) => `- ${note}`).join("\n")}`;
}

function buildToolRuntimeNotes(toolID: string): string[] {
  switch (toolID) {
    case "morph_edit": {
      const notes = [
        "Relative paths resolve from the active session directory.",
      ];

      if (!ALLOW_READONLY_AGENTS) {
        notes.push(
          `Blocked in readonly agents: ${READONLY_AGENTS.join(", ")}.`,
        );
      }

      if (!MORPH_API_KEY) {
        notes.push("Currently unavailable until MORPH_API_KEY is configured.");
      }

      return notes;
    }

    case "warpgrep_codebase_search": {
      const notes = [
        "Searches the current project worktree, not just the immediate cwd.",
      ];

      if (!MORPH_API_KEY) {
        notes.push("Currently unavailable until MORPH_API_KEY is configured.");
      }

      return notes;
    }

    case "warpgrep_github_search": {
      const notes = [
        "Use this for public GitHub source questions, not the current checked-out repo.",
      ];

      if (!MORPH_API_KEY) {
        notes.push("Currently unavailable until MORPH_API_KEY is configured.");
      }

      return notes;
    }

    default:
      return [];
  }
}

function buildMorphSystemRoutingHint(): string | null {
  if (!MORPH_API_KEY) {
    return [
      MORPH_ROUTING_HINT_HEADER,
      "- Morph remote tools are currently unavailable because MORPH_API_KEY is not configured.",
      "- Use native edit/write/grep tools until Morph credentials are configured.",
    ].join("\n");
  }

  const lines = [MORPH_ROUTING_HINT_HEADER];

  if (MORPH_EDIT_ENABLED) {
    lines.push(
      "- Prefer morph_edit for large or scattered edits inside existing files.",
    );
    lines.push("- Use native edit for small exact replacements.");
    lines.push("- Use write for brand new files.");

    if (!ALLOW_READONLY_AGENTS) {
      lines.push(
        `- morph_edit is blocked in readonly agents: ${READONLY_AGENTS.join(", ")}.`,
      );
    }
  }

  if (MORPH_WARPGREP_ENABLED) {
    lines.push(
      "- Use warpgrep_codebase_search for exploratory local codebase questions.",
    );
  }

  if (MORPH_WARPGREP_GITHUB_ENABLED) {
    lines.push(
      "- Use warpgrep_github_search for public GitHub source questions.",
    );
  }

  return lines.length > 1 ? lines.join("\n") : null;
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

const MorphPlugin: Plugin = async ({ directory, worktree, client }) => {
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
  ) => {
    try {
      await client.tui?.showToast({
        body: { title: "Morph Compact", message, variant, duration: 2000 },
      });
    } catch {}
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

          const filepath = resolveSessionFilepath(
            target_filepath,
            directory,
          );

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
          const result = await morph!.fastApply.applyEdit(
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
            const generator = warpGrep!.execute({
              searchTerm: args.search_term,
              repoRoot: resolveSessionRepoRoot(
                directory,
                worktree,
              ),
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
            const result = await warpGrep!.searchGitHub({
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

  hooks["tool.definition"] = async (input: any, output: any) => {
    const notes = buildToolRuntimeNotes(input.toolID);
    if (notes.length === 0) return;

    output.description = appendRuntimeNotes(output.description, notes);
  };

  const systemRoutingHint = buildMorphSystemRoutingHint();
  if (systemRoutingHint) {
    hooks["experimental.chat.system.transform"] = async (
      _input: any,
      output: any,
    ) => {
      const alreadyPresent = output.system.some((entry: string) =>
        entry.includes(MORPH_ROUTING_HINT_HEADER),
      );
      if (!alreadyPresent) {
        output.system.push(systemRoutingHint);
      }
    };
  }

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
    // Capture model context window from chat.params (fires every LLM call)
    hooks["chat.params"] = async (input: any) => {
      // debugLog(`chat.params CALLED: model=${input.model?.id}, context=${input.model?.limit?.context}`);
      if (input.model?.limit?.context) {
        modelContextTokens = input.model.limit.context;
      }
    };

    // Compaction: compress older messages via Morph, then FREEZE the result.
    // The frozen block is reused byte-for-byte on every subsequent call,
    // preserving the LLM provider's prompt prefix cache.
    // Re-compaction only fires when the threshold is crossed again.
    hooks["experimental.chat.messages.transform"] = async (_input: any, output: any) => {
      //
      if (!MORPH_API_KEY) return;

      const messages = output.messages;

      // Approximate char threshold — fixed token limit takes precedence
      const charThreshold = COMPACT_TOKEN_LIMIT
        ? COMPACT_TOKEN_LIMIT * CHARS_PER_TOKEN
        : modelContextTokens * COMPACT_CONTEXT_THRESHOLD * CHARS_PER_TOKEN;

      const totalChars = estimateTotalChars(messages);
      const estTokens = Math.round(totalChars / CHARS_PER_TOKEN);

      await log(
        "debug",
        `messages.transform: ${messages.length} msgs, ${totalChars} chars (~${estTokens} tokens), threshold=${charThreshold} chars (~${Math.round(charThreshold / CHARS_PER_TOKEN)} tokens), hasFrozen=${!!compactionState}, tokenLimit=${COMPACT_TOKEN_LIMIT ?? "auto"}, modelCtx=${modelContextTokens}`,
      );

      // Need at least preserve + 1 messages (something to compact + preserved recent)
      if (messages.length <= COMPACT_PRESERVE_RECENT) {
        // debugLog(`Skipping compact: only ${messages.length} messages (need > ${COMPACT_PRESERVE_RECENT})`);
        return;
      }

      if (compactionState) {
        // We have a frozen block from a previous compaction.
        // Messages after the compaction boundary are uncompacted.
        const uncompacted = messages.slice(compactionState.compactedUpToIndex);
        const effectiveChars = compactionState.frozenChars + estimateTotalChars(uncompacted);

        await log(
          "debug",
          `Re-compact check: frozenChars=${compactionState.frozenChars}, uncompacted=${uncompacted.length} msgs (${estimateTotalChars(uncompacted)} chars), effective=${effectiveChars}, threshold=${charThreshold}`,
        );

        if (effectiveChars < charThreshold) {
          // Under threshold — reuse frozen block as-is (stable prefix = cache hit)
          const before = messages.length;
          output.messages = [...compactionState.frozenMessages, ...uncompacted];
          await log(
            "debug",
            `Under threshold — reusing frozen block. Messages: ${before} → ${output.messages.length}`,
          );
          return;
        }

        // Over threshold again — discard old frozen block, compact only the
        // uncompacted messages (never double-compact).
        if (uncompacted.length <= COMPACT_PRESERVE_RECENT) {
          await log("debug", `Cannot re-compact: only ${uncompacted.length} uncompacted messages (need > ${COMPACT_PRESERVE_RECENT})`);
          return;
        }

        const toCompact = uncompacted.slice(0, -COMPACT_PRESERVE_RECENT);
        const recent = uncompacted.slice(-COMPACT_PRESERVE_RECENT);

        const compactInput = messagesToCompactInput(toCompact);
        if (compactInput.length === 0) return;

        await log("info", `Re-compacting ${toCompact.length} messages (${estimateTotalChars(toCompact)} chars), keeping ${recent.length} recent...`);

        try {
          const result = await compactClient!.compact({
            messages: compactInput,
            compressionRatio: COMPACT_RATIO,
            preserveRecent: 0,
          });

          const frozen = buildCompactedMessages(toCompact, result);
          const frozenChars = estimateTotalChars(frozen);
          compactionState = {
            frozenMessages: frozen,
            compactedUpToIndex: messages.length - recent.length,
            frozenChars,
          };
          const beforeLen = messages.length;
          output.messages = [...frozen, ...recent];

          await log(
            "info",
            `Compact (re): ${toCompact.length} messages → ${frozen.length} frozen (${frozenChars} chars). Messages: ${beforeLen} → ${output.messages.length}. Ratio: ${Math.round(result.usage.compression_ratio * 100)}% kept (${result.usage.processing_time_ms}ms)`,
          );
          await showToast(
            "success",
            `${toCompact.length} messages re-compacted (${Math.round(result.usage.compression_ratio * 100)}% kept) | ${result.usage.processing_time_ms}ms`,
          );
        } catch (err) {
          // On failure, use stale frozen block + uncompacted as best-effort
          output.messages = [...compactionState.frozenMessages, ...uncompacted];
          await log(
            "warn",
            `Compact (re) failed: ${(err as Error).message}. Using stale frozen block.`,
          );
        }
        return;
      }

      // No frozen block yet — check if first compaction is needed
      // debugLog(`First compact check: totalChars=${totalChars}, charThreshold=${charThreshold}, over=${totalChars >= charThreshold}`);
      if (totalChars < charThreshold) {
        // debugLog(`Under threshold (${totalChars} < ${charThreshold}), skipping`);
        return;
      }

      const toCompact = messages.slice(0, -COMPACT_PRESERVE_RECENT);
      const recent = messages.slice(-COMPACT_PRESERVE_RECENT);

      // debugLog(`First compact: toCompact=${toCompact.length} msgs (${estimateTotalChars(toCompact)} chars), recent=${recent.length} msgs`);
      if (toCompact.length === 0) {
        // debugLog(`Nothing to compact (toCompact empty)`);
        return;
      }

      const compactInput = messagesToCompactInput(toCompact);
      // debugLog(`compactInput: ${compactInput.length} messages, total chars=${compactInput.reduce((a, m) => a + m.content.length, 0)}`);
      if (compactInput.length === 0) return;

      await log("info", `First compaction: ${toCompact.length} messages (${estimateTotalChars(toCompact)} chars), keeping ${recent.length} recent. Threshold crossed: ${totalChars} >= ${charThreshold}`);

      try {
        // debugLog(`Calling compactClient.compact() with ${compactInput.length} messages, ratio=${COMPACT_RATIO}...`);
        const result = await compactClient!.compact({
          messages: compactInput,
          compressionRatio: COMPACT_RATIO,
          preserveRecent: 0,
        });
        // debugLog(`compactClient.compact() returned: ratio=${result.usage?.compression_ratio}, time=${result.usage?.processing_time_ms}ms, resultMsgs=${result.messages?.length}`);

        const frozen = buildCompactedMessages(toCompact, result);
        const frozenChars = estimateTotalChars(frozen);
        compactionState = {
          frozenMessages: frozen,
          compactedUpToIndex: messages.length - recent.length,
          frozenChars,
        };
        const beforeLen = messages.length;
        output.messages = [...frozen, ...recent];

        // debugLog(`Compact done: ${toCompact.length} msgs → ${frozen.length} frozen (${frozenChars} chars). Messages: ${beforeLen} → ${output.messages.length}`);
        await log(
          "info",
          `Compact: ${toCompact.length} messages → ${frozen.length} frozen (${frozenChars} chars). Messages: ${beforeLen} → ${output.messages.length}. Ratio: ${Math.round(result.usage.compression_ratio * 100)}% kept (${result.usage.processing_time_ms}ms)`,
        );
        await showToast(
          "success",
          `${toCompact.length} messages compacted (${Math.round(result.usage.compression_ratio * 100)}% kept) | ${result.usage.processing_time_ms}ms`,
        );
      } catch (err) {
        // debugLog(`Compact FAILED: ${(err as Error).message}\n${(err as Error).stack}`);
        await log(
          "warn",
          `Compact failed: ${(err as Error).message}. Falling back to native compaction.`,
        );
      }
    };

    // When OpenCode's native compaction triggers, log it
    hooks["experimental.session.compacting"] = async (_input: any, output: any) => {
      await log("debug", "OpenCode native compaction triggered");
      output.context.push(
        "Note: Morph compact plugin is active. Older messages may already be compressed.",
      );
    };
  }

  return hooks;
};

/**
 * Build compacted messages preserving per-message structure.
 * Each original message maps to a compacted version with the same role
 * and a single TextPart containing the compacted content.
 * IDs are deterministic (derived from original message ID) so the
 * frozen block is byte-stable across repeated messages.transform calls.
 */
function buildCompactedMessages(
  originalMessages: { info: Message; parts: Part[] }[],
  result: CompactResult,
): { info: Message; parts: Part[] }[] {
  // Morph compact returns per-message results in result.messages (1:1 mapping).
  // If lengths don't match, fall back to a single message with result.output.
  if (result.messages.length !== originalMessages.length) {
    const template = originalMessages[0]!;
    return [
      {
        info: { ...template.info, role: "user" as const } as Message,
        parts: [
          {
            id: `morph-compact-${template.info.id}`,
            sessionID: template.info.sessionID,
            messageID: template.info.id,
            type: "text" as const,
            text: result.output,
          } as TextPart,
        ],
      },
    ];
  }

  return result.messages.map((compacted, i) => {
    const original = originalMessages[i]!;
    return {
      info: {
        ...original.info,
        role: compacted.role as "user" | "assistant",
      } as Message,
      parts: [
        {
          id: `morph-compact-${original.info.id}`,
          sessionID: original.info.sessionID,
          messageID: original.info.id,
          type: "text" as const,
          text: compacted.content,
        } as TextPart,
      ],
    };
  });
}

export default MorphPlugin;
