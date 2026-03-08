# Morph Tool Selection Policy

This instruction is designed to be always loaded by OpenCode so agents reliably
choose the right Morph tool for each task.

This file is the canonical always-on routing policy for Morph tools. Keep it in
the `instructions` array, not in a skill, so agents do not need an extra load
step before choosing the right tool.

## Code Editing Tool Selection (Critical)

Use the right editing tool for the job. `morph_edit` is not the default for all
edits, but it SHOULD be preferred for edits where partial-snippet merging is
faster or more reliable than exact-string replacement.

### First-Action Policy

| Editing task | First tool | Why |
|---|---|---|
| Large file edits (300+ lines) | `morph_edit` | Avoids fragile exact-string matching |
| Multiple scattered changes in one file | `morph_edit` | Batch edits efficiently |
| Whitespace-sensitive edits | `morph_edit` | More forgiving with formatting/context |
| Complex refactors inside an existing file | `morph_edit` | Better partial-file merge behavior |
| Small exact replacement | `edit` | Faster, local, no API call |
| Single-line rename/fix | `edit` | Simpler exact replacement |
| New file creation | `write` | `morph_edit` only edits existing files |
| Codebase search/exploration | `warpgrep_codebase_search` | Multi-turn agentic search with ripgrep |
| Find where something is defined/used | `warpgrep_codebase_search` | Semantic search across files |
| Exact keyword/function name search | `grep` | Direct ripgrep, no API call |

### When NOT to Use morph_edit

- The change is a small exact `oldString` -> `newString` replacement
- You are creating a brand new file
- The current agent is readonly and cannot edit files
- `MORPH_API_KEY` is not configured; fall back to native `edit`

### WarpGrep Usage

Use `warpgrep_codebase_search` for natural-language, exploratory searches:
- "Find the authentication flow"
- "How does error handling work in the API layer"
- "Where is the database connection configured"

Do NOT use it for exact keyword lookups (function names, variable names, error
strings). Use `grep` or `read` for those.

### Fallback Policy

- If `morph_edit` fails due to API error or timeout, use native `edit`
- If `morph_edit` is blocked in readonly agents, switch to a write-capable agent
- If the change requires replacing the entire file, use `write`
- If `warpgrep_codebase_search` fails, fall back to `grep` + `read`

### Setup Notes

- Preferred instruction path: `~/.config/opencode/instructions/morph-tools.md`
- Packaged fallback path: `~/.config/opencode/node_modules/opencode-morph-fast-apply/instructions/morph-tools.md`
- The tool descriptions are self-contained, but loading this file as an always-on instruction makes tool choice more reliable

### Tool Exposure Requirement

Instruction policy is necessary but not sufficient. The active agent or
sub-agent must also expose tools in its tool manifest.

- If an agent profile sets `morph_edit: false` or omits the tool, the model
  cannot choose Morph even when this instruction is loaded.
- Enable `morph_edit: true` for write-capable agents that should use Morph for
  large or scattered edits.
- Keep readonly agents blocked unless you explicitly want them to edit files.
- `warpgrep_codebase_search` is safe for all agents (read-only operation).

### Anti-Patterns

- Do NOT use `edit` first for large, scattered, or whitespace-sensitive edits
- Do NOT use `morph_edit` for creating new files
- Do NOT force `morph_edit` from readonly agents unless explicitly configured
- Do NOT use `warpgrep_codebase_search` for exact string/keyword lookups
