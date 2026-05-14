# Contributing to recall

Thanks for your interest in improving recall! This is a small, focused project — issues and PRs are welcome.

## Development setup

Requires Node 20+.

```bash
npm install        # one-time
npm run dev        # run the CLI without building: tsx src/cli/index.ts ...
npm run build      # tsc → ./dist
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run test:watch # vitest in watch mode
```

Run a single test:

```bash
npx vitest run test/redact.test.ts
npx vitest run -t "masks Anthropic keys"
```

To smoke-test against fixtures without touching your real `~/.claude/`, point `HOME` at a
temp dir containing a fake `.claude/projects/<id>/<session>.jsonl` tree — every path
resolves through `homedir()`.

## Project layout

- `src/indexer/` — parse, chunk, redact session/memory files
- `src/embed/` — in-process embeddings
- `src/store/` — SQLite + sqlite-vec + FTS5, hybrid search
- `src/mcp/` — MCP stdio server
- `src/cli/` — CLI entry point
- `test/` — vitest tests (synthetic fixtures only; nothing touches real `~/.claude/`)

See `CLAUDE.md` for architecture notes and gotchas.

## Before you open a PR

- `npm run typecheck`, `npm test`, and `npm run build` all pass
- New behavior is covered by a test
- **Anything that ingests user text must go through `redact()` first** — raw text is never
  persisted. This is the core privacy guarantee; please don't regress it.
- Keep `src/mcp/server.ts` and `src/cli/index.ts` thin — retrieval semantics belong in
  `Store` / `embed`

## Reporting bugs

Open an issue with steps to reproduce. Since recall indexes your local Claude Code data,
**never paste real session content or secrets** into an issue — redact or use a minimal
synthetic example.
