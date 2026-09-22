## ClawMem

Architecture: hooks (automatic, ~90%) + MCP tools (explicit, ~10%).

Vault: `~/.cache/clawmem/index.sqlite` | Config: `~/.config/clawmem/index.yml`

### Escalation Gate (3 rules — ONLY escalate to MCP tools when one fires)

1. **Low-specificity injection** — `<vault-context>` is empty or lacks the specific fact needed
2. **Cross-session question** — "why did we decide X", "what changed since last time"
3. **Pre-irreversible check** — before destructive or hard-to-reverse changes

### Tool Routing (once escalated)

**Preferred:** `mcp__clawmem__memory_retrieve(query)` — auto-classifies and routes to the optimal backend.

**Direct routing** (when calling specific tools):

    "why did we decide X"         → mcp__clawmem__intent_search(query)          NOT mcp__clawmem__query()
    "what happened last session"  → mcp__clawmem__session_log()                 NOT mcp__clawmem__query()
    "what else relates to X"      → mcp__clawmem__find_similar(file)            NOT mcp__clawmem__query()
    Complex multi-topic           → mcp__clawmem__query_plan(query)             NOT mcp__clawmem__query()
    General recall                → mcp__clawmem__query(query, compact=true)
    Keyword spot check            → mcp__clawmem__search(query, compact=true)
    Conceptual/fuzzy              → mcp__clawmem__vsearch(query, compact=true)
    Full content                  → mcp__clawmem__multi_get("path1,path2")
    Lifecycle health              → mcp__clawmem__lifecycle_status()
    Stale sweep                   → mcp__clawmem__lifecycle_sweep(dry_run=true)
    Restore archived              → mcp__clawmem__lifecycle_restore(query)

ALWAYS `compact=true` first → review → `mcp__clawmem__multi_get` for full content.

### Proactive Use (no escalation gate needed)

- User says "remember this" / critical decision made → `mcp__clawmem__memory_pin(query)` immediately
- User corrects a misconception → `mcp__clawmem__memory_pin(query)` the correction
- `<vault-context>` surfaces irrelevant/noisy content → `mcp__clawmem__memory_snooze(query, until)` for 30 days
- Need to correct a memory → `mcp__clawmem__memory_forget(query)`
- After bulk ingestion → `mcp__clawmem__build_graphs`

### Anti-Patterns

- Do NOT use `mcp__clawmem__query()` for everything — match query type to tool, or use `mcp__clawmem__memory_retrieve`
- Do NOT call mcp__clawmem__query/mcp__clawmem__intent_search every turn — 3 rules above are the only gates
- Do NOT re-search what's already in `<vault-context>`
- Do NOT pin everything — pin is for persistent high-priority items, not routine decisions
- Do NOT forget memories to "clean up" — let confidence decay handle it
- Do NOT wait for curator to pin decisions — pin immediately when critical

For detailed operating guidance (escalation gate, tool routing, query-optimization levers, pipeline behavior, composite scoring, lifecycle), load the registered clawmem skill with the skill tool.
