# MemoryHub Memory Protocol

> Usage protocol for agents connected to the MemoryHub brain (gbrain @ `~/.gbrain`).
> This is about **using** memory — not developing Gbrain (that's AGENTS.md/CLAUDE.md).
> Any agent with the brain connected (Claude Code, Codex, opencode, omp) should
> follow these three rules.

## The three rules (B-tier: search-first, write-back, cite)

**1. Search first.** Before answering any question about people, companies,
decisions, projects, or past context, call `search` (or `query` for a
synthesized answer) against the brain. Never answer from memory or ask the
operator "who is X?" / "what did we decide about Y?" before searching.

**2. Write back.** When the operator makes a decision, mentions a new person or
company, or lands on an idea worth keeping, write it to the brain with
`put_page`. Follow the slug conventions:
- people → `people/<name>`
- companies → `companies/<name>`
- decisions → `decisions/<topic>`
- general notes → `notes/<topic>`
One insight, one page. Include frontmatter `type:` and a date.

**3. Cite.** When you answer from the brain, name the page you used.

## Write format (via MCP `put_page`)

```markdown
---
type: decision | note | project | meeting | person | company
date: YYYY-MM-DD
---

# Title

The insight, in one or two sentences. Facts, not fluff.
```

## What counts as "worth keeping" (B-tier gate)

- **Save**: decisions (even reversals), new people/companies with role, project
  outcomes, key technical choices, open questions with owners.
- **Don't save**: trivial progress, chit-chat, transient state, anything the
  operator would find noise in a search result.

## Source marking

Every write over MCP is stamped `source_kind: mcp:put_page` server-side —
clients cannot forge it. The operator can tell which agent wrote what.
Historical pages from the hermes import are `source_kind: legacy-hermes`.

## Connection

- HTTP MCP server: `http://127.0.0.1:3131/mcp`; each agent supplies its own
  bearer token in its own config (Claude Code: `gbrain-memoryhub` in
  `~/.claude.json`, HTTP only).
- HTTP 401 `invalid_token` = server up, token mismatch: fix the agent config.
- Connection refused = server down: `cd ~/workspace/codex/memoryhub && GBRAIN_HOME=~ bun run src/cli.ts serve --http`
