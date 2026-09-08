import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// SUPERSEDED by fusionSnapshot.ts's runDailySnapshotForToday(), which does
// this same computation for real, every day, going forward — see
// prisma/run-daily-snapshot.ts. Kept here only as a record of how the
// initial demo history was produced. Do NOT re-run this against a database
// that already has accumulated real daily snapshots — it will create a
// second, conflicting "today" row per account rather than respecting the
// (accountId, snapshotDate) uniqueness the real daily job relies on.
//
// Original purpose: added one genuinely real "now" data point per account —
// real churn_proba (from usage_snapshots via the real gradient boosting
// model), real sentiment (from the latest support ticket's actual text via
// the real Naive Bayes model), and real fusion (combining those two via the
// real trained fusion_meta_classifier.pkl) — replacing the Phase 2
// backfill's approximated "current" point, which was derived from
// mockData.ts's numbers rather than computed.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });
const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL || 'http://127.0.0.1:8000';

const RISK_BAND_ENUM: Record<string, 'High_Risk' | 'Medium_Risk' | 'Low_Risk'> = {
  'High Risk': 'High_Risk',
  'Medium Risk': 'Medium_Risk',
  'Low Risk': 'Low_Risk',
};

function fusionRiskCategory(fusionProba: number): 'High_Risk' | 'Medium_Risk' | 'Low_Risk' {
  const pct = fusionProba * 100;
  if (pct > 70) return 'High_Risk';
  if (pct > 30) return 'Medium_Risk';
  return 'Low_Risk';
}

async function main() {
  const accounts = await prisma.account.findMany({
    include: {
      subscriptions: { orderBy: { termStart: 'desc' }, take: 1 },
      usageSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1 },
      supportTickets: { orderBy: { openedAt: 'desc' }, take: 1 },
    },
  });

  let updated = 0;
  for (const account of accounts) {
    const usage = account.usageSnapshots[0];
    const sub = account.subscriptions[0];
    const ticket = account.supportTickets[0];
    if (!usage || !sub || !ticket) {
      console.warn(`Skipping ${account.name} — missing usage snapshot, subscription, or support ticket.`);
      continue;
    }

    const churnFeatures = {
      Account_Age_Days: usage.accountAgeDays,
      Daily_Usage_Mins: usage.dailyUsageMins,
      Support_Tickets_90Days: usage.supportTickets90Days,
      API_Utilization_Rate: usage.apiUtilizationRate,
      Login_Frequency: usage.loginFrequencyBucket,
      Plan_Tier: sub.planTier,
    };

    const churnRes = await fetch(`${MODEL_SERVICE_URL}/predict/churn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(churnFeatures),
    });
    const churnData = await churnRes.json();

    const sentRes = await fetch(`${MODEL_SERVICE_URL}/predict/sentiment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ticket.body }),
    });
    const sentData = await sentRes.json();

    const fusionRes = await fetch(`${MODEL_SERVICE_URL}/predict/fusion`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ churn_proba: churnData.churn_proba, sentiment_probabilities: sentData.probabilities }),
    });
    const fusionData = await fusionRes.json();

    const churnPrediction = await prisma.churnPrediction.create({
      data: {
        accountId: account.id,
        churnProba: churnData.churn_proba,
        riskBand: RISK_BAND_ENUM[churnData.risk_band],
      },
    });

    const sentimentPrediction = await prisma.sentimentPrediction.create({
      data: {
        supportTicketId: ticket.id,
        classification: sentData.classification,
        riskWeight: sentData.risk_weight,
      },
    });

    const fusionScore = Math.round(fusionData.fusion_proba * 100);
    await prisma.fusionScore.create({
      data: {
        accountId: account.id,
        snapshotDate: new Date(new Date().toISOString().substring(0, 10)),
        churnPredictionId: churnPrediction.id,
        sentimentPredictionId: sentimentPrediction.id,
        fusionScore,
        riskCategory: fusionRiskCategory(fusionData.fusion_proba),
      },
    });

    console.log(
      `${account.name.padEnd(28)} churn=${(churnData.churn_proba * 100).toFixed(1)}%  ` +
      `sentiment=${sentData.classification.padEnd(10)}  fusion=${fusionScore}%`
    );
    updated++;
  }

  console.log(`\nAdded a real current data point for ${updated}/${accounts.length} accounts.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
