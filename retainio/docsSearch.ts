import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { cosineSimilarity, embedTexts, embedOne } from './embeddingUtils';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOCS_DIR = path.join(__dirname, 'docs');

export interface DocChunk {
  source: string;
  heading: string;
  text: string;
}

interface EmbeddedChunk {
  chunk: DocChunk;
  vector: number[];
}

let chunkCache: EmbeddedChunk[] | null = null;
// Fingerprint of the docs/ directory the cache was built from. Embedding the
// corpus costs an API call per section, so it is cached - but keyed on the
// files' modification times, so editing retention-policy.md takes effect on
// the next question instead of surviving until someone restarts the server.
let chunkCacheKey = '';

function docsFingerprint(): string {
  return fs.readdirSync(DOCS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()
    .map(f => `${f}:${fs.statSync(path.join(DOCS_DIR, f)).mtimeMs}`)
    .join('|');
}

// Reads every .md file in docs/ and splits it into one chunk per "## " section — small
// enough per-chunk that each is a coherent, independently-retrievable unit.
function loadAndChunkDocs(): DocChunk[] {
  const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md'));
  const chunks: DocChunk[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(DOCS_DIR, file), 'utf-8');
    const sections = content.split(/\n(?=## )/).filter(s => s.trim().startsWith('##'));
    for (const section of sections) {
      const headingMatch = section.match(/^##\s+(.+)/);
      chunks.push({
        source: file,
        heading: headingMatch ? headingMatch[1].trim() : file,
        text: section.trim(),
      });
    }
  }
  return chunks;
}

async function embedDocCorpus(ai: GoogleGenAI): Promise<EmbeddedChunk[]> {
  const fingerprint = docsFingerprint();
  if (chunkCache && fingerprint === chunkCacheKey) return chunkCache;

  const chunks = loadAndChunkDocs();
  const vectors = await embedTexts(ai, chunks.map(c => c.text));
  chunkCache = chunks.map((c, i) => ({ chunk: c, vector: vectors[i] }));
  chunkCacheKey = fingerprint;
  return chunkCache;
}

export async function searchDocuments(
  ai: GoogleGenAI,
  queryText: string,
  topK: number = 2
): Promise<DocChunk[]> {
  const corpus = await embedDocCorpus(ai);
  const queryVector = await embedOne(ai, queryText);

  const ranked = corpus
    .map(entry => ({ chunk: entry.chunk, score: cosineSimilarity(queryVector, entry.vector) }))
    .sort((a, b) => b.score - a.score);

  return ranked.slice(0, topK).map(r => r.chunk);
}
