# recall

[![CI](https://github.com/Pixzl/recall/actions/workflows/ci.yml/badge.svg)](https://github.com/Pixzl/recall/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Shared memory for Claude Code. An MCP server **and** a CLI that index your local Claude Code sessions and memory across every project — so Claude (and you) can find what was already figured out.

![recall searching past Claude Code sessions from the terminal](https://raw.githubusercontent.com/Pixzl/recall/main/assets/demo.gif)

## Why

Claude Code already saves every session to disk — but only *within* one project. Whatever you worked out in another repo three weeks ago is invisible from where you are now.

`recall` makes that history searchable across **every** project, and hands Claude a tool to search it mid-conversation:

> *"Have we hit this auth bug before?"* — Claude actually checks, instead of guessing.

It builds a local, on-disk SQLite index over the data Claude Code already keeps in `~/.claude/`:

- past sessions (`projects/*/<uuid>.jsonl`)
- memory files (`projects/*/memory/*.md`)

and exposes it two ways:

1. an **MCP server** Claude Code can call (`recall_search`, `recall_get`)
2. a **CLI** you run yourself: `recall search "..."`

100 % local. No telemetry. Secrets are redacted before they hit the index.

## Install

```bash
npm install -g pixzl
# or run via npx without installing:
npx pixzl --help
```

> The npm package is named `pixzl`; the command it installs is `recall`.

Node 20+ is required (you already have it if Claude Code is installed).

> **Heads up — the first `recall index` is the slow one.** It downloads a ~120 MB embedding model once, then indexes your whole `~/.claude/projects/` tree (5–15 min on a recent Mac). Every run after that is incremental and fast — and all of it happens locally, nothing is uploaded.

## Quickstart

```bash
# 1. Build the index (first run is slow — see the note above).
recall index

# 2. Search from the terminal
recall search "auth pattern across projects"

# 3. Register the MCP server with Claude Code (one-time)
claude mcp add recall -- npx pixzl mcp
```

After registration, Claude Code can call `recall_search` and `recall_get` in any new session. Try asking: *"Have we discussed this auth pattern before? Use recall_search to check."*

### What a search looks like

```
$ recall search "how did we handle rate limiting"

1.000  session 2026-03-12  ~/dev/my-api
  s_d84edb695ee7...
  …token bucket lets a client spend accumulated capacity, which matches
  how real clients behave. Bucket size = burst allowance, refill rate…

0.984  memory  2026-02-28  ~/dev/my-api
  m_9fc1cf0f552a...
  [memory:decisions.md] ## Rate limiting — token bucket per API key, 60
  capacity, 1/sec refill, backed by Redis. Sliding window was rejected…
```

## What gets indexed

| Source                                  | Status |
| --------------------------------------- | ------ |
| `~/.claude/projects/*/*.jsonl`          | ✅ v1  |
| `~/.claude/projects/*/memory/*.md`      | ✅ v1  |
| `CLAUDE.md` in each project working dir | 🔜 v2  |
| `~/.claude/file-history/`               | 🔜 v2  |

Sessions are chunked **per conversation turn** (one user message + the assistant's reply chain until the next user message). That's the right unit for "what did we figure out about X" — single messages are too small, whole sessions too coarse.

## MCP tools

| Tool             | What it does                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `recall_search`  | Hybrid (vector + BM25) search. Returns short snippets + stable IDs.                                           |
| `recall_get`     | Fetch a chunk by ID with surrounding turns from the same session. Use after `recall_search` to expand context. |

## Privacy

- The index lives at `~/.recall/index.db` with `0600` permissions.
- Before any text enters the database, secrets matching common patterns (OpenAI/Anthropic API keys, AWS access keys, GitHub tokens, Slack tokens, PEM private keys, `Bearer ...`, `password=...`) are replaced with `[REDACTED:<type>]`. No raw secret material is embedded or stored.
- Default embedding model runs **in-process** via [transformers.js](https://github.com/huggingface/transformers.js). No data leaves your machine.
- No telemetry. No phone-home. No automatic updates.

## CLI reference

```
recall index [--reset]            # build / refresh the index
recall search <query> [-n LIMIT]  # search hybrid semantic + keyword
  [-k session|memory]             #   filter by source kind
recall mcp                        # run the MCP stdio server (for Claude Code)
```

## How it works (architecture)

```
~/.claude/projects/*/*.jsonl  ─┐
~/.claude/projects/*/memory/*.md ─┤   parse → chunk → redact → embed
                                  ▼
              ~/.recall/index.db (SQLite + sqlite-vec + FTS5)
                                  ▼
                ┌────────────────┴─────────────────┐
                ▼                                  ▼
       MCP server (stdio)                   CLI / TUI
       Claude calls recall_*                 you call recall search
```

Hybrid retrieval = vector ANN (sqlite-vec) ∪ BM25 (FTS5) fused via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf). Hands down the most robust setup for code-ish content.

## Scope (v1 → v2)

**v1 (now):** indexing, hybrid search, MCP server, CLI search.
**v2 (next):** file watcher / incremental tail, `CLAUDE.md` indexing, `file-history` joins, Ink-based TUI with clipboard yank, `.recallignore`, `recall doctor`, `recall purge`.

## License

MIT.
