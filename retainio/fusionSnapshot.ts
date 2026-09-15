import { GoogleGenAI } from '@google/genai';
import { prisma } from './db';
import { OFFER_WINDOW_DAYS } from './pricing';

// Real daily fusion snapshots + monthly rollups. Not inside server.ts:
// server.ts boots an Express+Vite server as a side effect of being imported
// (see its startServer() call at module load), so the prisma/ scripts (and
// server.ts's own startup hook) need to reach this logic without that side
// effect. server.ts (its live-computation endpoints and its startup/interval
// daily check), renewals.ts and the prisma/ scripts all import from here.

const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL || 'http://127.0.0.1:8000';

export type RiskBandEnum = 'High_Risk' | 'Medium_Risk' | 'Low_Risk';

const RISK_BAND_ENUM: Record<string, RiskBandEnum> = {
  'High Risk': 'High_Risk',
  'Medium Risk': 'Medium_Risk',
  'Low Risk': 'Low_Risk',
};

export function fusionRiskCategory(fusionProba: number): RiskBandEnum {
  const pct = fusionProba * 100;
  if (pct > 70) return 'High_Risk';
  if (pct > 30) return 'Medium_Risk';
  return 'Low_Risk';
}

export function dateOnlyUTC(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export type SentimentClassValue = 'Frustrated' | 'Neutral' | 'Satisfied';

// model_service/app.py's SENTIMENT_RISK_WEIGHTS, mirrored so a human's label is scored on
// exactly the same scale the model's probabilities are averaged onto: 1 = certainly
// frustrated, 0 = certainly satisfied.
export const SENTIMENT_RISK_WEIGHT: Record<SentimentClassValue, number> = {
  Frustrated: 1.0,
  Neutral: 0.5,
  Satisfied: 0.0,
};

// A corrected label as the fusion model expects its input — three probabilities. A person
// saying "Neutral" is asserting it with certainty, which is the difference between a
// judgement and a prediction, so the mass goes entirely on one class.
export const CERTAIN_SENTIMENT: Record<SentimentClassValue, Record<SentimentClassValue, number>> = {
  Frustrated: { Frustrated: 1, Neutral: 0, Satisfied: 0 },
  Neutral:    { Frustrated: 0, Neutral: 1, Satisfied: 0 },
  Satisfied:  { Frustrated: 0, Neutral: 0, Satisfied: 1 },
};

export type ReviewCategoryValue = 'technical' | 'price' | 'general';

const REVIEW_CATEGORY_PROMPT = `You are classifying a customer support review into exactly one category.

Categories:
- technical: the review is about a bug, broken feature, integration issue, performance problem, or something not working as expected.
- price: the review is about cost, pricing, billing, discounts, or value for money.
- general: anything else (feature requests, praise, neutral questions, account admin, etc.)

Respond with ONLY one word: technical, price, or general.

Review: `;

// Cached on the review row: the text never changes, so re-classifying on every page load
// would be a paid call for a guaranteed-identical answer. Falls back to 'general' rather
// than throwing — losing the category must not take down whatever asked for it.
//
// Lives here rather than in server.ts because the renewal job needs it too: a renewal
// frozen before anyone has opened that account's uplift tab would otherwise fall back to
// a SHAP heuristic that defaults to price_sensitive, writing a WRONG driver onto a
// training row. A wrong feature value is worse than a missing one — it teaches the model
// an association that was never there.
export async function classifyReviewCategory(
  review: { id: string; reviewText: string; reviewCategory: ReviewCategoryValue | null },
): Promise<ReviewCategoryValue> {
  if (review.reviewCategory) return review.reviewCategory;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return 'general';

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: REVIEW_CATEGORY_PROMPT + review.reviewText,
    });
    const label = (response.text || '').trim().toLowerCase();
    const category: ReviewCategoryValue =
      label === 'technical' || label === 'price' || label === 'general' ? label : 'general';

    await prisma.customerReview.update({ where: { id: review.id }, data: { reviewCategory: category } });
    return category;
  } catch (err: any) {
    console.warn('Review classification failed:', err.message || err);
    return 'general';
  }
}

