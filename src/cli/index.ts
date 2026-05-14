#!/usr/bin/env node
import { Command } from "commander";
import { Store } from "../store/sqlite.js";
import { DEFAULT_DB_PATH } from "../store/paths.js";
import { enumerateProjects } from "../indexer/sources.js";
import { parseSessionFile } from "../indexer/jsonl.js";
import { parseMemoryFile } from "../indexer/memory.js";
import {
  EMBEDDING_DIM,
  embedPassagesBatched,
  embedQuery,
  getModelId,
  warmup,
} from "../embed/local.js";
import { runMcpServer } from "../mcp/server.js";
import { stat } from "node:fs/promises";
import type { Chunk } from "../types.js";

const BATCH_SIZE = 32;

async function indexCommand(opts: { reset: boolean; dbPath: string }): Promise<void> {
  const store = new Store({
    path: opts.dbPath,
    embeddingDim: EMBEDDING_DIM,
    modelId: getModelId(),
  });
  if (opts.reset) {
    process.stderr.write("Resetting index…\n");
    store.reset();
  }
  process.stderr.write("Loading embedding model (first run downloads ~120 MB)…\n");
  await warmup();
  process.stderr.write("Embedding model ready.\n");

  const projects = await enumerateProjects();
  process.stderr.write(`Found ${projects.length} projects.\n`);

  const buffer: Chunk[] = [];
  let totalChunks = 0;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const embeddings = await embedPassagesBatched(
      buffer.map((c) => c.textRedacted),
      BATCH_SIZE,
    );
    const items = buffer.map((chunk, i) => ({ chunk, embedding: embeddings[i] }));
    store.upsertChunkBatch(items);
    totalChunks += buffer.length;
    buffer.length = 0;
    process.stderr.write(`  upserted batch | total chunks: ${totalChunks}\r`);
  }

  for (const project of projects) {
    process.stderr.write(`\n[${project.projectId}]\n`);
    for (const session of project.sessionFiles) {
      try {
        const stats = await stat(session);
        const existing = store.getSource(session);
        if (existing && existing.mtime === stats.mtimeMs && existing.size === stats.size) {
          continue;
        }
        for await (const chunk of parseSessionFile(
          session,
          project.projectId,
          project.projectPath,
        )) {
          buffer.push(chunk);
          if (buffer.length >= BATCH_SIZE * 4) await flush();
        }
        store.recordSource(session, stats.mtimeMs, stats.size, stats.size);
      } catch (err) {
        process.stderr.write(`  ! session error ${session}: ${(err as Error).message}\n`);
      }
    }
    for (const memFile of project.memoryFiles) {
      try {
        const stats = await stat(memFile);
        const existing = store.getSource(memFile);
        if (existing && existing.mtime === stats.mtimeMs && existing.size === stats.size) {
          continue;
        }
        for await (const chunk of parseMemoryFile(
          memFile,
          project.projectId,
          project.projectPath,
        )) {
          buffer.push(chunk);
          if (buffer.length >= BATCH_SIZE * 4) await flush();
        }
        store.recordSource(memFile, stats.mtimeMs, stats.size, stats.size);
      } catch (err) {
        process.stderr.write(`  ! memory error ${memFile}: ${(err as Error).message}\n`);
      }
    }
  }
  await flush();
  process.stderr.write(`\nIndex complete. ${store.countChunks()} chunks stored.\n`);
  store.close();
}

async function searchCommand(query: string, opts: { limit: number; dbPath: string; kind?: string }): Promise<void> {
  const store = new Store({
    path: opts.dbPath,
    embeddingDim: EMBEDDING_DIM,
    modelId: getModelId(),
  });
  await warmup();
  const queryEmbedding = await embedQuery(query);
  const hits = store.search({
    queryEmbedding,
    queryText: query,
    limit: opts.limit,
    scope: { kind: "all" },
    sourceKind: opts.kind === "session" || opts.kind === "memory" ? opts.kind : undefined,
  });
  if (hits.length === 0) {
    process.stdout.write("No hits.\n");
    store.close();
    return;
  }
  for (const h of hits) {
    const project = h.projectPath ?? h.projectId;
    const date = h.ts ? new Date(h.ts).toISOString().slice(0, 10) : "    -    ";
    process.stdout.write(
      `\n${h.score.toFixed(3)}  ${h.sourceKind.padEnd(7)} ${date}  ${project}\n  ${h.id}\n  ${h.snippet}\n`,
    );
  }
  store.close();
}

const program = new Command();
program
  .name("recall")
  .description("Shared memory for Claude Code — MCP + CLI search across local sessions and memory.")
  .version("0.1.0");

program
  .command("index")
  .description("Index all Claude Code sessions and memory files into the local DB.")
  .option("--reset", "Drop the existing index first.", false)
  .option("--db <path>", "Path to the SQLite index file.", DEFAULT_DB_PATH)
  .action(async (opts: { reset: boolean; db: string }) => {
    try {
      await indexCommand({ reset: opts.reset, dbPath: opts.db });
    } catch (err) {
      process.stderr.write(`\nERROR: ${(err as Error).stack ?? (err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("search <query...>")
  .description("Search the index. Hybrid semantic + keyword.")
  .option("-n, --limit <n>", "Max results.", (v) => parseInt(v, 10), 10)
  .option("--db <path>", "Path to the SQLite index file.", DEFAULT_DB_PATH)
  .option("-k, --kind <kind>", "Filter: session | memory")
  .action(async (queryParts: string[], opts: { limit: number; db: string; kind?: string }) => {
    try {
      const query = queryParts.join(" ");
      await searchCommand(query, { limit: opts.limit, dbPath: opts.db, kind: opts.kind });
    } catch (err) {
      process.stderr.write(`\nERROR: ${(err as Error).stack ?? (err as Error).message}\n`);
      process.exit(1);
    }
  });

program
  .command("mcp")
  .description("Run the MCP stdio server. Register this with Claude Code.")
  .option("--db <path>", "Path to the SQLite index file.", DEFAULT_DB_PATH)
  .action(async (opts: { db: string }) => {
    try {
      await runMcpServer({ dbPath: opts.db });
    } catch (err) {
      process.stderr.write(`\nERROR: ${(err as Error).stack ?? (err as Error).message}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`\nERROR: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
