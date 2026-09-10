import { PlanTier, RenewalOutcome, IntentKind } from '@prisma/client';
import { prisma } from './db';
import { dateOnlyUTC, loadModelFeatures, loadUpliftComponents } from './fusionSnapshot';
import { MONTHS_PER_TERM, TIER_MONTHLY_RATE, addMonths } from './pricing';

// Closing the loop: recording what an account ACTUALLY did at its renewal, so the models
// can eventually be trained against outcomes instead of only predicting them.
//
// Nothing here asks a person to fill in a form. Annual contracts auto-renew unless notice
// is given — churn is the affirmative act — so renewal is the default outcome and is
// recorded automatically at the term boundary. Anything else is a RenewalIntent recorded
// ahead of time, held (changing nothing) until the renewal, and resolved here.
//
// THE HONEST LIMITATION, which the write-up must state: nine accounts produce nine
// renewals a year against 180,000 synthetic training rows, and under auto-renewal nearly
// all of them carry the same label. The real contribution is not just small, it is almost
// entirely one class. `autoRecorded` marks every row nobody confirmed so this stays
// visible downstream rather than being laundered into a fact.

// The account named as the actor on anything done automatically.
//
// AuditLog.approverId is required, and that is deliberate — it is what guarantees every
// discount approval names a real approver. A renewal resolved at its term boundary has no
// human behind it, so rather than loosen that column (weakening the guarantee for every
// row) or borrow a real person's name (inventing a fact), the actor is a row that is
// honestly not a person. It cannot log in and never appears in a user list.
const SYSTEM_ACTOR_EMAIL = 'system@retainio.internal';
let systemActorIdCache: string | null = null;

export async function systemActorId(): Promise<string> {
  if (systemActorIdCache) return systemActorIdCache;
  const actor = await prisma.user.upsert({
    where: { email: SYSTEM_ACTOR_EMAIL },
    update: {},
    create: {
      role: 'system',
      name: 'RetainIO System',
      email: SYSTEM_ACTOR_EMAIL,
      // No password hash: there is nothing to authenticate as.
      title: 'Automated Process',
      department: 'Platform',
      employeeId: 'SYSTEM',
      maxSelfApprovalLimit: 0,   // it approves nothing; it only records what happened
      avatarInitials: 'SY',
    },
  });
  systemActorIdCache = actor.id;
  return actor.id;
}

// No intent at all resolves to 'renewed' (see resolveOneRenewal), which is why there is no
// intent kind for it: renewing as-is is what auto-renewal does when nobody records anything.
const OUTCOME_FOR_INTENT: Record<IntentKind, RenewalOutcome> = {
  upgrading: 'upgraded',
  downgrading: 'downgraded',
  churning: 'left',
};

// Three of the four outcomes are renewals. A downgrade is still a customer who stayed,
// and dropping it would throw away most of the positive labels.
export const isRetained = (outcome: RenewalOutcome): boolean => outcome !== 'left';

// How a renewal reads in the audit ledger, alongside entries like "10% Retention Discount
// for 6 months Executed". Spelled out rather than built from the enum, which produced
// "Renewal Renewed".
const RENEWAL_ACTION_LABEL: Record<RenewalOutcome, string> = {
  renewed:    'Contract Renewed',
  upgraded:   'Contract Renewed — Plan Upgraded',
  downgraded: 'Contract Renewed — Plan Downgraded',
  left:       'Contract Not Renewed — Account Churned',
};

export interface RenewalRunSummary {
  processed: { account: string; renewalDate: string; outcome: RenewalOutcome; autoRecorded: boolean }[];
  skipped: number;
  errors: { account: string; message: string }[];
}

/**
 * Resolves every renewal whose date has passed and has no outcome recorded yet.
 *
 * Idempotent from two directions, which matters because the caller runs at startup AND on
 * an interval: rolling the term moves `termEnd` out of range, and the
 * @@unique([accountId, renewalDate]) constraint rejects a duplicate outright. A second
 * pass, or a crash midway through, cannot roll the same term twice.
 */
