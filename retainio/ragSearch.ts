import { GoogleGenAI } from '@google/genai';
import { HistoricalCase } from './src/types';
import { getHistoricalCases } from './historicalCases';
import { cosineSimilarity, embedTexts, embedOne } from './embeddingUtils';

// Real semantic retrieval over the historical_cases table using Gemini's embedding API — a
// lightweight in-memory stand-in for a vector store (see plan notes: literal Chroma needs a
// separate server process; brute-force cosine similarity is instant at this corpus size).

interface EmbeddedCase {
  case: HistoricalCase;
  vector: number[];
}

let corpusCache: EmbeddedCase[] | null = null;

function caseToText(c: HistoricalCase): string {
  return `${c.industry}. Issue: ${c.primaryIssue}. Action taken: ${c.actionTaken}. Outcome: ${c.outcome}.`;
}

// Embeds the full corpus once per server process and caches it — embedding is an API call
// per case, and the corpus changes far less often than questions arrive. A case added while
// the server is running is searched from its next restart.
async function embedCorpus(ai: GoogleGenAI): Promise<EmbeddedCase[]> {
  if (corpusCache) return corpusCache;

  const cases = await getHistoricalCases();
  const vectors = await embedTexts(ai, cases.map(caseToText));
  corpusCache = cases.map((c, i) => ({ case: c, vector: vectors[i] }));
  return corpusCache;
}

export async function searchHistoricalCases(
  ai: GoogleGenAI,
  queryText: string,
  topK: number = 1
): Promise<HistoricalCase[]> {
  const corpus = await embedCorpus(ai);
  const queryVector = await embedOne(ai, queryText);

  const ranked = corpus
    .map(entry => ({ case: entry.case, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, topK).map(r => r.case);
}
