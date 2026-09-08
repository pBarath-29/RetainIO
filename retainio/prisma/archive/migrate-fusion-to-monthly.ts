import 'dotenv/config';
import { prisma } from '../db';
import { fusionRiskCategory } from '../fusionSnapshot';

// One-shot data migration: converts the existing fusion_scores rows (mostly
// the Phase 2 historical backfill — one approximated point per month — plus
// the later real-fusion backfill's points) into fusion_monthly_summaries
// rows, so the trend charts have something to read from the new table
// immediately instead of starting empty. No fake daily data is invented for
// the past: each historical month simply becomes an average of whatever
// real row(s) already exist for it (sampleCount = 1, in almost every case
// today). Run exactly once, right after the daily_fusion_snapshots
// migration. Safe to re-run (upserts), but pointless to — nothing changes
// unless fusion_scores itself changes.

function monthKeyOf(d: Date): string {
  return d.toISOString().substring(0, 7);
}

async function main() {
  const rows = await prisma.fusionScore.findMany({ orderBy: { snapshotDate: 'asc' } });

  const groups = new Map<string, { accountId: string; monthStart: Date; scores: number[] }>();
  for (const row of rows) {
    const key = `${row.accountId}_${monthKeyOf(row.snapshotDate)}`;
    if (!groups.has(key)) {
      const monthStart = new Date(Date.UTC(row.snapshotDate.getUTCFullYear(), row.snapshotDate.getUTCMonth(), 1));
      groups.set(key, { accountId: row.accountId, monthStart, scores: [] });
    }
    groups.get(key)!.scores.push(row.fusionScore);
  }

  let created = 0;
  for (const group of groups.values()) {
    const avgFusionScore = group.scores.reduce((a, b) => a + b, 0) / group.scores.length;
    await prisma.fusionMonthlySummary.upsert({
      where: { accountId_monthStart: { accountId: group.accountId, monthStart: group.monthStart } },
      create: {
        accountId: group.accountId,
        monthStart: group.monthStart,
        avgFusionScore,
        sampleCount: group.scores.length,
        riskCategory: fusionRiskCategory(avgFusionScore / 100),
      },
      update: {
        avgFusionScore,
        sampleCount: group.scores.length,
        riskCategory: fusionRiskCategory(avgFusionScore / 100),
        computedAt: new Date(),
      },
    });
    created++;
  }

  console.log(`Created/updated ${created} fusion_monthly_summaries rows from ${rows.length} existing fusion_scores rows.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
