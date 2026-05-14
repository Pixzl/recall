import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLAUDE_DIR = join(homedir(), ".claude");
export const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

export function decodeProjectId(projectId: string): string | null {
  if (!projectId.startsWith("-")) return null;
  const decoded = "/" + projectId.slice(1).replace(/-/g, "/");
  return existsSync(decoded) ? decoded : null;
}

export interface ProjectSource {
  projectId: string;
  projectPath: string | null;
  sessionFiles: string[];
  memoryFiles: string[];
}

export async function enumerateProjects(): Promise<ProjectSource[]> {
  if (!existsSync(PROJECTS_DIR)) return [];
  const entries = await readdir(PROJECTS_DIR, { withFileTypes: true });
  const out: ProjectSource[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const projectId = ent.name;
    const projectDir = join(PROJECTS_DIR, projectId);
    const sessionFiles: string[] = [];
    const memoryFiles: string[] = [];
    let inner: import("node:fs").Dirent[];
    try {
      inner = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of inner) {
      if (f.isFile() && f.name.endsWith(".jsonl")) {
        sessionFiles.push(join(projectDir, f.name));
      }
      if (f.isDirectory() && f.name === "memory") {
        const memDir = join(projectDir, "memory");
        try {
          const memEntries = await readdir(memDir, { withFileTypes: true });
          for (const m of memEntries) {
            if (m.isFile() && m.name.endsWith(".md")) {
              memoryFiles.push(join(memDir, m.name));
            }
          }
        } catch {
          /* skip */
        }
      }
    }
    out.push({
      projectId,
      projectPath: decodeProjectId(projectId),
      sessionFiles,
      memoryFiles,
    });
  }
  return out;
}

export async function fileMtime(path: string): Promise<number> {
  const s = await stat(path);
  return s.mtimeMs;
}

export async function fileSize(path: string): Promise<number> {
  const s = await stat(path);
  return s.size;
}
