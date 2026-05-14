import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Chunk, ChunkWithNeighbors, SearchHit, SourceKind } from "../types.js";

const SCHEMA_VERSION = 1;

export interface StoreOptions {
  path: string;
  embeddingDim: number;
  modelId: string;
}

export class Store {
  private db: Database.Database;
  readonly embeddingDim: number;
  readonly modelId: string;

  constructor(opts: StoreOptions) {
    const dir = dirname(opts.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(opts.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    sqliteVec.load(this.db);
    try {
      chmodSync(opts.path, 0o600);
    } catch {
      /* best-effort */
    }
    this.embeddingDim = opts.embeddingDim;
    this.modelId = opts.modelId;
    this.initSchema();
    this.checkModelCompatibility();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS chunks(
        id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_path TEXT,
        session_id TEXT,
        source_path TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        role TEXT,
        ts INTEGER,
        files_touched TEXT,
        tools_used TEXT,
        text_redacted TEXT NOT NULL,
        token_count INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id, turn_index);
      CREATE INDEX IF NOT EXISTS idx_chunks_project ON chunks(project_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text_redacted,
        tokenize='unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
        embedding FLOAT[${this.embeddingDim}]
      );

      CREATE TABLE IF NOT EXISTS sources(
        path TEXT PRIMARY KEY,
        mtime INTEGER,
        size INTEGER,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        last_indexed_at INTEGER
      );
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("schema_version", String(SCHEMA_VERSION));
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("embedding_dim", String(this.embeddingDim));
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)")
      .run("model_id", this.modelId);
  }

  private checkModelCompatibility(): void {
    const stored = this.db
      .prepare("SELECT value FROM meta WHERE key = 'model_id'")
      .get() as { value: string } | undefined;
    if (stored && stored.value !== this.modelId) {
      throw new Error(
        `Index was built with model "${stored.value}" but current model is "${this.modelId}". ` +
          `Run "recall index --reset" to rebuild.`,
      );
    }
    const dim = this.db
      .prepare("SELECT value FROM meta WHERE key = 'embedding_dim'")
      .get() as { value: string } | undefined;
    if (dim && Number(dim.value) !== this.embeddingDim) {
      throw new Error(
        `Index dim ${dim.value} != current ${this.embeddingDim}. Reset required.`,
      );
    }
  }

  reset(): void {
    this.db.exec(`
      DELETE FROM chunks;
      DELETE FROM chunks_fts;
      DELETE FROM vectors;
      DELETE FROM sources;
    `);
  }

  upsertChunk(chunk: Chunk, embedding: Float32Array): void {
    this.db
      .prepare(
        `INSERT INTO chunks(
           id, source_kind, project_id, project_path, session_id, source_path,
           turn_index, role, ts, files_touched, tools_used,
           text_redacted, token_count
         ) VALUES (
           @id, @source_kind, @project_id, @project_path, @session_id, @source_path,
           @turn_index, @role, @ts, @files_touched, @tools_used,
           @text_redacted, @token_count
         )
         ON CONFLICT(id) DO UPDATE SET
           text_redacted = excluded.text_redacted,
           ts = excluded.ts,
           files_touched = excluded.files_touched,
           tools_used = excluded.tools_used,
           token_count = excluded.token_count`,
      )
      .run({
        id: chunk.id,
        source_kind: chunk.sourceKind,
        project_id: chunk.projectId,
        project_path: chunk.projectPath,
        session_id: chunk.sessionId,
        source_path: chunk.sourcePath,
        turn_index: chunk.turnIndex,
        role: chunk.role,
        ts: chunk.ts,
        files_touched: JSON.stringify(chunk.filesTouched),
        tools_used: JSON.stringify(chunk.toolsUsed),
        text_redacted: chunk.textRedacted,
        token_count: chunk.tokenCount,
      });

    const rowidRow = this.db
      .prepare("SELECT rowid FROM chunks WHERE id = ?")
      .get(chunk.id) as { rowid: number | bigint } | undefined;
    if (!rowidRow) throw new Error(`Chunk not found after upsert: ${chunk.id}`);
    const rowidBig =
      typeof rowidRow.rowid === "bigint" ? rowidRow.rowid : BigInt(rowidRow.rowid);

    this.db.prepare("DELETE FROM chunks_fts WHERE rowid = ?").run(rowidBig);
    this.db
      .prepare("INSERT INTO chunks_fts(rowid, text_redacted) VALUES (?, ?)")
      .run(rowidBig, chunk.textRedacted);

    this.db.prepare("DELETE FROM vectors WHERE rowid = ?").run(rowidBig);
    this.db
      .prepare("INSERT INTO vectors(rowid, embedding) VALUES (?, ?)")
      .run(rowidBig, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  }

  upsertChunkBatch(items: { chunk: Chunk; embedding: Float32Array }[]): void {
    const tx = this.db.transaction((batch: typeof items) => {
      for (const { chunk, embedding } of batch) {
        this.upsertChunk(chunk, embedding);
      }
    });
    tx(items);
  }

  recordSource(path: string, mtime: number, size: number, byteOffset: number): void {
    this.db
      .prepare(
        `INSERT INTO sources(path, mtime, size, byte_offset, last_indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           mtime = excluded.mtime,
           size = excluded.size,
           byte_offset = excluded.byte_offset,
           last_indexed_at = excluded.last_indexed_at`,
      )
      .run(path, mtime, size, byteOffset, Date.now());
  }

  getSource(
    path: string,
  ): { mtime: number; size: number; byte_offset: number; last_indexed_at: number } | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE path = ?").get(path) as
      | { mtime: number; size: number; byte_offset: number; last_indexed_at: number }
      | undefined;
  }

  countChunks(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    return r.n;
  }

  search(opts: {
    queryEmbedding: Float32Array;
    queryText: string;
    limit: number;
    scope?: { kind: "project"; projectId: string } | { kind: "all" };
    sourceKind?: SourceKind;
  }): SearchHit[] {
    const k = Math.max(opts.limit * 5, 30);
    const fusionK = 60;
    // RRF contributes at most 1/(fusionK+1) per list, so a hit ranked #1 in both
    // the vector and BM25 lists tops out at 2/(fusionK+1) (~0.033). Normalise
    // against that ceiling so callers see a meaningful 0–1 score instead.
    const maxRrf = 2 / (fusionK + 1);

    const ftsQuery = this.escapeFts(opts.queryText);

    const queryBuf = Buffer.from(
      opts.queryEmbedding.buffer,
      opts.queryEmbedding.byteOffset,
      opts.queryEmbedding.byteLength,
    );
    const vecRows = (
      this.db
        .prepare(
          `SELECT rowid, distance
           FROM vectors
           WHERE embedding MATCH ?
           ORDER BY distance
           LIMIT ?`,
        )
        .all(queryBuf, k) as { rowid: number | bigint; distance: number }[]
    ).map((r) => ({ rowid: Number(r.rowid), distance: r.distance }));

    let ftsRows: { rowid: number; bm: number }[] = [];
    if (ftsQuery) {
      try {
        ftsRows = (
          this.db
            .prepare(
              `SELECT rowid, bm25(chunks_fts) AS bm
               FROM chunks_fts
               WHERE chunks_fts MATCH ?
               ORDER BY bm
               LIMIT ?`,
            )
            .all(ftsQuery, k) as { rowid: number | bigint; bm: number }[]
        ).map((r) => ({ rowid: Number(r.rowid), bm: r.bm }));
      } catch {
        ftsRows = [];
      }
    }

    const fused = new Map<number, number>();
    vecRows.forEach((r, i) => {
      fused.set(r.rowid, (fused.get(r.rowid) ?? 0) + 1 / (fusionK + i + 1));
    });
    ftsRows.forEach((r, i) => {
      fused.set(r.rowid, (fused.get(r.rowid) ?? 0) + 1 / (fusionK + i + 1));
    });

    if (fused.size === 0) return [];

    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
    const rowids = ranked.map(([id]) => id);
    const placeholders = rowids.map(() => "?").join(",");
    const chunkRows = this.db
      .prepare(
        `SELECT rowid, id, source_kind, project_id, project_path, session_id, source_path,
                turn_index, role, ts, text_redacted
         FROM chunks
         WHERE rowid IN (${placeholders})
         ${opts.scope?.kind === "project" ? "AND project_id = ?" : ""}
         ${opts.sourceKind ? "AND source_kind = ?" : ""}`,
      )
      .all(
        ...rowids,
        ...(opts.scope?.kind === "project" ? [opts.scope.projectId] : []),
        ...(opts.sourceKind ? [opts.sourceKind] : []),
      ) as Array<{
      rowid: number;
      id: string;
      source_kind: SourceKind;
      project_id: string;
      project_path: string | null;
      session_id: string | null;
      source_path: string;
      turn_index: number;
      role: "user" | "assistant" | null;
      ts: number | null;
      text_redacted: string;
    }>;

    const byRowid = new Map(chunkRows.map((c) => [c.rowid, c]));
    const hits: SearchHit[] = [];
    for (const [rowid, score] of ranked) {
      const c = byRowid.get(rowid);
      if (!c) continue;
      hits.push({
        id: c.id,
        score: score / maxRrf,
        snippet: this.makeSnippet(c.text_redacted, opts.queryText),
        sourceKind: c.source_kind,
        projectId: c.project_id,
        projectPath: c.project_path,
        sessionId: c.session_id,
        sourcePath: c.source_path,
        turnIndex: c.turn_index,
        role: c.role,
        ts: c.ts,
      });
      if (hits.length >= opts.limit) break;
    }
    return hits;
  }

  private escapeFts(q: string): string {
    const cleaned = q.replace(/["']/g, " ").trim();
    if (!cleaned) return "";
    const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
    return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
  }

  private makeSnippet(text: string, query: string): string {
    const lowered = text.toLowerCase();
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    let bestPos = -1;
    for (const term of terms) {
      const p = lowered.indexOf(term);
      if (p >= 0) {
        bestPos = p;
        break;
      }
    }
    const center = bestPos >= 0 ? bestPos : 0;
    const start = Math.max(0, center - 200);
    const end = Math.min(text.length, center + 200);
    let s = text.slice(start, end).replace(/\s+/g, " ").trim();
    if (start > 0) s = "…" + s;
    if (end < text.length) s = s + "…";
    return s;
  }

  getChunkWithNeighbors(id: string, neighborCount: number): ChunkWithNeighbors | null {
    const row = this.db
      .prepare(
        `SELECT id, source_kind, project_id, project_path, session_id, source_path,
                turn_index, role, ts, files_touched, tools_used,
                text_redacted, token_count
         FROM chunks WHERE id = ?`,
      )
      .get(id) as RawChunkRow | undefined;
    if (!row) return null;
    const chunk = rowToChunk(row);

    const before: Chunk[] = [];
    const after: Chunk[] = [];
    if (chunk.sessionId) {
      const beforeRows = this.db
        .prepare(
          `SELECT id, source_kind, project_id, project_path, session_id, source_path,
                  turn_index, role, ts, files_touched, tools_used,
                  text_redacted, token_count
           FROM chunks WHERE session_id = ? AND turn_index < ?
           ORDER BY turn_index DESC LIMIT ?`,
        )
        .all(chunk.sessionId, chunk.turnIndex, neighborCount) as RawChunkRow[];
      const afterRows = this.db
        .prepare(
          `SELECT id, source_kind, project_id, project_path, session_id, source_path,
                  turn_index, role, ts, files_touched, tools_used,
                  text_redacted, token_count
           FROM chunks WHERE session_id = ? AND turn_index > ?
           ORDER BY turn_index ASC LIMIT ?`,
        )
        .all(chunk.sessionId, chunk.turnIndex, neighborCount) as RawChunkRow[];
      before.push(...beforeRows.reverse().map(rowToChunk));
      after.push(...afterRows.map(rowToChunk));
    }
    return { chunk, before, after };
  }

  close(): void {
    this.db.close();
  }
}

interface RawChunkRow {
  id: string;
  source_kind: SourceKind;
  project_id: string;
  project_path: string | null;
  session_id: string | null;
  source_path: string;
  turn_index: number;
  role: "user" | "assistant" | null;
  ts: number | null;
  files_touched: string;
  tools_used: string;
  text_redacted: string;
  token_count: number;
}

function rowToChunk(row: RawChunkRow): Chunk {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    projectId: row.project_id,
    projectPath: row.project_path,
    sessionId: row.session_id,
    sourcePath: row.source_path,
    turnIndex: row.turn_index,
    role: row.role,
    ts: row.ts,
    filesTouched: JSON.parse(row.files_touched || "[]"),
    toolsUsed: JSON.parse(row.tools_used || "[]"),
    textRedacted: row.text_redacted,
    tokenCount: row.token_count,
  };
}
