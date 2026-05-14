export type SourceKind = "session" | "memory";

export interface Chunk {
  id: string;
  sourceKind: SourceKind;
  projectId: string;
  projectPath: string | null;
  sessionId: string | null;
  sourcePath: string;
  turnIndex: number;
  role: "user" | "assistant" | null;
  ts: number | null;
  filesTouched: string[];
  toolsUsed: string[];
  textRedacted: string;
  tokenCount: number;
}

export interface SearchHit {
  id: string;
  score: number;
  snippet: string;
  sourceKind: SourceKind;
  projectId: string;
  projectPath: string | null;
  sessionId: string | null;
  sourcePath: string;
  turnIndex: number;
  role: "user" | "assistant" | null;
  ts: number | null;
}

export interface ChunkWithNeighbors {
  chunk: Chunk;
  before: Chunk[];
  after: Chunk[];
}
