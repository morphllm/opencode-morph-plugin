# opencode-morph-plugin

OpenCode plugin for [Morph SDK](https://morphllm.com) — fast apply, WarpGrep codebase search, and proactive compaction.

> **Production results:** On production repos and SWE-Bench Pro, enabling WarpGrep and compaction improves task performance by **6%** while using fewer frontier model tokens, costing less, and being net faster by around **28%**.

## Features

- **Fast Apply** (`morph_edit`) — 10,500+ tok/s code editing with lazy edit markers
- **WarpGrep** (`warpgrep_codebase_search`) — fast agentic codebase search via ripgrep (+4% SWE-Bench Pro, -15% cost)
- **Proactive Compaction** — auto-compresses older messages via Morph compact before context overflow
- **Safety guards** — pre-flight marker check, marker leakage detection, truncation detection
- **Custom TUI** — branded titles like `Morph: src/file.ts +15/-3 (450ms)` and `WarpGrep: 5 contexts`
- **Streaming progress** — WarpGrep shows turn-by-turn progress in the TUI during search

## Installation

### Option A: Global plugin directory

Copy or symlink the plugin into `~/.config/opencode/plugin/`:

```bash
ln -s /path/to/opencode-morph-plugin/index.ts ~/.config/opencode/plugin/morph.ts
```

Add the SDK dependency to `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@morphllm/morphsdk": "^0.2.134"
  }
}
```

OpenCode runs `bun install` at startup to install these.

### Option B: npm plugin (when published)

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-morph-plugin"]
}
```

### Always-on instruction (recommended)

For more reliable tool selection, load the packaged routing policy:

```json
{
  "instructions": [
    "~/.config/opencode/instructions/morph-tools.md"
  ]
}
```

Copy `instructions/morph-tools.md` to `~/.config/opencode/instructions/` or point at the installed package path.

### Set your API key

Get an API key at [morphllm.com/dashboard](https://morphllm.com/dashboard/api-keys):

```bash
export MORPH_API_KEY="sk-your-key-here"
```

## How it works

### morph_edit (Fast Apply)

```
  LLM generates partial edit         Morph merges into full file
  with lazy markers                  at 10,500+ tok/s

  // ... existing code ...           function validateToken(token) {
  function validateToken(token) {      const decoded = jwt.verify(token);
    if (!token) {             ──>      if (!token) {
      throw new Error("...");            throw new Error("...");
    }                                  }
    // ... existing code ...           return decoded;
  }                                  }
  // ... existing code ...           export default validateToken;

  ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
  │ code_edit │───>│ Morph API │───>│ safety   │───>│ write to │
  │ + file   │    │ merge     │    │ guards   │    │ disk     │
  └──────────┘    └───────────┘    └──────────┘    └──────────┘
                                    marker leak?
                                    truncation?
```

### warpgrep_codebase_search (WarpGrep)

```
  Query                               Fast agentic search

  "How does auth                     Turn 1: ripgrep "auth" "token" "jwt"
   middleware work?"                 Turn 2: read src/middleware/auth.ts
           │                         Turn 3: ripgrep "verifyToken"
           v                         Turn 4: read src/utils/jwt.ts
  ┌──────────────┐                            │
  │ WarpGrep     │    ┌─────────┐             v
  │ Agent        │───>│ ripgrep │    ┌──────────────────┐
  │ (multi-turn) │    │ read    │    │ 5 file contexts  │
  │              │───>│ ls      │───>│ with line ranges │
  └──────────────┘    └─────────┘    └──────────────────┘
    4 turns, sub-6s                   src/middleware/auth.ts:15-42
                                      src/utils/jwt.ts:1-28
                                      ...
```

### Proactive Compaction (Compact)

```
  Every LLM call                      Only fires when context is large

  ┌───────────────────────────────────────────────────┐
  │              Message History (20 msgs)             │
  │  msg1  msg2  msg3  ...  msg14 │ msg15 ... msg20   │
  │  ──────── older ─────────────   ── recent (6) ──  │
  └───────────────────────────────────────────────────┘
                    │                       │
        total > 140k chars?                  │
                    │                       │
                    v                       │
          ┌─────────────────┐               │
          │ Morph Compact   │               │
          │ API (~2s)       │               │
          │ 30% kept        │               │
          └────────┬────────┘               │
                   │                        │
                   v                        v
  ┌───────────────────────────────────────────────────┐
  │  [compacted summary]   │ msg15  msg16 ... msg20   │
  │  ────── 1 msg ───────    ──── recent (6) ──────   │
  └───────────────────────────────────────────────────┘
              7 messages sent to LLM
              (cached for subsequent calls)