// Which of the two risk shapes the uplift model was trained on this account fits.
//
// It decides the SHAPE of the best offer — a price-led account wants a short sharp
// discount, technical friction wants a longer sustained one — so without it the model
// cannot rank durations at all. When the uplift model was retrained, adding this feature
// took exact-arm recovery from 13% to 30% and duration recovery from 30% to 61%.
//
// Shared so the value frozen onto a renewal record is derived exactly as the one sent for
// a live prediction. Two copies of this rule would mean training rows and prediction
// inputs disagreeing about the same account.
export function deriveDominantDriver(
  reviewCategory: string | null | undefined,
  shapExplanations: { featureName: string; direction: string; impact: number }[] | undefined,
): 'price_sensitive' | 'technical_friction' {
  if (reviewCategory === 'price') return 'price_sensitive';
  if (reviewCategory === 'technical') return 'technical_friction';
  // No Gemini classification yet: fall back to the strongest risk-increasing SHAP driver.
  const topFeature = [...(shapExplanations ?? [])]
    .filter(f => f.direction === 'risk_increase')
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))[0]?.featureName ?? '';
  return /API|Login|Usage/i.test(topFeature) ? 'technical_friction' : 'price_sensitive';
}

// The three numbers behind an account's fused risk score, which the fused score itself
// cannot be decomposed back into. Frozen onto a renewal record so the uplift and fusion
// models can be trained from it later; null when the account has never been scored.
export async function loadUpliftComponents(accountId: string, asOf?: Date) {
  const fusion = await prisma.fusionScore.findFirst({
    where: { accountId, ...(asOf ? { snapshotDate: { lte: asOf } } : {}) },
    orderBy: { snapshotDate: 'desc' },
    include: {
      churnPrediction: { include: { shapExplanations: true } },
      sentimentPrediction: true,
    },
  });
  const review = await prisma.customerReview.findFirst({
    where: { accountId },
    orderBy: { submittedAt: 'desc' },
    select: { id: true, reviewText: true, reviewCategory: true, correctedSentiment: true },
  });

  // Classify NOW if nobody has yet, rather than letting the heuristic guess. Classification
  // is otherwise lazy — it only happens when someone opens the uplift tab — so an account
  // that renews before anyone looks at it would be frozen with a fallback value. One
  // Gemini call per renewal, and roughly nine renewals a year.
  const reviewCategory = review ? await classifyReviewCategory(review) : null;

  return {
    fusedProba: fusion ? fusion.fusionScore / 100 : null,
    churnProba: fusion?.churnPrediction?.churnProba ?? null,
    // riskWeight, not the -1..1 `score`: the uplift model's sentiment_score is 0..1 with
    // HIGHER meaning more frustrated, which is riskWeight's exact scale and direction.
    //
    // A DISAGREEMENT wins here too: freezing the model's reading onto a training row
    // after somebody overruled it would teach the model back its own mistake. A mere
    // confirmation does not — agreeing with the label says nothing about the confidence,
    // and the model's own probability stays the better estimate of that.
    sentimentScore:
      review?.correctedSentiment && review.correctedSentiment !== fusion?.sentimentPrediction?.classification
        ? SENTIMENT_RISK_WEIGHT[review.correctedSentiment as SentimentClassValue]
        : fusion?.sentimentPrediction?.riskWeight ?? null,
    dominantShapDriver: fusion?.churnPrediction
      ? deriveDominantDriver(reviewCategory, fusion.churnPrediction.shapExplanations)
      : null,
  };
}

/**
 * Freezes the account as it stands NOW as the pre-treatment state for its next renewal.
 *
 * Called from three places, all before any treatment reaches the customer:
 *
 *   window_open     — the daily job, when the account first comes within OFFER_WINDOW_DAYS
 *                     of its renewal. No discount can exist yet, because the offer window
 *                     has only just opened. Every account gets one, which is what gives
 *                     the uplift model a control group measured at a consistent point.
 *   offer_approved  — a discount was approved. Replaces the window_open row, because the
 *                     moment of the decision is the truest answer to "what did we see when
 *                     we chose to act". Still pre-treatment: a discount does not take
 *                     effect until the renewal itself.
 *   intent_recorded — an upgrade, downgrade or departure was announced. Before this existed,
 *                     an account that gave notice at day 250 went unmeasured until the
 *                     window opened at day 180 — by which point it had spent seventy days
 *                     acting on the decision, and its features described that instead.
 *
 * Why not simply measure at the renewal, which would be far simpler: by then a departing
 * account's usage has already collapsed, so the features contain the answer. A model
 * trained on that learns "usage near zero means churn" — correct, and useless, because at
 * that point there is nothing left to act on.
 */
