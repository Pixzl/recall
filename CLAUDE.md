# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

`recall` is an OSS tool that gives Claude Code cross-project, cross-session memory. It indexes everything under `~/.claude/projects/` (JSONL session logs, memory files) into a local SQLite database with vector + full-text search, and exposes that index two ways:

- as an **MCP stdio server** (`recall mcp`) that Claude Code calls via `recall_search` and `recall_get`
- as a **CLI** (`recall search`, `recall index`) that the human user runs directly

There is no remote service. No telemetry. The index lives at `~/.recall/index.db` (perms `0600`).

## Commands

```bash
npm install            # one-time
npm run build          # tsc → ./dist
npm run dev            # tsx src/cli/index.ts ... (skip the build step during iteration)
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:watch     # watch mode
npx vitest run test/redact.test.ts        # single test file
npx vitest run -t "masks Anthropic keys"  # single test by name
```

End-to-end smoke (after `npm run build`):

```bash
node dist/cli/index.js index                  # full reindex; first run downloads ~120 MB model
node dist/cli/index.js search "..." -n 5      # hybrid search
node dist/cli/index.js mcp                    # stdio MCP server (for `claude mcp add`)
```

To smoke-test against fixtures without touching real `~/.claude/`, set `HOME` to a temp dir containing a fake `.claude/projects/<id>/<session>.jsonl` tree — every path resolves through `homedir()` in `src/indexer/sources.ts` and `src/store/paths.ts`.

## Architecture

Data flows in one direction:

```
~/.claude/projects/*/{*.jsonl, memory/*.md}
       │
       ▼  enumerateProjects() walks the tree; project-id is a URL-encoded
       │  absolute path (decodeProjectId reverses it best-effort)
       │
       ▼  parseSessionFile() / parseMemoryFile() — async generators yielding Chunk objects
       │
       ▼  redact() runs BEFORE the chunk lands in the store. The schema only
       │  has `text_redacted`; raw text is never persisted.
       │
       ▼  embedPassagesBatched() — multilingual-e5-small in-process via
       │  @huggingface/transformers (no Ollama, no API key)
       │
       ▼  Store.upsertChunkBatch(): chunks + chunks_fts + vectors in one tx
```

Search is **hybrid**: vector ANN (sqlite-vec `vec0`) ∪ BM25 (FTS5) fused via Reciprocal Rank Fusion (`fusionK = 60`) in `Store.search()`. The CLI and MCP server share that one entry point.

### Chunking unit

A chunk is **one conversation turn**, defined as: a real user message + everything that follows it (assistant text, `tool_use`, and the `tool_result`-bearing user messages that respond to those tool calls) until the next real user message. This is the central design choice — single messages are too small (tool_results have no context), whole sessions are too coarse. See `parseSessionFile` in `src/indexer/jsonl.ts`. Tool-result-only user messages are detected via `isRealUserMessage()` and merged into the running turn rather than starting a new one.

### Two faces, one core

`src/mcp/server.ts` and `src/cli/index.ts` are thin wrappers. They both construct a `Store`, call `embedQuery` for searches, and render results differently. Anything that affects retrieval semantics belongs in `Store` or `embed`, not in the wrappers.

## Gotchas worth knowing

- **sqlite-vec rowid binding must be BigInt.** Plain JS numbers fail with `"Only integers are allows for primary key values on vectors"`. `Store.upsertChunk` and the `embedding MATCH ?` query both convert. Don't change this without re-testing the smoke flow.
- **Redaction pattern order matters.** `anthropic_key` must run before `openai_key`, because the OpenAI regex would otherwise consume `sk-ant-…`. The OpenAI pattern uses a `(?!ant-)` lookahead as a second guard.
- **FTS5 is self-contained, not `content='chunks'`.** The external-content mode requires triggers; we deliberately keep it simple at the cost of duplicate text storage in the FTS index.
- **Embedding model is stamped in the `meta` table.** Switching the default in `src/embed/local.ts` requires `recall index --reset`. The store throws on dim/model mismatch at construction time.
- **Base64 image content gets stripped to `[image]` before chunking.** Real JSONL contains inline base64 that would otherwise blow up the DB.
- **Project-id ↔ path roundtrip is lossy** for paths containing `-`. Always store the original project_id; treat the decoded `projectPath` as a hint, never a key.

## Testing notes

The tests are in `test/`, not `src/`. `tsconfig.json` excludes `test/` from the build but vitest picks them up via its own `vitest.config.ts`. Tests for the JSONL parser write fixtures to `tmpdir()`; nothing touches `~/.claude/` during `npm test`.
