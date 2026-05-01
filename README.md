# opencode-morph-plugin

Source repository: https://github.com/morphllm/opencode-morph-plugin

[OpenCode](https://opencode.ai) plugin for [Morph](https://morphllm.com). Four tools:

- **Fast Apply** — 10,500+ tok/s code editing with lazy markers
- **WarpGrep** — fast agentic codebase search, +4% on SWE-Bench Pro, -15% cost
- **Public Repo Context** — grounded context search for public GitHub repos without cloning
- **Compaction** — 25,000+ tok/s context compression in sub-2s, +0.6% on SWE-Bench Pro

![WarpGrep SWE-bench Pro Benchmarks](assets/warpgrep-benchmarks.png)

On production repos and SWE-Bench Pro, enabling WarpGrep and compaction improves task accuracy by **6%**, reduces cost, and is net **28% faster**.

---

## Quick Start

### 1. Get a Morph API key

Sign up at [morphllm.com/dashboard](https://morphllm.com/dashboard/api-keys) and export it:

```bash
export MORPH_API_KEY="sk-..."
```

Add this to your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) so it persists.

### 2. Install the plugin

```bash
cd ~/.config/opencode
bun i @morphllm/opencode-morph-plugin
```

### 3. Register in opencode.json

Edit `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@morphllm/opencode-morph-plugin"],
  "instructions": [
    "node_modules/@morphllm/opencode-morph-plugin/instructions/morph-tools.md"
  ]
}
```

### 4. Start OpenCode

```bash
opencode
```

You should see `morph_edit`, `warpgrep_codebase_search`, and `warpgrep_github_search` in the available tools. Compaction runs automatically in the background.

---

## Compaction

Context compression via the Morph Compact API. In current OpenCode 1.14.x releases, only OpenCode native compaction writes the persisted summary message that future turns and the sidebar use. This plugin handles that path by pre-compressing the selected history with Morph before OpenCode's native compaction model writes its summary.

### How it works

1. When OpenCode native compaction starts, the plugin adds Morph-aware instructions to the compaction prompt
2. The following `experimental.chat.messages.transform` hook receives the history OpenCode selected for compaction
3. Morph compresses that selected history to one summary message before OpenCode sends it to the compaction model
4. OpenCode then persists its normal compaction summary and emits `session.compacted`

The Morph toast means the compaction input was compressed for OpenCode. Seeing OpenCode native compaction immediately after the toast is expected; that is the mechanism that persists the summary. The "Context: X tokens" number in the sidebar is based on OpenCode's stored assistant token usage, so it updates after OpenCode finishes compaction and/or after the next assistant response, not at the instant the Morph toast appears.

### Configuring the compaction threshold

For non-native transform calls, the plugin uses a default threshold of **70% of the model's context window**. With a 1M token model, that is roughly 700k estimated tokens. You can override this with a fixed token limit:

```bash
# Compact when conversation exceeds 20,000 tokens
export MORPH_COMPACT_TOKEN_LIMIT=20000
```

For aggressive compaction during testing:

```bash
export MORPH_COMPACT_TOKEN_LIMIT=5000
```

### Verifying compaction is working

Check the OpenCode log files in `~/.local/share/opencode/log/`. Look for entries with `service=morph`:

```bash
grep "service=morph" ~/.local/share/opencode/log/*.log | grep -i compact
```

When compaction fires, you'll see entries like:

```
INFO service=morph OpenCode native compaction triggered; Morph will pre-compress selected history and OpenCode will persist the summary.
INFO service=morph Native compaction: compressing 42 selected messages (210137 chars) before OpenCode writes its persisted summary.
INFO service=morph Native compaction: Morph compressed 42 messages -> 1 summary (15142 chars). Ratio: 20% kept (244ms)
INFO service=morph OpenCode native compaction completed; cleared Morph transient compaction state.
```

You'll also see a toast notification in the OpenCode UI:

```
Prepared OpenCode compaction with Morph (20% kept) | 244ms
```

If OpenCode native compaction is not involved and a future OpenCode version calls `experimental.chat.messages.transform` before normal LLM turns, the plugin still has the older proactive path. In that path, subsequent LLM calls can show:

```
INFO service=morph Under threshold - reusing frozen block. Messages: 5 -> 5
```

---

## Tools

### Fast Apply (`morph_edit`)

10,500+ tok/s code merging. The LLM writes partial snippets with lazy markers (`// ... existing code ...`), Morph merges them into the full file.

Best for large files (300+ lines) and multiple scattered changes. For small exact replacements, use OpenCode's built-in `edit` tool.

### WarpGrep (`warpgrep_codebase_search`)

Fast agentic codebase search. Runs multi-turn ripgrep + file reads to find relevant code contexts. Sub-6s per query. Best for exploratory queries ("how does X work?", "where is Y handled?").

### Public Repo Context (`warpgrep_github_search`)

Search public GitHub repositories without cloning. Pass an `owner/repo` or GitHub URL and a search query. Returns relevant file contexts from Morph's indexed public repo search.

---

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `MORPH_API_KEY` | *required* | Your Morph API key |
| `MORPH_COMPACT_TOKEN_LIMIT` | auto (70% of model window) | Fixed token threshold for compaction |
| `MORPH_COMPACT_CONTEXT_THRESHOLD` | `0.7` | Fraction of model context window to trigger compaction (used when `TOKEN_LIMIT` is not set) |
| `MORPH_COMPACT_PRESERVE_RECENT` | `1` | Number of recent messages to keep uncompacted |
| `MORPH_COMPACT_RATIO` | `0.3` | Target compression ratio (0.05-1.0, lower = more aggressive) |
| `MORPH_COMPACT` | `true` | Set `false` to disable compaction |
| `MORPH_EDIT` | `true` | Set `false` to disable Fast Apply |
| `MORPH_WARPGREP` | `true` | Set `false` to disable WarpGrep |
| `MORPH_WARPGREP_GITHUB` | `true` | Set `false` to disable public repo search |

---

## Development

```bash
bun install
bun test
bun run build
bun run typecheck
```

To test locally with OpenCode, symlink the plugin:

```bash
rm -rf ~/.config/opencode/node_modules/@morphllm/opencode-morph-plugin
ln -s /path/to/this/repo ~/.config/opencode/node_modules/@morphllm/opencode-morph-plugin
bun run build  # rebuild after changes
```

## License

[MIT](LICENSE)