export async function captureIndexSnapshot(
  accountId: string,
  reason: 'window_open' | 'offer_approved' | 'intent_recorded',
  asOf: Date = new Date(),
) {
  const sub = await prisma.subscription.findFirst({
    where: { accountId }, orderBy: { termStart: 'desc' },
  });
  if (!sub || sub.status === 'churned') return null;

  const renewalDate = dateOnlyUTC(sub.termEnd);
  const existing = await prisma.renewalIndexSnapshot.findUnique({
    where: { accountId_renewalDate: { accountId, renewalDate } },
  });

  // The first measurement stands, with one exception: an approval may replace a routine
  // window snapshot, because it records what was seen when the decision to act was made.
  //
  // Nothing else ever replaces anything. In particular an approval does NOT replace an
  // intent snapshot: once a customer has announced a change, anything measured afterwards
  // is post-announcement, so a discount offered to talk them out of a downgrade is judged
  // against the account as it stood when they announced — not after it began shrinking.
  // Likewise a second intent (someone changing their mind) keeps the first, which is the
  // earliest signal. And the daily job never overwrites a decision-moment measurement.
  if (existing && !(reason === 'offer_approved' && existing.reason === 'window_open')) return existing;

  // Measured AT asOf. Passing it here is what makes a reconstructed index honest: the
  // features are the account's state when the window opened, not its state today.
  const featureSnapshot = await loadModelFeatures(accountId, asOf);
  if (!featureSnapshot) return null;
  const components = await loadUpliftComponents(accountId, asOf);

  const data = {
    frozenAt: asOf,
    reason,
    // Stored because treated and untreated rows are measured at different distances from
    // the renewal, and that gap is itself confounding. The propensity model can only
    // correct for it if it can see it.
    daysToRenewal: Math.round((sub.termEnd.getTime() - asOf.getTime()) / 86400000),
    featureSnapshot,
    churnProba: components.churnProba,
    sentimentScore: components.sentimentScore,
    fusedProba: components.fusedProba,
    dominantShapDriver: components.dominantShapDriver,
  };

  return prisma.renewalIndexSnapshot.upsert({
    where: { accountId_renewalDate: { accountId, renewalDate } },
    create: { accountId, renewalDate, ...data },
    update: data,
  });
}

/**
 * The daily pass: freeze any account that has just come within the offer window.
 *
 * This is what gives the uplift model its control group. An account nobody ever acts on
 * would otherwise have no pre-treatment measurement at all, and a model with only treated
 * rows cannot estimate an effect — there is nothing to compare against.
 */
export async function captureDueIndexSnapshots(asOf: Date = new Date()) {
  const subs = await prisma.subscription.findMany({ where: { status: 'active' } });
  const captured: { accountId: string; daysToRenewal: number }[] = [];

  for (const sub of subs) {
    const days = Math.round((sub.termEnd.getTime() - asOf.getTime()) / 86400000);
    // Outside the window, or already past the renewal — nothing to freeze.
    if (days > OFFER_WINDOW_DAYS || days < 0) continue;

    const renewalDate = dateOnlyUTC(sub.termEnd);
    const already = await prisma.renewalIndexSnapshot.findUnique({
      where: { accountId_renewalDate: { accountId: sub.accountId, renewalDate } },
    });
    if (already) continue;

    const snap = await captureIndexSnapshot(sub.accountId, 'window_open', asOf);
    if (snap) captured.push({ accountId: sub.accountId, daysToRenewal: days });
  }
  return captured;
}

// The churn model's six inputs for one account, straight from the tables. Lives here
// rather than in server.ts because renewals.ts freezes these at a renewal and server.ts
// serves them live — one definition, so a training row and a prediction can never be
// built from differently-shaped features.
// `asOf` reads the account as it stood on a past date rather than now. Needed because an
// index snapshot may have to be reconstructed for a window that opened months ago, and the
// whole point of the index is the state AT that moment — taking today's values would
// defeat it. Defaults to the latest snapshot, so every existing caller is unaffected.
export async function loadModelFeatures(accountId: string, asOf?: Date) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      subscriptions: { orderBy: { termStart: 'desc' }, take: 1 },
      usageSnapshots: {
        where: asOf ? { capturedAt: { lte: asOf } } : undefined,
        orderBy: { capturedAt: 'desc' }, take: 1,
      },
    },
  });

  const usage = account?.usageSnapshots[0];
  const sub = account?.subscriptions[0];
  if (!account || !usage || !sub) return null;

  return {
    Account_Age_Days: usage.accountAgeDays,
    Daily_Usage_Mins: usage.dailyUsageMins,
    Support_Tickets_90Days: usage.supportTickets90Days,
    API_Utilization_Rate: usage.apiUtilizationRate,
    Login_Frequency: usage.loginFrequencyBucket,
    Plan_Tier: sub.planTier,
  };
}

