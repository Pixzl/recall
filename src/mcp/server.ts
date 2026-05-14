import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Store } from "../store/sqlite.js";
import { DEFAULT_DB_PATH } from "../store/paths.js";
import { embedQuery, EMBEDDING_DIM, getModelId, warmup } from "../embed/local.js";

const SearchInput = z.object({
  query: z.string().min(1),
  scope: z.enum(["all", "current_project"]).optional().default("all"),
  project_id: z.string().optional(),
  kind: z.enum(["session", "memory"]).optional(),
  limit: z.number().int().min(1).max(50).optional().default(10),
});

const GetInput = z.object({
  id: z.string().min(1),
  neighbors: z.number().int().min(0).max(10).optional().default(2),
  max_tokens: z.number().int().min(200).max(20000).optional().default(4000),
});

export async function runMcpServer(opts: { dbPath?: string } = {}): Promise<void> {
  const dbPath = opts.dbPath ?? DEFAULT_DB_PATH;
  const store = new Store({
    path: dbPath,
    embeddingDim: EMBEDDING_DIM,
    modelId: getModelId(),
  });

  const server = new Server(
    { name: "recall", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "recall_search",
        description:
          "Hybrid (semantic + keyword) search across the user's local Claude Code history: " +
          "past sessions and memory files, across all projects on this machine. " +
          "Returns short snippets with stable IDs you can pass to recall_get for full context.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural-language query." },
            scope: {
              type: "string",
              enum: ["all", "current_project"],
              description: "Limit search to the current project or search globally.",
            },
            project_id: {
              type: "string",
              description: "Required if scope=current_project. The project_id (URL-encoded path).",
            },
            kind: {
              type: "string",
              enum: ["session", "memory"],
              description: "Optional filter to only sessions or only memory files.",
            },
            limit: {
              type: "number",
              description: "Max hits to return (default 10, max 50).",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "recall_get",
        description:
          "Fetch a chunk by ID along with its neighboring turns from the same session. " +
          "Use this after recall_search to expand context around a hit.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Chunk ID returned by recall_search." },
            neighbors: {
              type: "number",
              description: "How many turns before/after to include (default 2, max 10).",
            },
            max_tokens: {
              type: "number",
              description: "Approximate hard cap on returned text size.",
            },
          },
          required: ["id"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};

    if (name === "recall_search") {
      const input = SearchInput.parse(args);
      const queryEmbedding = await embedQuery(input.query);
      const scope =
        input.scope === "current_project" && input.project_id
          ? ({ kind: "project" as const, projectId: input.project_id })
          : ({ kind: "all" as const });
      const hits = store.search({
        queryEmbedding,
        queryText: input.query,
        limit: input.limit,
        scope,
        sourceKind: input.kind,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              hits.map((h) => ({
                id: h.id,
                score: Number(h.score.toFixed(4)),
                kind: h.sourceKind,
                project: h.projectPath ?? h.projectId,
                role: h.role,
                ts: h.ts ? new Date(h.ts).toISOString() : null,
                snippet: h.snippet,
              })),
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "recall_get") {
      const input = GetInput.parse(args);
      const result = store.getChunkWithNeighbors(input.id, input.neighbors);
      if (!result) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "not_found" }) }],
        };
      }
      const sections: string[] = [];
      const headerFor = (label: string, c: typeof result.chunk): string =>
        `--- ${label} | turn ${c.turnIndex} | ${c.role ?? c.sourceKind} ${
          c.ts ? `| ${new Date(c.ts).toISOString()}` : ""
        } ---`;
      for (const c of result.before) {
        sections.push(headerFor("before", c));
        sections.push(c.textRedacted);
      }
      sections.push(headerFor("HIT", result.chunk));
      sections.push(result.chunk.textRedacted);
      for (const c of result.after) {
        sections.push(headerFor("after", c));
        sections.push(c.textRedacted);
      }
      let combined = sections.join("\n\n");
      const charBudget = input.max_tokens * 4;
      if (combined.length > charBudget) {
        combined = combined.slice(0, charBudget) + "\n…[truncated to max_tokens]";
      }
      return { content: [{ type: "text", text: combined }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  await warmup();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
