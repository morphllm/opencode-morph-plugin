# opencode-morph-plugin

[OpenCode](https://opencode.ai) plugin for [Morph](https://morphllm.com). Four tools:

- **Fast Apply** — 10,500+ tok/s code editing with lazy markers
- **WarpGrep** — fast agentic codebase search, +4% on SWE-Bench Pro, -15% cost
- **Public Repo Context** — grounded context search for public GitHub repos without cloning
- **Compaction** — 25,000+ tok/s context compression in sub-2s, +0.6% on SWE-Bench Pro

![WarpGrep SWE-bench Pro Benchmarks](assets/warpgrep-benchmarks.png)

On production repos and SWE-Bench Pro, enabling WarpGrep and compaction improves task accuracy by **6%**, reduces cost, and is net **28% faster**.

---

## Setup

### 1. Get an API key

Sign up at [morphllm.com/dashboard](https://morphllm.com/dashboard/api-keys) and add it to your environment:

```bash
export MORPH_API_KEY="sk-..."
```

### 2. Install the plugin

Recommended: install it as an npm package in your OpenCode config directory.

```bash
cd ~/.config/opencode
npm i @morphllm/opencode-morph-plugin
```

Then register it in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@morphllm/opencode-morph-plugin"],
  "instructions": [
    "node_modules/@morphllm/opencode-morph-plugin/instructions/morph-tools.md"
  ]
}
```

This follows OpenCode's recommended npm plugin flow: declare the plugin in `opencode.json`, and let OpenCode load it from your installed dependencies.

### 3. Add tool routing instructions (recommended)

If you prefer to manage instructions separately, copy the packaged routing policy so the LLM picks the right tool:

```bash
cp instructions/morph-tools.md ~/.config/opencode/instructions/
```

Then reference it in your `opencode.json`:

```json
{
  "instructions": ["~/.config/opencode/instructions/morph-tools.md"]
}
```

---

## Fast Apply (`morph_edit`)

10,500+ tok/s code merging. The LLM writes partial snippets with lazy markers, Morph merges them into the full file.

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

  ┌───────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
  │ code_edit │───>│ Morph API │───>│ safety   │───>│ write to │
  │ + file    │    │ merge     │    │ guards   │    │ disk     │
  └───────────┘    └───────────┘    └──────────┘    └──────────┘
                                    marker leak?
                                    truncation?
```

Safety guards block writes when: no markers on files >10 lines, markers leak into merged output, or merged output loses >60% chars / >50% lines.

## WarpGrep (`warpgrep_codebase_search`)

Fast agentic codebase search. +4% accuracy on SWE-Bench Pro, -15% cost, sub-6s per query.

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

Use for exploratory queries ("how does X work?", "where is Y handled?"). For exact keyword lookup, use `grep` directly.

## Public Repo Context (`warpgrep_github_search`)

Grounded context search for public GitHub repositories. This is the remote-repo sibling of `warpgrep_codebase_search`.

Use it when the code you want to understand is not checked out locally:

```text
owner_repo: owner/repo
search_term: Where is request authentication handled?
```

```text
github_url: https://github.com/owner/repo
search_term: How is retry logic implemented?
```

The tool returns relevant file contexts from Morph's indexed public repo search without cloning the repository into your workspace.

If the repo locator is wrong, the tool now returns a resolver-style failure with `Did you mean ...` suggestions and a concrete retry target. This helps the agent recover when it knows the product or package name but not the canonical GitHub repo.

## State-of-the-Art Compaction

25,000+ tok/s context compression in under 2 seconds. +0.6% on SWE-Bench Pro, where summarization-based compaction methods all hurt performance. Fires at 100k chars (roughly ~25k tokens, depending on content), before OpenCode's built-in auto-compact (95% context window). Results cached per message set.

```
  Every LLM call                      Only fires when context is large

  ┌───────────────────────────────────────────────────┐
  │              Message History (20 msgs)            │
  │  msg1  msg2  msg3  ...  msg14 │ msg15 ... msg20   │
  │  ──────── older ─────────────   ── recent (6) ──  │
  └───────────────────────────────────────────────────┘
                    │                       │
        total > 100k chars?                 │
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

---

## Tool selection guide

| Task | Tool | Why |
|------|------|-----|
| Large file (300+ lines) | `morph_edit` | Partial snippets, no exact matching |
| Multiple scattered changes | `morph_edit` | Batch edits efficiently |
| Small exact replacement | `edit` | Faster, no API call |
| New file creation | `write` | morph_edit only edits existing files |
| Codebase search/exploration | `warpgrep_codebase_search` | Fast agentic search |
| Public GitHub repo understanding | `warpgrep_github_search` | Grounded context from indexed public repos |
| Exact keyword lookup | `grep` | Direct ripgrep, no API call |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MORPH_API_KEY` | required | Your Morph API key |
| `MORPH_EDIT` | `true` | Set `false` to disable Fast Apply |
| `MORPH_WARPGREP` | `true` | Set `false` to disable WarpGrep |
| `MORPH_WARPGREP_GITHUB` | `true` | Set `false` to disable public repo context search |
| `MORPH_COMPACT` | `true` | Set `false` to disable compaction |
| `MORPH_COMPACT_CHAR_THRESHOLD` | `100000` | Char count before compaction triggers |
| `MORPH_COMPACT_RATIO` | `0.3` | Compression ratio (0.05-1.0, lower = more aggressive) |

---

## Development

```bash
bun install
bun test          # 57 tests
bun run typecheck # tsc --noEmit
```

## License

[MIT](LICENSE)