function monthStartUTC(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

// Chains all three real trained models — churn, sentiment, fusion — using an
// account's actual usage/subscription/ticket rows. Pure compute: never
// writes to the database itself. Used by rescoreAccountToday and
// runDailySnapshotForToday below (which do the writing), and by the usage simulator.
// A specific usage reading to score against, instead of the account's latest. The
// simulator uses this to score a historical day; without it, scoring 180 past days would
// mean re-chaining churn -> sentiment -> fusion in a second place, and a stored score and
// a live score built by two different chains is exactly how they drift apart.
export interface UsageReading {
  accountAgeDays: number;
  dailyUsageMins: number;
  supportTickets90Days: number;
  apiUtilizationRate: number;
  loginFrequencyBucket: string;
}

export async function computeRealFusion(
  accountId: string,
  overrideText?: string,
  usageOverride?: UsageReading,
) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      subscriptions: { orderBy: { termStart: 'desc' }, take: 1 },
      usageSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1 },
      customerReviews: { orderBy: { submittedAt: 'desc' }, take: 1 },
    },
  });
  if (!account) throw new Error('Account not found.');

  const usage = usageOverride ?? account.usageSnapshots[0];
  const sub = account.subscriptions[0];
  if (!usage || !sub) throw new Error(`${account.name} is missing a usage snapshot or subscription — cannot compute a real score.`);

  const text = overrideText ?? account.customerReviews[0]?.reviewText;
  if (!text) throw new Error(`${account.name} has no ticket/email text to analyze.`);

  const churnFeatures = {
    Account_Age_Days: usage.accountAgeDays,
    Daily_Usage_Mins: usage.dailyUsageMins,
    Support_Tickets_90Days: usage.supportTickets90Days,
    API_Utilization_Rate: usage.apiUtilizationRate,
    Login_Frequency: usage.loginFrequencyBucket,
    Plan_Tier: sub.planTier,
  };

  const [churnRes, sentRes] = await Promise.all([
    fetch(`${MODEL_SERVICE_URL}/predict/churn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(churnFeatures),
    }),
    fetch(`${MODEL_SERVICE_URL}/predict/sentiment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    }),
  ]);
  if (!churnRes.ok || !sentRes.ok) throw new Error(`Model bridge unavailable (churn ${churnRes.status}, sentiment ${sentRes.status}).`);

  const churnData = await churnRes.json();
  let sentData = await sentRes.json();

  // A person has read this review and disagreed with the model.
  //
  // Their label wins from here on. Leaving the model's reading in place would mean the
  // account's headline risk — and the uplift model's discount recommendation, which reads
  // sentiment_score — stayed built on a reading somebody has established is wrong.
  //
  // Applied by substituting a CERTAIN distribution for the model's probabilities, so it
  // flows through the same fusion call rather than a parallel code path. A human label
  // carries no uncertainty, which is exactly what makes it worth more than a prediction.
  // The model's own reading is kept on `modelSaid` so nothing is hidden: the UI shows both.
  // ONLY a disagreement overrides. Agreeing with the model records that a person checked
  // the label — worth having as training data — but says nothing about how confident to
  // be, and the model's probabilities remain the better estimate of that. If agreeing also
  // forced the weight to a certainty, a manager working through every account would
  // replace the model's judgement everywhere and the sentiment model would stop reaching
  // the fusion score at all.
  const rawCorrection = overrideText ? null : account.customerReviews[0]?.correctedSentiment;
  const correction = rawCorrection && rawCorrection !== sentData.classification ? rawCorrection : null;
  if (correction) {
    sentData = {
      ...sentData,
      // The model's own reading is preserved untouched. sentiment_predictions rows are a
      // history of what the MODEL said at a point in time; rewriting them with a human's
      // answer would erase the disagreement the correction exists to record.
      modelClassification: sentData.classification,
      modelRiskWeight: sentData.risk_weight,
      // The effective reading, used for fusion, for the uplift model's sentiment_score,
      // and for display.
      classification: correction,
      probabilities: CERTAIN_SENTIMENT[correction as SentimentClassValue],
      score: correction === 'Satisfied' ? 1 : correction === 'Frustrated' ? -1 : 0,
      risk_weight: SENTIMENT_RISK_WEIGHT[correction as SentimentClassValue],
      corrected: true,
    };
  }

  const fusionRes = await fetch(`${MODEL_SERVICE_URL}/predict/fusion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ churn_proba: churnData.churn_proba, sentiment_probabilities: sentData.probabilities }),
  });
  if (!fusionRes.ok) throw new Error(`Fusion model unavailable (${fusionRes.status}).`);
  const fusionData = await fusionRes.json();

  return { account, churnData, sentData, fusionData, churnFeatures };
}

// SHAP gives a feature name + numeric impact, not a sentence — this builds an
// honest, factual description from the account's own real feature values
// (not a fabricated narrative), for the 5 raw numeric features and the
// one-hot Login_Frequency_*/Plan_Tier_* dummy columns /explain/churn can
// return (see model_service/app.py's ALL_FEATURE_NAMES).
function describeShapFeature(featureName: string, f: {
  Account_Age_Days: number; Daily_Usage_Mins: number; Support_Tickets_90Days: number;
  API_Utilization_Rate: number; Login_Frequency: string; Plan_Tier: string;
}): string {
  switch (featureName) {
    case 'Account_Age_Days': return `Account age: ${f.Account_Age_Days} days`;
    case 'Daily_Usage_Mins': return `Daily usage: ${f.Daily_Usage_Mins} minutes/day`;
    case 'Support_Tickets_90Days': return `Support tickets (last 90 days): ${f.Support_Tickets_90Days}`;
    case 'API_Utilization_Rate': return `API utilization rate: ${(f.API_Utilization_Rate * 100).toFixed(0)}%`;
    case 'Support_Ticket_Friction': {
      const friction = f.Support_Tickets_90Days / (f.Daily_Usage_Mins + 1);
      return `Support tickets relative to usage: ${friction.toFixed(2)}`;
    }
  }
  if (featureName.startsWith('Login_Frequency_')) {
    return describeOneHot(featureName, 'Login_Frequency_', 'Login frequency', f.Login_Frequency);
  }
  if (featureName.startsWith('Plan_Tier_')) {
    return describeOneHot(featureName, 'Plan_Tier_', 'Plan tier', f.Plan_Tier);
  }
  return featureName.replace(/_/g, ' ');
}

// The categorical inputs were one-hot encoded at training time, so the model
// sees one column per category (Login_Frequency_Daily/_Weekly/_Rarely) and
// SHAP scores each separately — including the ones that are 0 for this
// account. Describing all of them as just "Login frequency: Rarely" would be
// misleading (three rows, same text, different numbers), so an unset column
// is labelled as the absence it actually represents.
function describeOneHot(dummyName: string, prefix: string, label: string, actualValue: string): string {
  const category = dummyName.slice(prefix.length);
  return category === actualValue
    ? `${label}: ${actualValue}`
    : `${label} is not "${category}" (actual: ${actualValue})`;
}

// Calls the real SHAP explainer (model_service's /explain/churn, wrapping
// churn_gradient_boosting.pkl) and persists the top factors for one
// churnPrediction row. Failures here are non-fatal — SHAP is a supplementary
// explanation, not part of the core churn/sentiment/fusion chain — so a
// failure here must never mark the whole account's daily snapshot as failed.
export async function saveShapExplanations(
  churnPredictionId: string,
  churnFeatures: { Account_Age_Days: number; Daily_Usage_Mins: number; Support_Tickets_90Days: number; API_Utilization_Rate: number; Login_Frequency: string; Plan_Tier: string },
) {
  const res = await fetch(`${MODEL_SERVICE_URL}/explain/churn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(churnFeatures),
  });
  if (!res.ok) throw new Error(`SHAP explainer unavailable (${res.status}).`);
  const data = await res.json();

  await prisma.shapExplanation.createMany({
    data: data.factors.map((f: { feature: string; impact: number; direction: 'risk_increase' | 'risk_decrease' }) => ({
      churnPredictionId,
      featureName: f.feature,
      impact: f.impact,
      direction: f.direction,
      description: describeShapFeature(f.feature, churnFeatures),
    })),
  });
}

