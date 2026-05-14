import { describe, expect, it } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionFile } from "../src/indexer/jsonl.js";

async function withFixture(lines: object[]): Promise<string> {
  const dir = join(tmpdir(), `recall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "session.jsonl");
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return path;
}

describe("parseSessionFile", () => {
  it("emits one chunk per turn with user + assistant text", async () => {
    const path = await withFixture([
      { type: "permission-mode", permissionMode: "default" },
      {
        type: "user",
        message: { role: "user", content: "Hello, can you read foo.ts?" },
        timestamp: "2026-04-20T10:00:00Z",
        sessionId: "s1",
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Sure, let me read it." },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x/foo.ts" } },
          ],
        },
        timestamp: "2026-04-20T10:00:01Z",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "file contents here" }],
        },
        timestamp: "2026-04-20T10:00:02Z",
      },
      {
        type: "user",
        message: { role: "user", content: "Thanks, now fix the bug." },
        timestamp: "2026-04-20T10:01:00Z",
      },
    ]);
    const chunks = [];
    for await (const c of parseSessionFile(path, "-test-proj", null)) {
      chunks.push(c);
    }
    await rm(path, { force: true });
    expect(chunks.length).toBe(2);
    expect(chunks[0].textRedacted).toContain("Hello, can you read foo.ts?");
    expect(chunks[0].textRedacted).toContain("Sure, let me read it.");
    expect(chunks[0].textRedacted).toContain("[tool_use: Read]");
    expect(chunks[0].textRedacted).toContain("[tool_result]");
    expect(chunks[0].filesTouched).toEqual(["/x/foo.ts"]);
    expect(chunks[0].toolsUsed).toEqual(["Read"]);
    expect(chunks[1].textRedacted).toContain("Thanks, now fix the bug.");
  });

  it("strips noise types and survives malformed lines", async () => {
    const path = await withFixture([
      { type: "file-history-snapshot", messageId: "x" },
      { type: "attachment" },
      { type: "user", message: { role: "user", content: "real" } },
    ]);
    const chunks = [];
    for await (const c of parseSessionFile(path, "-p", null)) chunks.push(c);
    await rm(path, { force: true });
    expect(chunks.length).toBe(1);
    expect(chunks[0].textRedacted).toContain("real");
  });
});
