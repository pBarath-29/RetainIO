import { PlanTier, RenewalOutcome, IntentKind } from '@prisma/client';
import { prisma } from './db';
import { dateOnlyUTC, loadModelFeatures, loadUpliftComponents, captureIndexSnapshot } from './fusionSnapshot';
import {
  MONTHS_PER_TERM, TIER_MONTHLY_RATE, addMonths, tierMoves, isWithinOfferWindow, formatTermDate,
  OFFER_WINDOW_DAYS, type PlanTierName,
} from './pricing';

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

/**
 * The intent recorded FOR a given renewal and still pending - not cancelled, not yet applied.
 * Matched on its effective date, never by recency: an intent filed against next year's renewal
 * must not resolve this one, nor open discounts for it.
 */
export function liveIntentFor(accountId: string, termEnd: Date) {
  return prisma.renewalIntent.findFirst({
    where: { accountId, effectiveFor: termEnd, cancelledAt: null, appliedAt: null },
    orderBy: { recordedAt: 'desc' },
  });
}

// How a renewal notice reads in the audit log and on the email record - the words the Renewals page uses.
export const describeIntent = (kind: string, targetTier?: string | null): string =>
  kind === 'churning' ? 'Will not renew' : `${kind === 'upgrading' ? 'Upgrade' : 'Downgrade'} to ${targetTier}`;

export type IntentActor = { kind: 'person'; id: string; name: string } | { kind: 'system' };

export type RecordIntentResult =
  | { ok: true; intent: { id: string; effectiveFor: Date } }
  | { ok: false; status: number; error: string };

/**
 * Records a renewal notice - the one path for a manager on the Renewals page and for a customer's
 * "RetainIO Renewal Notice" email, so both get the same checks, the same training snapshot and the
 * same audit row.
 *
 * NOTHING A NOTICE SAYS TAKES EFFECT HERE. It is held until the renewal and resolved there, and can
 * be cancelled until then - which is what makes recording one from an email safe.
 *
 * A manager's notice replaces whatever is pending for that renewal. An emailed one replaces only an
 * earlier emailed one: an email never overrides a person, so a pending manual notice turns the email
 * into a conflict - written to the audit log for the manager to see, and not applied.
 */
