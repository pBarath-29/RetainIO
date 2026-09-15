import { prisma } from './db';
import { HistoricalCase } from './src/types';

// Single source for the AI Advisor's retrieval corpus, now read from the
// historical_cases table rather than mockData.ts's hardcoded array.
//
// Both advisor tools go through here — ragSearch.ts (semantic similarity) and
// knowledgeGraph.ts (structural similarity) — so they can never disagree about
// what the case library contains.
//
// Cached in module scope because the corpus is read on every advisor question
// and changes rarely; ragSearch additionally caches the embeddings keyed off
// this list.
//
// The cache revalidates itself against a cheap fingerprint (row count + the
// newest updatedAt), so an added or edited case is picked up on the next read
// without a server restart. (ragSearch's embeddings are the exception; see there.)

// Prisma enum identifiers can't contain spaces or parentheses, so the stored
// values map back to the display strings the UI and prompts already use.
const OUTCOME_LABEL: Record<string, HistoricalCase['outcome']> = {
  // Was "Retained (Renewed +2 Yrs)". Contracts are 12-month terms, so a two-year
  // renewal is not something the product sells - and the advisor cites these labels
  // as precedent. The Prisma enum identifier is unchanged; only the display string.
  Retained_Renewed: 'Retained (Renewed Full Term)',
  Retained_Upsold: 'Retained (Upsold)',
  Churned: 'Churned',
};

let cache: HistoricalCase[] | null = null;
let cacheKey = '';

// One aggregate query, far cheaper than re-reading and re-mapping every row.
async function casesFingerprint(): Promise<string> {
  const [agg] = await prisma.$queryRaw<{ n: bigint; latest: Date | null }[]>`
    SELECT COUNT(*)::bigint AS n, MAX(updated_at) AS latest FROM historical_cases
  `;
  return `${agg?.n ?? 0}:${agg?.latest?.getTime() ?? 0}`;
}

export async function getHistoricalCases(): Promise<HistoricalCase[]> {
  const fingerprint = await casesFingerprint();
  if (cache && fingerprint === cacheKey) return cache;

  const rows = await prisma.historicalCase.findMany({ orderBy: { caseRef: 'asc' } });
  cache = rows.map(r => ({
    // caseRef preserves the original CASE-01..CASE-22 identifiers the corpus
    // was authored with, rather than exposing the row's uuid.
    id: r.caseRef,
    companyName: r.companyName,
    industry: r.industry,
    initialRisk: r.initialRisk,
    primaryIssue: r.primaryIssue,
    actionTaken: r.actionTaken,
    outcome: OUTCOME_LABEL[r.outcome] ?? 'Churned',
    learnings: r.learnings,
  }));
  cacheKey = fingerprint;
  return cache;
}
