import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { computeRealFusion, saveShapExplanations } from '../fusionSnapshot';

// Backfills real SHAP explanations for each account's CURRENT latest
// churnPrediction row only (the one actually displayed on the dashboard —
// mapAccount only ever reads fusionScores[take:1]). Older historical
// churnPrediction rows are never read by the UI, so they're left alone.
// Going forward, runDailySnapshotForToday() saves these automatically for
// every new daily row — this script just fixes what's visible today.
//
// Pass --force to delete and regenerate rows that already exist (needed
// after changing what /explain/churn returns or how descriptions are
// worded); without it, accounts that already have SHAP rows are skipped.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const FORCE = process.argv.includes('--force');

async function main() {
  const accounts = await prisma.account.findMany({
    include: {
      fusionScores: {
        orderBy: { snapshotDate: 'desc' }, take: 1,
        include: { churnPrediction: { include: { shapExplanations: true } } },
      },
    },
  });

  let updated = 0, skipped = 0, failed = 0;
  for (const account of accounts) {
    const churnPrediction = account.fusionScores[0]?.churnPrediction;
    if (!churnPrediction) { console.log(`${account.name}: no fusion score yet, skipping`); skipped++; continue; }
    if (churnPrediction.shapExplanations.length > 0 && !FORCE) {
      console.log(`${account.name}: already has SHAP, skipping (use --force to regenerate)`);
      skipped++;
      continue;
    }

    try {
      if (churnPrediction.shapExplanations.length > 0) {
        await prisma.shapExplanation.deleteMany({ where: { churnPredictionId: churnPrediction.id } });
      }
      const { churnFeatures } = await computeRealFusion(account.id);
      await saveShapExplanations(churnPrediction.id, churnFeatures);
      const count = await prisma.shapExplanation.count({ where: { churnPredictionId: churnPrediction.id } });
      console.log(`${account.name}: saved ${count} real SHAP factors for churnPrediction ${churnPrediction.id}`);
      updated++;
    } catch (err: any) {
      console.warn(`${account.name}: failed — ${err.message}`);
      failed++;
    }
  }

  console.log(`\nUpdated ${updated}, skipped ${skipped}, failed ${failed} (of ${accounts.length} accounts).`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