export async function runRenewalsForToday(now: Date = new Date()): Promise<RenewalRunSummary> {
  const summary: RenewalRunSummary = { processed: [], skipped: 0, errors: [] };

  const due = await prisma.subscription.findMany({
    where: { termEnd: { lte: now }, status: 'active' },
    include: { account: true },
  });

  for (const sub of due) {
    try {
      // A subscription can be several terms behind if the server was down across a
      // renewal, so catch up rather than leaving the account stuck with termEnd in the
      // past — which would also mean its discount could never become active.
      let termEnd = sub.termEnd;
      let planTier = sub.planTier;
      let guard = 0;

      while (termEnd <= now && guard++ < 25) {
        const result = await resolveOneRenewal(sub.id, sub.accountId, sub.account.name, termEnd, planTier);
        if (result.kind === 'already-recorded') { summary.skipped++; break; }

        summary.processed.push(result.record);
        if (result.kind === 'churned') break;   // no term to roll; the account has gone

        termEnd = result.nextTermEnd;
        planTier = result.nextTier;
      }
    } catch (err: any) {
      summary.errors.push({ account: sub.account.name, message: err.message || String(err) });
    }
  }

  return summary;
}

type RenewalRow = RenewalRunSummary['processed'][number];

type ResolveResult =
  | { kind: 'already-recorded' }
  | { kind: 'churned'; record: RenewalRow }
  | { kind: 'rolled'; record: RenewalRow; nextTermEnd: Date; nextTier: PlanTier };

