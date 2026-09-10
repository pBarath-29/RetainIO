import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { prisma } from '../db';
import { fusionRiskCategory } from '../fusionSnapshot';

/**
 * Writes everything the app has learned from real accounts into CSVs shaped exactly like
 * the training data the models were originally fitted on.
 *
 *   npx tsx prisma/export-renewal-outcomes.ts
 *
 * Deliberately separate from retraining: the files land in Datasets/feedback/ where they
 * can be read before anything is fitted. An export you cannot inspect is an export you
 * have to trust.
 *
 * Two feedback sources, and they answer different questions:
 *
 *   renewal_records   — did this account stay, given these features and this discount?
 *                       Trains churn, uplift and fusion.
 *   customer_reviews  — what did this review actually mean?
 *                       Trains sentiment. Renewal outcomes CANNOT: a furious customer can
 *                       still renew, and the fusion model needs sentiment to remain an
 *                       independent signal rather than a second churn predictor.
 *
 * Every row carries `is_assumed`. A renewal nobody confirmed — the job defaulted to
 * "renewed" because no notice was given — is a weaker label than one a person recorded,
 * and the flag travels with the data so that stays visible instead of being averaged away.
 */
const OUT_DIR = path.resolve(process.cwd(), '..', 'Datasets', 'feedback');

const csvEscape = (v: any): string => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const writeCsv = (file: string, cols: string[], rows: Record<string, any>[]) => {
  const body = [cols.join(','), ...rows.map(r => cols.map(c => csvEscape(r[c])).join(','))].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, file), body + '\n', 'utf8');
  return rows.length;
};

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Renewal outcomes ────────────────────────────────────────────────────────
const renewals = await prisma.renewalRecord.findMany({
  include: { account: true },
  orderBy: { renewalDate: 'asc' },
});

const upliftRows: Record<string, any>[] = [];
const churnRows: Record<string, any>[] = [];
let skipped = 0;

for (const r of renewals) {
  const f = r.featureSnapshot as any;
  // A row missing any model input is dropped rather than filled in. A guessed feature
  // value teaches the model an association that never existed, which is worse than
  // having one fewer row.
  const complete = f?.Account_Age_Days !== undefined && r.churnProba !== null
    && r.sentimentScore !== null && r.dominantShapDriver !== null && r.predictedRisk !== null;
  if (!complete) { skipped++; continue; }

  const isAssumed = r.autoRecorded ? 1 : 0;
  // How far before the renewal the features were measured. A row measured AT the renewal
  // (0 days) is leaky — a departing account's usage has already collapsed by then, so the
  // features contain the outcome. Exported with the flag rather than silently dropped, so
  // the count is visible and the training script can decide.
  const indexDays = r.daysToRenewalAtIndex ?? 0;

  upliftRows.push({
    customer_id: r.accountId,
    Account_Age_Days: f.Account_Age_Days,
    Daily_Usage_Mins: f.Daily_Usage_Mins,
    Support_Tickets_90Days: f.Support_Tickets_90Days,
    API_Utilization_Rate: f.API_Utilization_Rate,
    churn_proba: r.churnProba,
    sentiment_score: r.sentimentScore,
    fused_proba: r.predictedRisk,
    Login_Frequency: f.Login_Frequency,
    Plan_Tier: f.Plan_Tier,
    Dominant_SHAP_Driver: r.dominantShapDriver,
    risk_band: fusionRiskCategory(r.predictedRisk!).replace('_Risk', ''),
    discount_pct: r.discountPct,
    discount_months: r.discountMonths,
    Retained: r.retained ? 1 : 0,
    is_assumed: isAssumed,
    days_to_renewal_at_index: indexDays,
    features_frozen_at: r.featuresFrozenAt?.toISOString().slice(0, 10) ?? '',
    // What froze the features: the calendar (window_open), a discount approval, or the
    // customer announcing a change. Rows of the last kind are measured no later than the
    // decision became known — not before it — so training can filter on this if it matters.
    index_reason: r.indexReason ?? '',
  });

  churnRows.push({
    Account_Age_Days: f.Account_Age_Days,
    Daily_Usage_Mins: f.Daily_Usage_Mins,
    Support_Tickets_90Days: f.Support_Tickets_90Days,
    API_Utilization_Rate: f.API_Utilization_Rate,
    Login_Frequency: f.Login_Frequency,
    Plan_Tier: f.Plan_Tier,
    // Churn is the OPPOSITE of retained. Getting this backwards would train every model
    // to predict the reverse of reality while looking perfectly healthy.
    Churn: r.retained ? 0 : 1,
    is_assumed: isAssumed,
    days_to_renewal_at_index: indexDays,
    index_reason: r.indexReason ?? '',
  });
}

