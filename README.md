# opencode-morph-plugin

Three tools that make [OpenCode](https://opencode.ai) agents faster, cheaper, and more accurate.

![WarpGrep SWE-bench Pro Benchmarks](assets/warpgrep-benchmarks.png)

On production repos and SWE-Bench Pro, enabling WarpGrep and compaction improves task accuracy by **6%**, reduces cost, and is net **28% faster**.

## Quick start

```bash
# 1. Set your API key (get one at morphllm.com/dashboard)
export MORPH_API_KEY="sk-..."

# 2. Add the plugin
ln -s /path/to/opencode-morph-plugin/index.ts ~/.config/opencode/plugin/morph.ts

# 3. Add the SDK dependency
cat > ~/.config/opencode/package.json << 'EOF'
{ "dependencies": { "@morphllm/morphsdk": "^0.2.134" } }
EOF

# 4. (Recommended) Add tool routing instructions
cp instructions/morph-tools.md ~/.config/opencode/instructions/
```

OpenCode runs `bun install` at startup. That's it.

Or, when published as an npm package:

```json
{ "plugin": ["opencode-morph-plugin"] }
```

---

## What's inside

### Fast Apply (`morph_edit`)

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

  ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
  │ code_edit │───>│ Morph API │───>│ safety   │───>│ write to │
  │ + file   │    │ merge     │    │ guards   │    │ disk     │
  └──────────┘    └───────────┘    └──────────┘    └──────────┘
                                    marker leak?
                                    truncation?
```

Safety guards block writes when: no markers on files >10 lines, markers leak into merged output, or merged output loses >60% chars / >50% lines.

### WarpGrep (`warpgrep_codebase_search`)

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

Use for exploratory queries. For exact keyword lookup, use `grep` directly.

### State-of-the-Art Compaction

25,000+ tok/s context compression. +0.6% on SWE-Bench Pro, where summarization-based compaction methods all hurt performance. Fires at 140k chars (~35k tokens), before OpenCode's built-in auto-compact (95% context window). Results cached per message set.

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

---

## Tool selection guide

| Task | Tool | Why |
|------|------|-----|
| Large file (300+ lines) | `morph_edit` | Partial snippets, no exact matching |
| Multiple scattered changes | `morph_edit` | Batch edits efficiently |
| Small exact replacement | `edit` | Faster, no API call |
| New file creation | `write` | morph_edit only edits existing files |
| Codebase search/exploration | `warpgrep_codebase_search` | Fast agentic search |
| Exact keyword lookup | `grep` | Direct ripgrep, no API call |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MORPH_API_KEY` | required | Your Morph API key |
| `MORPH_EDIT` | `true` | Set `false` to disable Fast Apply |
| `MORPH_WARPGREP` | `true` | Set `false` to disable WarpGrep |
| `MORPH_COMPACT` | `true` | Set `false` to disable compaction |
| `MORPH_COMPACT_CHAR_THRESHOLD` | `140000` | Char count before compaction triggers |
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
