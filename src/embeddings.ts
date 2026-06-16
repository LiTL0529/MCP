import OpenAI from "openai";
import { HttpsProxyAgent } from "https-proxy-agent";
import { config } from "./config.js";

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl, // undefined => OpenAI default
  // The OpenAI SDK doesn't read proxy env vars; pass an explicit agent so
  // api.openai.com is reachable from behind a proxy.
  httpAgent: config.proxyUrl ? new HttpsProxyAgent(config.proxyUrl) : undefined,
});

export interface FieldInputs {
  title: string;
  summary: string;
  attributes: string;
}

/**
 * Build the three ENGLISH texts that get embedded independently:
 *  - title:      the English title
 *  - summary:    the English summary
 *  - attributes: the key-attributes line (date / type / category / status / ...)
 * Each becomes its own vector so a query can match any field on its own.
 */
export function buildFieldInputs(input: {
  titleEn: string;
  summaryEn: string;
  attributes?: Record<string, unknown>;
  category?: string | null;
  status?: string | null;
  type?: string | null;
  clients?: string | null;
  tracks?: string | null;
  reportDate?: string | null;
  access?: string[] | null;
}): FieldInputs {
  const attr = input.attributes ?? {};
  const pick = (col: string | null | undefined, ...keys: string[]) =>
    col ?? (keys.map((k) => attr[k]).find((v) => typeof v === "string") as string | undefined) ?? "";

  const parts: string[] = [];
  const date = input.reportDate ?? (attr.date as string | undefined);
  if (date) parts.push(`Date: ${date}`);
  const type = pick(input.type, "type");
  if (type) parts.push(`Type: ${type}`);
  // Embed the ENGLISH attribute values only — input.category/clients/tracks may
  // carry the zh display value, so prefer the *_en keys and fall back to the
  // passed column (for the direct JSON API, which has no *_en attributes).
  const enAttr = (k: string, col?: string | null) => {
    const v = attr[k];
    return typeof v === "string" && v.trim() ? v.trim() : (col ?? "");
  };
  const category = enAttr("category_en", input.category);
  if (category) parts.push(`Category: ${category}`);
  const status = pick(input.status, "status");
  if (status) parts.push(`Status: ${status}`);
  const clients = enAttr("clients_en", input.clients);
  if (clients) parts.push(`Relevant clients: ${clients}`);
  const tracks = enAttr("tracks_en", input.tracks);
  if (tracks) parts.push(`Applicable tracks: ${tracks}`);
  if (input.access && input.access.length) parts.push(`Access: ${input.access.join(", ")}`);

  return {
    title: (input.titleEn || "").trim(),
    summary: (input.summaryEn || "").trim(),
    attributes: parts.join(" | "),
  };
}

function checkDim(vector: number[]): number[] {
  if (vector.length !== config.embeddingDim) {
    throw new Error(
      `Embedding dim mismatch: model returned ${vector.length}, schema expects ${config.embeddingDim}. ` +
        `Update EMBEDDING_DIM and the vector(N) columns to match.`,
    );
  }
  return vector;
}

/**
 * Describe an image with the vision model. The returned English text is then
 * embedded (with the same text model) so images share one vector space with
 * the title/summary/attributes vectors and can be hit by a plain text query.
 * `src` may be a public URL or a `data:image/...;base64,...` URL.
 */
export async function describeImage(src: string): Promise<string> {
  const res = await openai.chat.completions.create({
    model: config.visionModel,
    temperature: 0.2,
    max_tokens: 300,
    messages: [
      {
        role: "system",
        content:
          "You write concise, factual English descriptions of images for semantic search. " +
          "Cover the visible content, any readable text, chart/table figures and numbers, named " +
          "entities, and the apparent context. 2–4 sentences. No preamble, no markdown.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image for search indexing." },
          { type: "image_url", image_url: { url: src } },
        ],
      },
    ],
  });
  return res.choices[0]?.message?.content?.trim() ?? "";
}

export async function embed(text: string): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: config.embeddingModel,
    input: text,
    dimensions: config.embeddingDim,
  });
  const vector = res.data[0]?.embedding;
  if (!vector) throw new Error("OpenAI returned no embedding");
  return checkDim(vector);
}

/** Embed several texts in a single API call; preserves input order. */
export async function embedMany(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const res = await openai.embeddings.create({
    model: config.embeddingModel,
    input: texts,
    dimensions: config.embeddingDim,
  });
  return res.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => checkDim(d.embedding));
}
