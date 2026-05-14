import { pipeline, env } from "@huggingface/transformers";

const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIM = 384;

env.allowLocalModels = true;
env.useBrowserCache = false;

type Embedder = Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;

let embedderPromise: Promise<Embedder> | null = null;
let activeModelId: string = DEFAULT_MODEL;

export function setModel(modelId: string): void {
  if (modelId !== activeModelId) {
    activeModelId = modelId;
    embedderPromise = null;
  }
}

export function getModelId(): string {
  return activeModelId;
}

async function getEmbedder(): Promise<Embedder> {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", activeModelId, {
      dtype: "fp32",
    }) as Promise<Embedder>;
  }
  return embedderPromise;
}

export async function warmup(): Promise<void> {
  await getEmbedder();
}

export async function embedPassages(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const embedder = await getEmbedder();
  const prefixed = texts.map((t) => `passage: ${t}`);
  const out = await embedder(prefixed, { pooling: "mean", normalize: true });
  return tensorToFloatArrays(out, texts.length);
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const out = await embedder([`query: ${text}`], { pooling: "mean", normalize: true });
  const arrs = tensorToFloatArrays(out, 1);
  return arrs[0];
}

interface TensorLike {
  data: Float32Array | number[];
  dims?: number[];
}

function tensorToFloatArrays(out: unknown, count: number): Float32Array[] {
  const tensor = out as TensorLike;
  const flat = tensor.data instanceof Float32Array ? tensor.data : new Float32Array(tensor.data);
  const dim = flat.length / count;
  const arrs: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    arrs.push(flat.slice(i * dim, (i + 1) * dim));
  }
  return arrs;
}

export async function embedPassagesBatched(
  texts: string[],
  batchSize = 32,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const embeddings = await embedPassages(slice);
    out.push(...embeddings);
  }
  return out;
}