async function resolveOneRenewal(
  subscriptionId: string,
  accountId: string,
  accountName: string,
  termEnd: Date,
  planTier: PlanTier,
): Promise<ResolveResult> {
  const renewalDate = dateOnlyUTC(termEnd);

  const existing = await prisma.renewalRecord.findUnique({
    where: { accountId_renewalDate: { accountId, renewalDate } },
  });
  if (existing) return { kind: 'already-recorded' };

  // The intent recorded FOR THIS RENEWAL — matched on its effective date, never by
  // recency. An intent filed against next year's renewal must not resolve this one.
  const intent = await prisma.renewalIntent.findFirst({
    where: { accountId, effectiveFor: termEnd, cancelledAt: null, appliedAt: null },
    orderBy: { recordedAt: 'desc' },
  });

  const outcome: RenewalOutcome = intent ? OUTCOME_FOR_INTENT[intent.kind] : 'renewed';
  const retained = isRetained(outcome);
  const autoRecorded = !intent;

  // The PRE-TREATMENT measurement, taken months ago — when the offer window opened, or
  // when a discount was approved. Not the account's state now.
  //
  // Measuring here instead would be the mistake this whole design exists to avoid: by the
  // renewal, a departing account's usage has already collapsed, so the features contain
  // the answer. A model trained on that learns "usage near zero means churn" — true, and
  // useless, because at that point there is nothing left to act on.
  const index = await prisma.renewalIndexSnapshot.findUnique({
    where: { accountId_renewalDate: { accountId, renewalDate } },
  });

  // No index means nobody froze this account in time — it renewed before the window pass
  // ever ran, or its subscription was created inside the window. Fall back to today's
  // features so the OUTCOME is still captured, but record that they were measured late so
  // the training export can drop the row rather than learn from a leaky one.
  const featureSnapshot = index?.featureSnapshot ?? await loadModelFeatures(accountId);
  if (!featureSnapshot) {
    throw new Error(`no usage snapshot or subscription, so the renewal cannot be recorded`);
  }

  // What the models said, read from the stored daily scores rather than recomputed — this
  // must not depend on the Python model service being reachable, and the stored values are
  // the ones the app actually showed at the time.
  //
  // All THREE components are frozen, not just the fused result. The fused score cannot be
  // decomposed back into its parts, and without those parts the uplift model is missing
  // three of its eleven features and the fusion model (a stacking meta-classifier over
  // churn + sentiment) cannot be trained at all. There is no way to recover them later:
  // by the next daily run the account has been rescored.
  // From the index when there is one, so every component is measured at the same moment as
  // the features rather than stitched together from two different points in time.
  const components = index
    ? { fusedProba: index.fusedProba, churnProba: index.churnProba,
        sentimentScore: index.sentimentScore, dominantShapDriver: index.dominantShapDriver }
    : await loadUpliftComponents(accountId);

  // The discount granted FOR THIS RENEWAL, identified by its own start date rather than
  // by being the account's most recent. Taking the latest would pair an outcome with a
  // discount from a different renewal cycle, and a training row with the wrong treatment
  // is worse than no row: separating treatment from outcome is the uplift model's job.
  const discount = await prisma.auditLog.findFirst({
    where: { accountId, discountApplied: { gt: 0 }, discountStartsAt: termEnd },
    orderBy: { createdAt: 'desc' },
  });

  const nextTier: PlanTier = (retained && intent?.targetTier) ? intent.targetTier : planTier;
  const nextTermEnd = addMonths(termEnd, MONTHS_PER_TERM);

  const writes: any[] = [
    prisma.renewalRecord.create({
      data: {
        accountId,
        renewalDate,
        outcome,
        retained,
        autoRecorded,
        intentId: intent?.id,
        recordedById: intent?.recordedById ?? null,
        featureSnapshot,
        featuresFrozenAt: index?.frozenAt ?? null,
        daysToRenewalAtIndex: index?.daysToRenewal ?? 0,
        indexReason: index?.reason ?? null,
        predictedRisk: components.fusedProba,
        churnProba: components.churnProba,
        sentimentScore: components.sentimentScore,
        dominantShapDriver: components.dominantShapDriver,
        discountPct: discount?.discountApplied ?? 0,
        discountMonths: discount?.discountMonths ?? 0,
        planTierBefore: planTier,
        planTierAfter: nextTier,
      },
    }),
  ];

  if (retained) {
    // The term rolls forward. This is also what makes a scheduled discount become
    // active: it was stamped with this renewal date at approval, so once the date is
    // behind us discountStatus() reports it as running with no extra bookkeeping.
    writes.push(
      prisma.subscription.update({
        where: { id: subscriptionId },
        data: {
          termStart: termEnd,
          termEnd: nextTermEnd,
          durationMonths: MONTHS_PER_TERM,
          planTier: nextTier,
          // Repriced from the tier's standard rate on an up/downgrade. Recording a
          // downgrade while still billing the old tier would leave every portfolio
          // total wrong with nothing to catch it.
          mrr: TIER_MONTHLY_RATE[nextTier as keyof typeof TIER_MONTHLY_RATE],
        },
      }),
    );
  } else {
    writes.push(
      prisma.subscription.update({ where: { id: subscriptionId }, data: { status: 'churned' } }),
    );
  }

  if (intent) {
    writes.push(prisma.renewalIntent.update({ where: { id: intent.id }, data: { appliedAt: new Date() } }));
  }

  // The ledger entry, attributed to the system actor rather than to nobody or to a
  // borrowed name. This keeps renewals visible in the Audit Log alongside discount
  // approvals, which is where a reader expects to find "what happened to this account".
  //
  // discountApplied is deliberately 0 even when a discount became active at this
  // renewal. mapAccount derives an account's CURRENT discount from the most recent audit
  // row with discountApplied > 0, so a non-zero value here would make this row — which
  // carries no discountStartsAt — look like the live offer, and the whole lifecycle would
  // collapse back to "approved, no dates". The discount is described in the text instead.
  const tierNote = nextTier !== planTier ? ` Plan tier ${planTier} -> ${nextTier}.` : '';
  const discountNote = discount
    ? ` ${discount.discountApplied}% discount for ${discount.discountMonths} months is now in effect.`
    : '';
  const sourceNote = intent
    ? ` Recorded from a ${intent.source === 'email' ? 'customer email' : 'manually recorded'} intent.`
    : ' No intent was recorded, so the contract renewed on its standard terms.';

  writes.push(
    prisma.auditLog.create({
      data: {
        accountId,
        action: RENEWAL_ACTION_LABEL[outcome],
        discountApplied: 0,
        discountMonths: 0,
        approverId: await systemActorId(),
        verificationStatus: 'Automatic (Contract Term Boundary)',
        details:
          `${accountName} reached its renewal on ${renewalDate.toISOString().substring(0, 10)} and was recorded as ` +
          `${outcome}.${sourceNote}${tierNote}${discountNote}`,
      },
    }),
  );

  await prisma.$transaction(writes);

  const record: RenewalRow = {
    account: accountName,
    renewalDate: renewalDate.toISOString().substring(0, 10),
    outcome,
    autoRecorded,
  };
  return retained
    ? { kind: 'rolled', record, nextTermEnd, nextTier }
    : { kind: 'churned', record };
}
