import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// SUPERSEDED for ongoing use by fusionSnapshot.ts's real daily snapshot +
// monthly rollup (see prisma/run-daily-snapshot.ts). This script remains
// valid only for seeding a brand-new, empty database's initial history — do
// not re-run it against a database that already has real accumulated daily
// data, since it writes fusion_scores rows directly rather than going
// through the (accountId, snapshotDate) upsert the real daily job uses.
//
// Backfills the ML prediction tables so the 6-month risk trajectory chart
// has real historical rows instead of a hand-typed array. Source: each
// account's riskHistory[] in mockData.ts (already 6 points) becomes 6 real
// fusion_scores rows, one per month. A churn_prediction is created for each
// point too — since there's no real historical churn score to backfill
// against, its churn_proba is derived by holding the ratio between the
// account's final churnModelScore and final fusionRiskScore constant across
// history. That's an honest approximation, not a real measurement — flagged
// here rather than presented as more precise than it is. ai_explanations
// only attaches to the most recent (6th) point, matching what mockData.ts
// actually had (a single current-state snapshot). shap_explanations is not
// seeded here — real SHAP output comes from fusionSnapshot.ts's
// runDailySnapshotForToday() once this account has a real daily prediction.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const CHURN_THRESHOLD = 0.56; // models/churn_threshold.json

function riskBandFromProba(proba: number): 'High_Risk' | 'Medium_Risk' | 'Low_Risk' {
  if (proba >= CHURN_THRESHOLD) return 'High_Risk';
  if (proba >= CHURN_THRESHOLD * 0.5) return 'Medium_Risk';
  return 'Low_Risk';
}

function riskCategoryFromFusion(score: number): 'High_Risk' | 'Medium_Risk' | 'Low_Risk' {
  if (score > 70) return 'High_Risk';
  if (score > 30) return 'Medium_Risk';
  return 'Low_Risk';
}

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}

const accountSeeds = [
  {
    name: 'Acme Corp', riskHistory: [48, 55, 62, 70, 78, 85], churnModelScore: 72, fusionRiskScore: 85,
    summary: "Acme Corp's churn risk escalated to 85% primarily due to a 60% drop in user logins, a steep 45% reduction in API bandwidth, and recent technical friction with the v3 API upgrade. Support sentiment is highly frustrated with renewal approaching in 42 days. Proactive technical outreach and a retention discount are strongly recommended.",
  },
  {
    name: 'Globex Inc', riskHistory: [42, 52, 65, 74, 80, 84], churnModelScore: 82, fusionRiskScore: 84,
    summary: "Globex Inc is at 84% high churn risk due to procurement budget freezes and a 55% decline in product logins. Elena Rostova submitted a 20% retention discount request awaiting Director biometric approval.",
  },
  {
    name: 'Umbrella Tech', riskHistory: [60, 62, 65, 66, 68, 68], churnModelScore: 64, fusionRiskScore: 68,
    summary: "Umbrella Tech is at 68% risk following corporate seat downsizing. AM requested 12% fee reduction to retain tier.",
  },
  {
    name: 'CloudPulse Technologies', riskHistory: [38, 48, 60, 72, 86, 94], churnModelScore: 88, fusionRiskScore: 94,
    summary: "CloudPulse Technologies is at critical 94% risk of churn. An angry email from the VP demanded immediate termination due to recent cluster downtime. Combined with an 80% drop in API usage and renewal in 24 days, immediate executive escalation and a retention offer (>10% requiring Director verification) is required.",
  },
  {
    name: 'FinTech Nexus Solutions', riskHistory: [55, 59, 56, 58, 57, 58], churnModelScore: 52, fusionRiskScore: 58,
    summary: "FinTech Nexus shows moderate 58% risk. Core usage remains steady, but pricing sensitivity and competitor benchmarking were highlighted in recent feedback. A modest 10% discount or custom feature tiering would secure early renewal.",
  },
  {
    name: 'BioHealth Systems', riskHistory: [68, 62, 56, 52, 48, 44], churnModelScore: 35, fusionRiskScore: 44,
    summary: "BioHealth Systems is at 44% medium risk due to a transient HIPAA export complaint. Product adoption and API usage remain strong (+2%). Resolving the compliance export feature will easily stabilize the account.",
  },
  {
    name: 'Apex Logistics Global', riskHistory: [18, 16, 15, 14, 15, 15], churnModelScore: 12, fusionRiskScore: 15,
    summary: "Apex Logistics Global is a healthy, low-risk key account (15% risk score). Product usage and API calls are growing rapidly (+25%). Highly recommended candidate for upselling additional seat licenses.",
  },
  {
    name: 'Novus Media Labs', riskHistory: [40, 48, 52, 58, 62, 65], churnModelScore: 62, fusionRiskScore: 65,
    summary: "Novus Media Labs is at 65% medium risk on their Basic plan. Contract renewal is approaching in 16 days. Proactive retention discount or tier upgrade incentive is recommended.",
  },
  {
    name: 'Synergy AI Studio', riskHistory: [32, 30, 28, 28, 29, 28], churnModelScore: 22, fusionRiskScore: 28,
    summary: "Synergy AI Studio is a low-risk Basic account (28% risk). High usage velocity makes them an ideal candidate for upgrading to the Pro plan.",
  },
];

async function main() {
  let fusionRows = 0;

  for (const seed of accountSeeds) {
    const account = await prisma.account.findFirst({ where: { name: seed.name } });
    if (!account) {
      console.warn(`Skipping ${seed.name} — no matching account row (run the Phase 1 seed first).`);
      continue;
    }

    const churnToFusionRatio = seed.churnModelScore / seed.fusionRiskScore;
    let lastFusionScoreId: string | null = null;

    for (let i = 0; i < seed.riskHistory.length; i++) {
      const fusionValue = seed.riskHistory[i];
      const pointDate = monthsAgo(seed.riskHistory.length - 1 - i);
      const churnProba = Math.min(0.99, Math.max(0.01, (fusionValue * churnToFusionRatio) / 100));

      const churnPrediction = await prisma.churnPrediction.create({
        data: {
          accountId: account.id,
          predictedAt: pointDate,
          churnProba: Number(churnProba.toFixed(4)),
          riskBand: riskBandFromProba(churnProba),
        },
      });

      const fusionScore = await prisma.fusionScore.create({
        data: {
          accountId: account.id,
          snapshotDate: new Date(pointDate.toISOString().substring(0, 10)),
          computedAt: pointDate,
          churnPredictionId: churnPrediction.id,
          fusionScore: fusionValue,
          riskCategory: riskCategoryFromFusion(fusionValue),
        },
      });

      fusionRows++;
      lastFusionScoreId = fusionScore.id;
    }

    // shap_explanations for the current point aren't seeded here — real ones
    // (from model_service's /explain/churn, wrapping the actual trained
    // model) are saved by fusionSnapshot.ts's runDailySnapshotForToday()
    // once this account has a real daily prediction. The AI explanation
    // below still uses mockData.ts's hand-authored summary, unaffected.
    if (lastFusionScoreId) {
      await prisma.aiExplanation.create({
        data: {
          accountId: account.id,
          summary: seed.summary,
        },
      });
    }
  }

  // sentiment_predictions is intentionally not seeded here — real output from
  // the trained model is written by prisma/seed-sentiment.ts (which runs every
  // ticket's actual text through model_service's /predict/sentiment) and, for
  // every day going forward, by fusionSnapshot.ts's daily job.

  console.log(`Seeded ${fusionRows} churn_predictions + fusion_scores, ${accountSeeds.length} ai_explanations.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
