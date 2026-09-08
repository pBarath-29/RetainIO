import { GoogleGenAI } from '@google/genai';

// Shared by ragSearch.ts (historical cases) and docsSearch.ts (reference documents) —
// both are "embed a small corpus once, cosine-similarity search at query time" instances
// of the same pattern.
export const EMBEDDING_MODEL = 'gemini-embedding-001';

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function embedTexts(ai: GoogleGenAI, texts: string[]): Promise<number[][]> {
  const response = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: texts,
  });
  const embeddings = response.embeddings || [];
  return texts.map((_, i) => embeddings[i]?.values || []);
}

export async function embedOne(ai: GoogleGenAI, text: string): Promise<number[]> {
  const [vector] = await embedTexts(ai, [text]);
  return vector;
}