// Writes the "Executive Diagnosis" shown on the SHAP tab, generated by Gemini
// from this prediction's OWN numbers — the real fusion score, churn
// probability, sentiment class and SHAP factors.
//
// These used to be hand-authored strings seeded from mockData.ts, and they
// drifted badly: Umbrella Tech's claimed "68% risk" while the model scored it
// 17, and BioHealth's claimed 44% against a real 9. A summary that states a
// risk number has to be generated from that number, not written beside it.
//
// Replaces the account's previous explanation rather than appending: this
// describes the current state, and keeping superseded ones is how the stale
// text survived in the first place. Failures are non-fatal — the diagnosis is
// commentary on the prediction, not part of producing it.
export async function generateAiExplanation(accountId: string): Promise<boolean> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return false;

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      fusionScores: {
        orderBy: { snapshotDate: 'desc' },
        take: 1,
        include: {
          churnPrediction: { include: { shapExplanations: true } },
          sentimentPrediction: true,
        },
      },
    },
  });

  const fusion = account?.fusionScores[0];
  const churn = fusion?.churnPrediction;
  if (!account || !fusion || !churn) return false;

  // Only the drivers that actually moved this prediction, strongest first.
  const factors = [...churn.shapExplanations]
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 5)
    .map(f => `${f.description} (${f.impact > 0 ? '+' : ''}${f.impact} pts, ${f.direction === 'risk_increase' ? 'increases risk' : 'protects account'})`);

  const factorList = factors.map(f => '- ' + f).join('\n');

  const prompt = `You are RetainIO's Explainable AI Business Translator.
Translate this account's churn model output into a concise business insight for an Account Manager.

Account: ${account.name} (${account.industry})
Fusion Risk Score: ${fusion.fusionScore}/100 (${fusion.riskCategory.replace('_', ' ')})
Churn model probability: ${(churn.churnProba * 100).toFixed(1)}%
Support ticket sentiment: ${fusion.sentimentPrediction?.classification ?? 'unknown'}
Top contributing factors:
${factorList}

Requirements:
- Open by stating the fusion risk score in the form "X/100", using the exact number above.
- State why this account scores as it does, in plain business language.
- Reference the actual figures above. Do not invent numbers, events, discounts or requests.
- If the risk is low, say so plainly rather than manufacturing concern.
- End with one concrete next action.
- Under 60 words. Plain text only — no markdown, no bold, no headers.`;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: prompt });
    // The model occasionally emphasises its closing line despite the prompt;
    // this text renders as plain text in the UI, so literal ** would show.
    const summary = (response.text || '').replace(/\*\*/g, '').trim();
    if (!summary) return false;

    await prisma.aiExplanation.deleteMany({ where: { accountId } });
    await prisma.aiExplanation.create({ data: { accountId, summary } });
    return true;
  } catch (err: any) {
    console.warn(`AI explanation failed for ${account.name}:`, err.message || err);
    return false;
  }
}

