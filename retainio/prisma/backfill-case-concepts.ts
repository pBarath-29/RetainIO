import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { prisma } from '../db';
import { findSimilarCases } from '../knowledgeGraph';

// One-shot: tags every historical case with its risk concepts so the advisor's
// first question doesn't pay for 22 Gemini calls. findSimilarCases populates
// and persists them as a side effect, so running it once over a throwaway
// account is enough.
async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  await findSimilarCases(ai, { industry: 'none', shapFactors: [] }, 1);

  const rows = await prisma.historicalCase.findMany({ orderBy: { caseRef: 'asc' } });
  const untagged = rows.filter(r => r.concepts.length === 0);
  for (const r of rows) {
    console.log(`${r.caseRef}  ${r.companyName.padEnd(22)} [${r.concepts.join(', ') || '—'}]`);
    console.log(`        "${r.primaryIssue.slice(0, 88)}"`);
  }
  console.log(`\n${rows.length - untagged.length}/${rows.length} cases tagged`);
  await prisma.$disconnect();
}
main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
