# opencode-morph-plugin

OpenCode plugin for [Morph SDK](https://morphllm.com) — fast apply, WarpGrep codebase search, and shell env integration.

## Features

- **Fast Apply** (`morph_edit`) — 10,500+ tok/s code editing with lazy edit markers
- **WarpGrep** (`warpgrep_codebase_search`) — multi-turn agentic codebase search via ripgrep
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

Natural language codebase search. Multi-turn: the agent runs ripgrep, reads files, and lists directories across multiple turns to find relevant code.

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
| Semantic codebase search | `warpgrep_codebase_search` | Multi-turn agentic search |
| Exact keyword lookup | `grep` | Direct ripgrep, no API call |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MORPH_API_KEY` | (required) | Your Morph API key |
| `MORPH_API_URL` | `https://api.morphllm.com` | API endpoint |
| `MORPH_TIMEOUT` | `30000` | Fast Apply timeout in ms |
| `MORPH_WARP_GREP_TIMEOUT` | `60000` | WarpGrep timeout in ms |
| `MORPH_ALLOW_READONLY_AGENTS` | `false` | Allow morph_edit in plan/explore modes |

## Safety guards

The plugin blocks unsafe edits before writing files:

- **Pre-flight marker check** — if `code_edit` has no markers and the file is >10 lines, the edit is blocked to prevent accidental full-file replacement
- **Marker leakage** — if the merged output contains `// ... existing code ...` but the original file didn't, the merge model failed. Write is aborted.
- **Truncation detection** — if merged output loses >60% characters AND >50% lines, the model likely failed to expand markers. Write is aborted.

All guards return detailed errors with recovery options (retry with tighter anchors, use native `edit`, split into smaller edits).

## Architecture

Uses the [Morph SDK](https://www.npmjs.com/package/@morphllm/morphsdk) (`MorphClient` + `WarpGrepClient`):

- `MorphClient` — shared config (API key, timeout, retries) for FastApply
- `WarpGrepClient` — separate client with its own timeout for multi-turn search
- `morph.fastApply.applyEdit()` — code-in/code-out merge, returns `{ mergedCode, udiff, changes }`
- `warpGrep.execute({ streamSteps: true })` — AsyncGenerator yielding turn-by-turn progress

## Development

```bash
bun install
bun test          # 34 tests
bun run typecheck # tsc --noEmit
```

## License

[MIT](LICENSE)
