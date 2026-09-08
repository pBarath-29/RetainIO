import { GoogleGenAI } from '@google/genai';
import { Account, HistoricalCase } from './src/types';
import { getHistoricalCases } from './historicalCases';
import { prisma } from './db';

// A real, if lightweight, knowledge graph: nodes are Accounts/HistoricalCases/Industries/
// RiskFactor-concepts; the SIMILAR_TO edge between an Account and a HistoricalCase is
// computed from genuinely shared structure (same industry, same underlying risk-factor
// concept) — not from how similar their text happens to sound. That's the deliberate
// difference from ragSearch.ts's embedding-based semantic search: this finds connections
// via shared attributes, even when the wording is completely different.
//
// The graph structure is unchanged. What changed is how a node's concepts are
// derived: this used to be substring matching against hand-written keyword
// lists, which tagged "we had no downtime this quarter" as an outage and set
// `api` on anything containing the letters "lag" or "sync". Gemini reads the
// text instead, constrained to the fixed vocabulary below.
//
// The vocabulary stays closed on purpose. Concepts are only useful here if an
// account and a case can land on the same label, so letting the model invent
// free-form tags would break the very matching this file exists to do.

// Induced from the corpus itself rather than hand-picked: Gemini was shown all
// 22 historical case descriptions plus the live account tickets and asked for a
// vocabulary that covers them, with the constraint that a tag is only useful if
// BOTH a case and a ticket could plausibly carry it. The previous ten words
// were inherited from the old keyword lists and nobody had ever checked them
// against the data - they had no concept for seat downsizing (which an account
// ticket did describe) or for product defects (which a case did).
export const RISK_CONCEPTS = [
  'budget_constraints',
  'competitor_threat',
  'pricing_dissatisfaction',
  'champion_loss',
  'integration_failure',
  'platform_outage',
  'compliance_and_security',
  'low_adoption',
  'enablement_and_support_failure',
  'product_defect',
] as const;

const CONCEPT_PROMPT = `You are tagging a customer-risk description with the risk concepts it actually refers to.

Allowed concepts (use these exact words, nothing else):
budget_constraints - customer internal budget freezes, cost reduction mandates, or seat downsizing
competitor_threat - pressure from competitors offering lower pricing or alternative feature sets
pricing_dissatisfaction - objections to price increases, tier structures, or perceived poor value for cost
champion_loss - departure of key executive sponsors, champions or decision-makers without replacement
integration_failure - API breaking changes, rate limits, latency, or data synchronisation errors
platform_outage - service downtime, server unavailability, or critical latency disrupting workflows
compliance_and_security - friction from security audits, data privacy policies or regulatory requirements
low_adoption - decline in feature usage, infrequent logins, unused licences, or unclear engagement
enablement_and_support_failure - flawed onboarding, poor training, or unresolved support escalations
product_defect - functional bugs, excessive false-positive alerts, or behaviour degrading product utility

Respond with ONLY a comma-separated list of the applicable concepts, or the single word NONE.
Tag every concept the situation genuinely involves, even if the case concluded the concern was unfounded or had a benign cause. Do not tag a concept that is only mentioned in order to rule it out.

Text: `;

// Accounts are keyed by their SHAP text, which changes each snapshot; cases are
// cached in the database instead (see conceptsForCase).
const accountConceptCache = new Map<string, string[]>();

function parseConcepts(raw: string): string[] {
  const allowed = new Set<string>(RISK_CONCEPTS);
  return [...new Set(
    raw.toLowerCase().split(',').map(t => t.trim()).filter(t => allowed.has(t)),
  )];
}

async function extractConcepts(ai: GoogleGenAI, text: string): Promise<string[]> {
  if (!text.trim()) return [];
  const cached = accountConceptCache.get(text);
  if (cached) return cached;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: CONCEPT_PROMPT + text,
    });
    const concepts = parseConcepts(response.text || '');
    accountConceptCache.set(text, concepts);
    return concepts;
  } catch (err: any) {
    // No edges rather than wrong edges: findSimilarCases already drops
    // zero-score matches, so this degrades to "no comparable precedent found"
    // instead of inventing a connection.
    console.warn('Concept extraction failed:', err.message || err);
    return [];
  }
}

// Cases are tagged once and the tags live on the row — a case's primaryIssue
// never changes, so this is one Gemini call per case for the life of the data.
async function conceptsForCase(ai: GoogleGenAI, c: HistoricalCase): Promise<string[]> {
  const row = await prisma.historicalCase.findUnique({
    where: { caseRef: c.id },
    select: { concepts: true },
  });
  if (row && row.concepts.length > 0) return row.concepts;

  const concepts = await extractConcepts(ai, c.primaryIssue);
  if (concepts.length > 0) {
    await prisma.historicalCase.update({ where: { caseRef: c.id }, data: { concepts } });
  }
  return concepts;
}

export interface GraphMatch {
  case: HistoricalCase;
  score: number;
  industryMatch: boolean;
  sharedConcepts: string[];
}

// Traverses the graph outward from an Account (via its industry + risk-factor concept
// nodes) to every HistoricalCase reachable through a shared node, ranking by how many
// attributes are actually shared — a real, if small, multi-hop structural query, not a
// single lookup.
export async function findSimilarCases(
  ai: GoogleGenAI,
  account: Partial<Account>,
  topK: number = 3,
): Promise<GraphMatch[]> {
  // SHAP text alone describes only the six model features, so it can express
  // just two of the ten concepts (api, login) - which made six of nine accounts
  // match the same case and left pricing/seats/renewal/compliance/outage/
  // onboarding cases permanently unreachable. The support ticket is where the
  // account says the rest out loud ("downsized 30 seats", "budget freeze"), so
  // both sources feed the profile.
  const riskText = [
    (account.shapFactors || [])
      .filter(f => f.direction === 'risk_increase')
      .map(f => `${f.feature} ${f.description}`)
      .join(' '),
    account.reviewText || '',
  ].filter(Boolean).join('. ');

  const accountIndustry = (account.industry || '').toLowerCase();
  const cases = await getHistoricalCases();

  const [accountConcepts, caseConcepts] = await Promise.all([
    extractConcepts(ai, riskText),
    Promise.all(cases.map(c => conceptsForCase(ai, c))),
  ]);
  const accountConceptSet = new Set(accountConcepts);

  const matches: GraphMatch[] = cases.map((c, i) => {
    const sharedConcepts = caseConcepts[i].filter(x => accountConceptSet.has(x));
    const industryMatch = accountIndustry.length > 0 && accountIndustry === c.industry.toLowerCase();
    return {
      case: c,
      score: sharedConcepts.length + (industryMatch ? 1 : 0),
      industryMatch,
      sharedConcepts,
    };
  });

  return matches
    .filter(m => m.score > 0) // no edge = no connection; don't force a match that isn't there
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
