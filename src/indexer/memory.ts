import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Chunk } from "../types.js";
import { redact } from "./redact.js";
import { approxTokenCount, truncateToTokens } from "./tokens.js";

const FALLBACK_TOKEN_WINDOW = 800;

function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\n/, "");
}

function chunkByHeadings(body: string): string[] {
  const lines = body.split("\n");
  const sections: string[] = [];
  let buf: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s/.test(line) && buf.length > 0) {
      sections.push(buf.join("\n").trim());
      buf = [];
    }
    buf.push(line);
  }
  if (buf.length > 0) {
    const last = buf.join("\n").trim();
    if (last) sections.push(last);
  }
  if (sections.length === 0) return splitByWindow(body);
  const refined: string[] = [];
  for (const sec of sections) {
    if (approxTokenCount(sec) <= FALLBACK_TOKEN_WINDOW) {
      refined.push(sec);
    } else {
      refined.push(...splitByWindow(sec));
    }
  }
  return refined;
}

function splitByWindow(text: string): string[] {
  const charWindow = FALLBACK_TOKEN_WINDOW * 4;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += charWindow) {
    out.push(text.slice(i, i + charWindow));
  }
  return out;
}

function chunkIdFor(args: { projectId: string; filePath: string; index: number }): string {
  const h = createHash("sha1");
  h.update(args.projectId);
  h.update(" ");
  h.update(args.filePath);
  h.update(" ");
  h.update(String(args.index));
  return "m_" + h.digest("hex").slice(0, 20);
}

export async function* parseMemoryFile(
  filePath: string,
  projectId: string,
  projectPath: string | null,
): AsyncGenerator<Chunk, void, void> {
  const raw = await readFile(filePath, "utf8");
  const stats = await stat(filePath);
  const body = stripFrontmatter(raw);
  const sections = chunkByHeadings(body);
  const fileLabel = basename(filePath);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section) continue;
    const text = `[memory:${fileLabel}]\n${section}`;
    const truncated = truncateToTokens(text, FALLBACK_TOKEN_WINDOW * 2);
    const redacted = redact(truncated);
    yield {
      id: chunkIdFor({ projectId, filePath, index: i }),
      sourceKind: "memory",
      projectId,
      projectPath,
      sessionId: null,
      sourcePath: filePath,
      turnIndex: i,
      role: null,
      ts: stats.mtimeMs,
      filesTouched: [],
      toolsUsed: [],
      textRedacted: redacted,
      tokenCount: approxTokenCount(redacted),
    };
  }
}