// Recomputes one account's monthly average from whatever real daily
// FusionScore rows actually exist for that month — gaps (days the server
// wasn't running) are simply absent from the average, never filled with a
// guessed value. No-ops if the account has zero real snapshots that month.
export async function rollupMonthlyForAccount(accountId: string, monthStart: Date) {
  const nextMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));

  const rows = await prisma.fusionScore.findMany({
    where: { accountId, snapshotDate: { gte: monthStart, lt: nextMonthStart } },
  });
  if (rows.length === 0) return null;

  const avgFusionScore = rows.reduce((sum, r) => sum + r.fusionScore, 0) / rows.length;

  return prisma.fusionMonthlySummary.upsert({
    where: { accountId_monthStart: { accountId, monthStart } },
    create: {
      accountId,
      monthStart,
      avgFusionScore,
      sampleCount: rows.length,
      riskCategory: fusionRiskCategory(avgFusionScore / 100),
    },
    update: {
      avgFusionScore,
      sampleCount: rows.length,
      riskCategory: fusionRiskCategory(avgFusionScore / 100),
      computedAt: new Date(),
    },
  });
}

// The daily job: for every account, if today's row doesn't already exist,
// compute and store one. Idempotent — safe to call multiple times the same
// day (upsert on the (accountId, snapshotDate) unique constraint). No
// date-range catch-up: only ever "today," per the product decision that
// missed days should stay missed rather than being filled with a repeated
// guess (there's no per-day historical usage data to make a missed day's
// value genuinely different from today's anyway).
// Recomputes and REPLACES today's score for one account.
//
// Called when a person corrects the sentiment on a review. The daily job deliberately
// skips an account that already has today's row, so without this the corrected score
// would not appear until tomorrow — and the person who made the correction would see
// nothing change, which reads as the correction having failed.
//
// Writes fresh churn/sentiment predictions rather than editing the old ones: those rows
// are a history of what the models said at a point in time, and rewriting them would lose
// the fact that the reading changed.
export async function rescoreAccountToday(accountId: string) {
  // Refused for a customer who has left, so no caller - the Re-score button, the inbox check, a
  // sentiment correction - can overwrite the score it left at (see runDailySnapshotForToday).
  const latest = await prisma.subscription.findFirst({
    where: { accountId },
    orderBy: { termStart: 'desc' },
    select: { status: true, account: { select: { name: true } } },
  });
  if (latest?.status === 'churned') {
    throw new Error(`${latest.account.name} has churned; its last score is kept as the risk when it left.`);
  }
  const snapshotDate = dateOnlyUTC();
  const monthStart = monthStartUTC(snapshotDate);

  const { churnData, sentData, fusionData, churnFeatures } = await computeRealFusion(accountId);

  const churnPrediction = await prisma.churnPrediction.create({
    data: {
      accountId,
      churnProba: churnData.churn_proba,
      riskBand: RISK_BAND_ENUM[churnData.risk_band],
    },
  });
  try {
    await saveShapExplanations(churnPrediction.id, churnFeatures);
  } catch (err: any) {
    console.warn('SHAP explanation failed during rescore:', err.message || err);
  }

  const review = await prisma.customerReview.findFirst({
    where: { accountId },
    orderBy: { submittedAt: 'desc' },
  });

  // Stores what the MODEL said, not the corrected value — this table is model-output
  // history. The correction lives on the review, and everything downstream reads
  // "corrected ?? model", so the two never get confused for one another.
  const sentimentPrediction = await prisma.sentimentPrediction.create({
    data: {
      reviewId: review?.id,
      classification: sentData.modelClassification ?? sentData.classification,
      riskWeight: sentData.modelRiskWeight ?? sentData.risk_weight,
    },
  });

  await prisma.fusionScore.upsert({
    where: { accountId_snapshotDate: { accountId, snapshotDate } },
    create: {
      accountId,
      snapshotDate,
      churnPredictionId: churnPrediction.id,
      sentimentPredictionId: sentimentPrediction.id,
      fusionScore: Math.round(fusionData.fusion_proba * 100),
      riskCategory: fusionRiskCategory(fusionData.fusion_proba),
    },
    update: {
      churnPredictionId: churnPrediction.id,
      sentimentPredictionId: sentimentPrediction.id,
      fusionScore: Math.round(fusionData.fusion_proba * 100),
      riskCategory: fusionRiskCategory(fusionData.fusion_proba),
      computedAt: new Date(),
    },
  });

  // Clear up what this rescore just superseded.
  //
  // Every call writes a fresh churn and sentiment prediction and repoints today's fusion
  // score at them, which leaves the previous pair referenced by nothing — plus their SHAP
  // rows. Clicking through the three sentiment options left 23 churn predictions on one
  // account in one day, 297 SHAP rows among them, none of it read by anything.
  //
  // A time-based throttle would have been the wrong fix: correcting Frustrated to Satisfied
  // to Neutral genuinely has to recompute each time, or the displayed score stops matching
  // the correction. The recomputes are legitimate; only the leftovers are not.
  //
  // Scoped hard: this account, today only, and only rows no fusion score points at. History
  // is never touched, and the pair written above is referenced so it cannot be caught. The
  // newest sentiment row also survives by the same token, which matters because mapAccount
  // reads it directly for `modelSentiment` rather than through the fusion score.
  try {
    const orphanedChurn = await prisma.churnPrediction.findMany({
      where: { accountId, predictedAt: { gte: snapshotDate }, fusionScores: { none: {} } },
      select: { id: true },
    });
    if (orphanedChurn.length) {
      const ids = orphanedChurn.map(o => o.id);
      // SHAP references a churn prediction with no cascade, so it has to go first.
      await prisma.shapExplanation.deleteMany({ where: { churnPredictionId: { in: ids } } });
      await prisma.churnPrediction.deleteMany({ where: { id: { in: ids } } });
    }
    // Scoped to THIS review, not the account. mapAccount reads the newest sentiment row of
    // the newest review directly for `modelSentiment`, so a wider sweep could delete a row
    // that is unreferenced by any fusion score yet still on screen. The row written above
    // is referenced, so this can only ever catch ones it superseded.
    if (review) {
      await prisma.sentimentPrediction.deleteMany({
        where: { reviewId: review.id, predictedAt: { gte: snapshotDate }, fusionScores: { none: {} } },
      });
    }
  } catch (err: any) {
    console.warn('Could not clear superseded predictions:', err.message || err);
  }

  await rollupMonthlyForAccount(accountId, monthStart);

  // The diagnosis quotes the score, so it has to move with it.
  //
  // This function exists precisely to change an account's displayed risk — after a
  // sentiment correction, or when someone presses Re-score — and without this the summary
  // underneath kept stating the previous score and the previous sentiment. A person
  // correcting "Frustrated" to "Satisfied" would watch the number change while the text
  // below still explained the frustration.
  //
  // Non-fatal, matching the sentiment-correction path's own rule: losing Gemini must not
  // lose the person's judgement, and the daily pass will refresh it regardless.
  try {
    await generateAiExplanation(accountId);
  } catch (err: any) {
    console.warn('Diagnosis refresh failed after rescore:', err.message || err);
  }

  return {
    fusionScore: Math.round(fusionData.fusion_proba * 100),
    classification: sentData.classification,
    riskWeight: sentData.risk_weight,
    corrected: Boolean(sentData.corrected),
  };
}

