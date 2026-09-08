import 'dotenv/config';
import { prisma } from '../db';

/**
 * One-shot: rewrites the historical case library so its discount narratives match the
 * pricing model the rest of the app now uses.
 *
 * Two problems being fixed:
 *
 *   1. Every case described a discount as a bare percentage. With durations now part
 *      of how an offer is defined and approved, "offered a 10% discount" is an
 *      incomplete precedent — the advisor quotes these cases as guidance, and the
 *      duration is exactly the part a Manager now has to decide.
 *
 *   2. Two cases contradicted the 12-month standard term outright: CASE-05's "2-year
 *      commitment" and CASE-19's "extended multi-year contract term". The advisor
 *      could cite either as a precedent for something the product cannot sell.
 *
 * Durations are chosen to fit each case's own story rather than assigned uniformly —
 * short where the discount was a stopgap, full-term where it was the actual remedy.
 */
const REWRITES: Record<string, string> = {
  'CASE-01': 'Offered a 12% renewal discount for 6 months with dedicated engineering office hours for integration',
  'CASE-02': 'Conducted executive re-onboarding session, provided a 10% discount for 6 months',
  'CASE-04': 'Assigned a dedicated integration engineer and offered a 10% discount for 3 months for the disruption',
  // Was "tied to a 2-year commitment" — impossible under a 12-month standard term.
  'CASE-05': 'Offered a 15% retention discount for 12 months tied to a full-term renewal commitment',
  'CASE-07': 'Matched competitive pressure with a 20% discount for 6 months',
  'CASE-09': 'Offered a 10% discount for 6 months without addressing the underlying sync bug',
  'CASE-10': 'Offered a 10% discount for 12 months plus a quarterly payment plan to soften the increase',
  'CASE-13': 'Offered a 10% discount for 6 months, but it arrived after the internal budget decision had already been finalized',
  // Was "bundled with an extended multi-year contract term".
  'CASE-19': 'Offered a 15% discount for 12 months bundled with an early commitment to the next annual renewal',
  'CASE-20': 'Offered a 10% discount for 3 months without resolving the rate-limiting issue',
  'CASE-21': 'Executive apology call, a 15% discount for 6 months, and a dedicated support track — combined package',
  'CASE-22': 'Matched the competitive discount at 20% for 6 months and added a loyalty-tier upgrade',
};

async function main() {
  let changed = 0;
  for (const [caseRef, actionTaken] of Object.entries(REWRITES)) {
    const existing = await prisma.historicalCase.findUnique({ where: { caseRef } });
    if (!existing) {
      console.log(`  MISSING ${caseRef}`);
      continue;
    }
    if (existing.actionTaken === actionTaken) continue;

    // Concepts were extracted from the old wording; clear them so the knowledge graph
    // re-tags from the rewritten text on its next question.
    await prisma.historicalCase.update({
      where: { caseRef },
      data: { actionTaken, concepts: [] },
    });
    console.log(`  ${caseRef}\n     was: ${existing.actionTaken}\n     now: ${actionTaken}`);
    changed++;
  }

  const stragglers = await prisma.historicalCase.findMany({
    where: { OR: [{ actionTaken: { contains: 'multi-year' } }, { actionTaken: { contains: '2-year' } }] },
  });
  console.log(`\n${changed} case(s) rewritten`);
  console.log(stragglers.length
    ? `WARNING: ${stragglers.length} case(s) still reference multi-year terms: ${stragglers.map(s => s.caseRef).join(', ')}`
    : 'no case references a multi-year term any more');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