// ── Sentiment labels ────────────────────────────────────────────────────────
const corrected = await prisma.customerReview.findMany({
  where: { correctedSentiment: { not: null } },
  include: {
    account: true,
    sentimentPredictions: { orderBy: { predictedAt: 'desc' }, take: 1 },
  },
});

const sentimentRows = corrected.map(c => ({
  review_text: c.reviewText,
  sentiment: c.correctedSentiment,
  text_length: c.reviewText.length,
  // Whether a person overruled the model or endorsed it. Both are verified labels and
  // both belong in training — a set made only of the model's mistakes would be all hard
  // cases and would skew it — but which is which is worth keeping.
  source: c.correctedSentiment === c.sentimentPredictions[0]?.classification ? 'confirmed' : 'corrected',
}));

const nUplift = writeCsv('uplift_real.csv', [
  'customer_id', 'Account_Age_Days', 'Daily_Usage_Mins', 'Support_Tickets_90Days',
  'API_Utilization_Rate', 'churn_proba', 'sentiment_score', 'fused_proba',
  'Login_Frequency', 'Plan_Tier', 'Dominant_SHAP_Driver', 'risk_band',
  'discount_pct', 'discount_months', 'Retained', 'is_assumed',
  'days_to_renewal_at_index', 'features_frozen_at', 'index_reason',
], upliftRows);

const nChurn = writeCsv('churn_real.csv', [
  'Account_Age_Days', 'Daily_Usage_Mins', 'Support_Tickets_90Days',
  'API_Utilization_Rate', 'Login_Frequency', 'Plan_Tier', 'Churn', 'is_assumed',
  'days_to_renewal_at_index', 'index_reason',
], churnRows);

const nSent = writeCsv('sentiment_real.csv', ['review_text', 'sentiment', 'text_length', 'source'], sentimentRows);

const assumed = upliftRows.filter(r => r.is_assumed === 1).length;
const leaky = upliftRows.filter(r => r.days_to_renewal_at_index <= 0).length;
const churned = upliftRows.filter(r => r.Retained === 0).length;
const atAnnouncement = upliftRows.filter(r => r.index_reason === 'intent_recorded').length;

console.log(`\nExported to Datasets/feedback/\n`);
console.log(`  uplift_real.csv     ${nUplift} row(s)   -> uplift model`);
console.log(`  churn_real.csv      ${nChurn} row(s)   -> churn model (and fusion, via uplift_real)`);
console.log(`  sentiment_real.csv  ${nSent} row(s)   -> sentiment model`);
if (skipped) console.log(`\n  ${skipped} renewal(s) skipped — incomplete model inputs, not guessed at`);

console.log(`\nWHAT THIS DATA IS`);
console.log(`  renewals total      ${nUplift}`);
console.log(`  ...confirmed        ${nUplift - assumed}   a person recorded or corrected the outcome`);
console.log(`  ...assumed          ${assumed}   auto-renewed with nobody confirming (is_assumed=1)`);
console.log(`  ...ended in churn   ${churned}`);
console.log(`\nFEATURE TIMING (the difference between a usable row and a leaky one)`);
if (leaky) {
  console.log(`  ${leaky} row(s) measured AT the renewal — no index snapshot existed.`);
  console.log(`  Those features already contain the outcome and should not train a model.`);
} else if (nUplift) {
  const days = upliftRows.map(r => r.days_to_renewal_at_index);
  console.log(`  every row measured before its renewal: ${Math.min(...days)}-${Math.max(...days)} days out`);
}
if (atAnnouncement) {
  console.log(`  ${atAnnouncement} row(s) frozen when the customer announced a change (index_reason=intent_recorded).`);
  console.log(`  Measured no later than the decision became known, not before it: less leaky than`);
  console.log(`  waiting for the window, but not leak-free. Filter on index_reason if that matters.`);
}
if (nUplift > 0 && churned === 0) {
  console.log(`\n  NOTE: every row is a retention. A classifier cannot learn a boundary from a`);
  console.log(`  single class, so these rows can only be added to the existing data, never`);
  console.log(`  trained on alone.`);
}
console.log(`\n  sentiment labels    ${nSent}  (${sentimentRows.filter(s => s.source === 'corrected').length} corrected, ${sentimentRows.filter(s => s.source === 'confirmed').length} confirmed)`);
console.log(`\nNext: python Datasets/retrain_with_outcomes.py\n`);

await prisma.$disconnect();