export async function runDailySnapshotForToday() {
  const snapshotDate = dateOnlyUTC();
  const monthStart = monthStartUTC(snapshotDate);

  const accounts = await prisma.account.findMany({
    select: { id: true, name: true, subscriptions: { orderBy: { termStart: 'desc' }, take: 1, select: { status: true } } },
  });

  let succeeded = 0;
  let skipped = 0;
  let churned = 0;
  const errors: { account: string; message: string }[] = [];

  for (const account of accounts) {
    // A customer who has left is not re-scored. Its last score stays as the risk it left at; a
    // fresh "risk of leaving" every day - with a paid Gemini summary each time - for a customer
    // already gone would be both wrong and wasted.
    if (account.subscriptions[0]?.status === 'churned') {
      churned++;
      continue;
    }
    try {
      const existing = await prisma.fusionScore.findUnique({
        where: { accountId_snapshotDate: { accountId: account.id, snapshotDate } },
      });
      if (existing) {
        skipped++;

        // The score for today already exists — but something else wrote it, and that
        // something may not have refreshed the diagnosis underneath it.
        //
        // The Gemini summary quotes this account's own figures ("a Fusion Risk Score of
        // 56/100", "77.7% churn probability"), so it is only true of the numbers it was
        // generated from. It used to be produced solely at the end of this loop body,
        // which the simulator bypasses by writing today's fusion score before this pass
        // runs. The result was a diagnosis frozen on 4 September sitting directly beneath
        // a displayed score of 89 — every figure in it wrong, and stated confidently.
        //
        // Regenerating whenever the diagnosis predates the score covers every writer of
        // that row, not just the simulator, and is self-limiting: once rewritten it is
        // newer than the score, so this does not fire again until the score changes.
        try {
          const diagnosis = await prisma.aiExplanation.findFirst({
            where: { accountId: account.id },
            orderBy: { generatedAt: 'desc' },
          });
          if (!diagnosis || diagnosis.generatedAt < existing.computedAt) {
            await generateAiExplanation(account.id);
          }
        } catch (err: any) {
          console.warn(`Diagnosis refresh failed for ${account.name}:`, err.message || err);
        }
        continue;
      }

      // computeRealFusion applies any sentiment correction on this account's review, so
      // a corrected account is NOT quietly reverted to the model's own reading by the
      // next nightly run. Without that, an override would last until 3am.
      const { churnData, sentData, fusionData, churnFeatures } = await computeRealFusion(account.id);

      const churnPrediction = await prisma.churnPrediction.create({
        data: {
          accountId: account.id,
          churnProba: churnData.churn_proba,
          riskBand: RISK_BAND_ENUM[churnData.risk_band],
        },
      });

      try {
        await saveShapExplanations(churnPrediction.id, churnFeatures);
      } catch (shapErr: any) {
        console.warn(`SHAP explanation failed for ${account.name} (churn/sentiment/fusion still saved):`, shapErr.message);
      }

      const ticket = await prisma.customerReview.findFirst({
        where: { accountId: account.id },
        orderBy: { submittedAt: 'desc' },
      });

      // Model output, not any correction on the review — see rescoreAccountToday.
      const sentimentPrediction = await prisma.sentimentPrediction.create({
        data: {
          reviewId: ticket?.id,
          classification: sentData.modelClassification ?? sentData.classification,
          riskWeight: sentData.modelRiskWeight ?? sentData.risk_weight,
        },
      });

      await prisma.fusionScore.create({
        data: {
          accountId: account.id,
          snapshotDate,
          churnPredictionId: churnPrediction.id,
          sentimentPredictionId: sentimentPrediction.id,
          fusionScore: Math.round(fusionData.fusion_proba * 100),
          riskCategory: fusionRiskCategory(fusionData.fusion_proba),
        },
      });

      await rollupMonthlyForAccount(account.id, monthStart);

      // After the fusion row and its SHAP factors exist, so the diagnosis is
      // written from this day's actual numbers.
      await generateAiExplanation(account.id);

      succeeded++;
    } catch (err: any) {
      errors.push({ account: account.name, message: err.message || String(err) });
    }
  }

  return { date: snapshotDate.toISOString().substring(0, 10), succeeded, skipped, churned, errors };
}