export async function recordRenewalIntent(args: {
  accountId: string;
  kind: string;
  targetTier?: string | null;
  source: 'manual' | 'email';
  actor: IntentActor;
  /** For an emailed notice: who sent it and its subject, quoted in the audit row. */
  email?: { from: string; subject: string };
}): Promise<RecordIntentResult> {
  const { accountId, kind, source, actor, email } = args;
  const targetTier = args.targetTier ?? null;

  // No `renewing`: contracts auto-renew, so renewing as-is is simply what happens when
  // nothing is recorded.
  const VALID_KINDS = ['upgrading', 'downgrading', 'churning'];
  if (!VALID_KINDS.includes(kind)) {
    return { ok: false, status: 400, error: `kind must be one of ${VALID_KINDS.join(', ')}.` };
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { subscriptions: { orderBy: { termStart: 'desc' }, take: 1 } },
  });
  if (!account) return { ok: false, status: 404, error: 'Account not found' };

  const sub = account.subscriptions[0];
  if (!sub) return { ok: false, status: 422, error: `${account.name} has no subscription to renew.` };
  if (sub.status === 'churned') return { ok: false, status: 409, error: `${account.name} has already churned.` };

  // A tier change has to say which tier, or the boundary has nothing to reprice to.
  const needsTier = kind === 'upgrading' || kind === 'downgrading';
  if (needsTier && !TIER_MONTHLY_RATE[targetTier as PlanTierName]) {
    return { ok: false, status: 400, error: 'A target plan tier is required for an upgrade or downgrade.' };
  }
  // And it has to go the way it says. Checking only that the tier differed let an
  // Enterprise account record an "upgrade" to Basic, which would then have resolved as
  // `upgraded` while repricing the account down.
  if (needsTier) {
    const direction = kind === 'upgrading' ? 'upgrade' : 'downgrade';
    const { upgrades, downgrades } = tierMoves(sub.planTier as PlanTierName);
    const allowed: string[] = kind === 'upgrading' ? upgrades : downgrades;
    if (!allowed.includes(targetTier as string)) {
      return {
        ok: false, status: 400,
        error: allowed.length
          ? `${account.name} is on ${sub.planTier} — it can ${direction} to ${allowed.join(' or ')}.`
          : `${account.name} is on ${sub.planTier}, so there is no plan to ${direction} to.`,
      };
    }
  }

  const label = describeIntent(kind, targetTier);
  const renewsOn = formatTermDate(sub.termEnd);
  const fromEmail = `A customer email${email ? ` from ${email.from} ("${email.subject}")` : ''}`;
  const replaced = await liveIntentFor(accountId, sub.termEnd);
  const ledgerActor = actor.kind === 'person' ? actor.id : await systemActorId();

  // An email never overrides a person. Not applied - but written where the manager will see it.
  if (source === 'email' && replaced?.source === 'manual') {
    const by = replaced.recordedById
      ? (await prisma.user.findUnique({ where: { id: replaced.recordedById } }))?.name ?? 'a manager'
      : 'a manager';
    const standing = describeIntent(replaced.kind, replaced.targetTier);
    await prisma.auditLog.create({
      data: {
        accountId,
        action: `Renewal Notice Not Recorded: ${label}`,
        discountApplied: 0,
        discountMonths: 0,
        approverId: ledgerActor,
        verificationStatus: 'Automatic (Customer Email)',
        details:
          `${fromEmail} asked to record "${label}" for ${account.name}'s renewal on ${renewsOn}, but ${by} ` +
          `has recorded "${standing}", and an email never overrides a person. Nothing was changed - ` +
          `review it on the Renewals page.`,
      },
    });
    return {
      ok: false, status: 409,
      error: `${by} has already recorded "${standing}" for this renewal, and an email never overrides a manager's notice.`,
    };
  }

  // One live intent per renewal: a later one supersedes rather than stacking, so the
  // job never has to guess which of two contradictory intents to believe.
  //
  // Written together with its audit row. A notice decides the renewal outcome and, for a
  // departure, opens discounts early - a retention action like any discount, so it goes in
  // the ledger under whoever recorded it, saying what it replaced.
  const willDo = kind === 'churning' ? 'not renew' : `${kind === 'upgrading' ? 'upgrade' : 'downgrade'} to ${targetTier}`;
  const opensOffers = kind === 'churning' && !isWithinOfferWindow(sub.termEnd);
  const [, intent] = await prisma.$transaction([
    prisma.renewalIntent.updateMany({
      where: { accountId, effectiveFor: sub.termEnd, cancelledAt: null, appliedAt: null },
      data: { cancelledAt: new Date() },
    }),
    prisma.renewalIntent.create({
      data: {
        accountId,
        kind: kind as IntentKind,
        targetTier: needsTier ? (targetTier as PlanTier) : null,
        effectiveFor: sub.termEnd,
        source,
        // Null when a machine wrote it, so a row always says honestly whether a person stood behind it.
        recordedById: actor.kind === 'person' ? actor.id : null,
      },
    }),
    prisma.auditLog.create({
      data: {
        accountId,
        action: `Renewal Notice Recorded: ${label}`,
        // 0, like every row that is not a discount: the account's current offer is read from
        // the latest audit row with a percentage, and this one must never look like it.
        discountApplied: 0,
        discountMonths: 0,
        approverId: ledgerActor,
        verificationStatus: actor.kind === 'person' ? 'Manual Entry (Renewal Notice)' : 'Automatic (Customer Email)',
        details:
          `${actor.kind === 'person' ? `${actor.name} recorded that` : `${fromEmail} gave notice that`} ` +
          `${account.name} will ${willDo} at its renewal on ${renewsOn}.` +
          (replaced ? ` Replaces the earlier notice (${describeIntent(replaced.kind, replaced.targetTier)}).` : '') +
          (opensOffers ? ` Retention discounts are open for this renewal from now, ahead of the ${OFFER_WINDOW_DAYS}-day window.` : ''),
      },
    }),
  ]);

  // Recording an intent is the moment the outcome became known. Freeze the account now
  // rather than waiting for the offer window: an account that gave notice at day 250 would
  // otherwise go unmeasured until day 180, seventy days into acting on its decision, and
  // its training row would describe that rather than the account as it stood.
  //
  // Always attempted, for all three kinds; the precedence rule in captureIndexSnapshot
  // decides whether it applies, so an account already frozen keeps its earlier snapshot.
  // Non-fatal, like the two approval paths: the intent is already saved, and losing the
  // training snapshot must not fail it.
  try {
    await captureIndexSnapshot(accountId, 'intent_recorded');
  } catch (err: any) {
    console.warn('Index snapshot failed after recording intent:', err.message || err);
  }

  return { ok: true, intent };
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

  // The intent recorded FOR THIS RENEWAL (see liveIntentFor).
  const intent = await liveIntentFor(accountId, termEnd);

  // An intent recorded for this renewal and later CANCELLED — typically a churn that a
  // discount turned around. The outcome is an ordinary renewal, but a person plainly dealt
  // with this renewal, so it counts as confirmed rather than assumed. Without this the most
  // valuable row the system can produce — a customer who was saved — exports as a guess,
  // indistinguishable from an account nobody ever opened.
  const cancelledIntent = intent ? null : await prisma.renewalIntent.findFirst({
    where: { accountId, effectiveFor: termEnd, cancelledAt: { not: null } },
    orderBy: { cancelledAt: 'desc' },
  });

  const outcome: RenewalOutcome = intent ? OUTCOME_FOR_INTENT[intent.kind] : 'renewed';
  const retained = isRetained(outcome);
  const autoRecorded = !intent && !cancelledIntent;

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
        // Names whoever engaged with this renewal, including someone who recorded an intent
        // and then cancelled it. intentId deliberately stays the LIVE intent only: a cancelled
        // one did not produce this outcome, and the appliedAt write below is guarded on the
        // same variable, so it must never be stamped as applied.
        recordedById: intent?.recordedById ?? cancelledIntent?.recordedById ?? null,
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
  // Only while the account is still here. On a churn the offer was made and refused: nothing is
  // billed at a discount for a customer who has gone, so "is now in effect" would state the
  // opposite of what happened. The offer is still named, because it is what was tried.
  const discountNote = !discount
    ? ''
    : retained
      ? ` ${discount.discountApplied}% discount for ${discount.discountMonths} months is now in effect.`
      : ` The ${discount.discountApplied}% discount for ${discount.discountMonths} months never took effect: the account left.`;
  const CANCELLED_VERB: Record<string, string> = { churning: 'churn', upgrading: 'upgrade', downgrading: 'downgrade' };
  const sourceNote = intent
    ? ` Recorded from a ${intent.source === 'email' ? 'customer email' : 'manually recorded'} intent.`
    : cancelledIntent
      ? ` An intent to ${CANCELLED_VERB[cancelledIntent.kind] ?? cancelledIntent.kind} was recorded and later cancelled, so the contract renewed on its standard terms.`
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