```

## Usage

### morph_edit

The LLM uses `morph_edit` for efficient partial file edits with lazy markers:

```
morph_edit({
  target_filepath: "src/auth.ts",
  instructions: "I am adding error handling for invalid tokens",
  code_edit: `// ... existing code ...
function validateToken(token) {
  if (!token) {
    throw new Error("Token is required");
  }
  // ... existing code ...
}
// ... existing code ...`
})
```

### warpgrep_codebase_search

Fast agentic codebase search. The agent runs ripgrep, reads files, and lists directories across multiple turns to find relevant code. On SWE-Bench Pro, WarpGrep alone improves performance by 4% and decreases costs by 15%.

```
warpgrep_codebase_search({
  search_term: "How does the authentication middleware validate JWT tokens"
})
```

Returns file sections with line numbers. Use for exploratory queries. For exact keyword lookup, prefer `grep` directly.

### Tool selection guide

| Task | Tool | Why |
|------|------|-----|
| Large file (300+ lines) | `morph_edit` | Partial snippets, no exact matching |
| Multiple scattered changes | `morph_edit` | Batch edits efficiently |
| Small exact replacement | `edit` | Faster, no API call |
| New file creation | `write` | morph_edit only edits existing files |
| Codebase search/exploration | `warpgrep_codebase_search` | Fast agentic search |
| Exact keyword lookup | `grep` | Direct ripgrep, no API call |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MORPH_API_KEY` | (required) | Your Morph API key |
| `MORPH_EDIT` | `true` | Set to `false` to disable `morph_edit` |
| `MORPH_WARPGREP` | `true` | Set to `false` to disable `warpgrep_codebase_search` |
| `MORPH_COMPACT` | `true` | Set to `false` to disable proactive compaction |
| `MORPH_COMPACT_CHAR_THRESHOLD` | `140000` | Character count before compaction triggers |
| `MORPH_COMPACT_RATIO` | `0.3` | Compression ratio (0.05-1.0, lower = more aggressive) |

## Safety guards

The plugin blocks unsafe edits before writing files:

- **Pre-flight marker check** — if `code_edit` has no markers and the file is >10 lines, the edit is blocked to prevent accidental full-file replacement
- **Marker leakage** — if the merged output contains `// ... existing code ...` but the original file didn't, the merge model failed. Write is aborted.
- **Truncation detection** — if merged output loses >60% characters AND >50% lines, the model likely failed to expand markers. Write is aborted.

All guards return detailed errors with recovery options (retry with tighter anchors, use native `edit`, split into smaller edits).

## Proactive compaction

The plugin intercepts OpenCode's message pipeline via the `experimental.chat.messages.transform` hook. When total message content exceeds ~140k chars (~35k tokens), older messages are compressed through Morph's compact API before the LLM sees them.

How it works:
1. On each LLM call, the plugin estimates total content size across all messages
2. If above threshold, older messages (everything except the last N) are serialized and sent to Morph compact
3. The compacted result replaces the older messages in the context window
4. Original messages stay in the database untouched
5. Results are cached by message IDs to avoid redundant API calls

This preempts OpenCode's built-in auto-compact (which triggers at 95% context window) and produces higher-quality compression via Morph's specialized compaction model.

## Architecture

Uses the [Morph SDK](https://www.npmjs.com/package/@morphllm/morphsdk) (`MorphClient` + `WarpGrepClient` + `CompactClient`):

- `MorphClient` — shared config (API key, timeout, retries) for FastApply
- `WarpGrepClient` — separate client with its own timeout for multi-turn search
- `CompactClient` — separate client for proactive context compaction
- `morph.fastApply.applyEdit()` — code-in/code-out merge, returns `{ mergedCode, udiff, changes }`
- `warpGrep.execute({ streamSteps: true })` — AsyncGenerator yielding turn-by-turn progress
- `compactClient.compact()` — message compression with configurable ratio and recent preservation

## Development

```bash
bun install
bun test          # 57 tests
bun run typecheck # tsc --noEmit
```

## License

[MIT](LICENSE)
