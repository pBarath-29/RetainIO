// Every money calculation in the app, in one place.
//
// Contracts are a 12-month term at a tier-standard rate. A discount covers the
// first N months of the upcoming term and then the account returns to full price.
//
// ARR is deliberately NOT stored anywhere — it is mrr * 12 and nothing more. A
// second stored copy of a derived fact is a second thing to keep in sync, which is
// exactly how the Director dashboard's risk bands drifted out of step with the
// canonical ones.

export const MONTHS_PER_TERM = 12;

// Standard rates. Enterprise 60,000/yr, Pro 30,000/yr, Basic 12,000/yr.
export const TIER_MONTHLY_RATE = {
  Enterprise: 5000,
  Pro: 2500,
  Basic: 1000,
} as const;

export type PlanTierName = keyof typeof TIER_MONTHLY_RATE;

/**
 * The tiers an account on `current` could move to at its renewal, nearest first — so an
 * Enterprise account's downgrades read Pro, then Basic. Derived from the rates rather than
 * from a second list of tiers in order, which could disagree with them.
 */
export function tierMoves(current: PlanTierName): { upgrades: PlanTierName[]; downgrades: PlanTierName[] } {
  const rate = TIER_MONTHLY_RATE[current];
  const tiers = Object.keys(TIER_MONTHLY_RATE) as PlanTierName[];
  const byRate = (a: PlanTierName, b: PlanTierName) => TIER_MONTHLY_RATE[a] - TIER_MONTHLY_RATE[b];
  return {
    upgrades: tiers.filter(t => TIER_MONTHLY_RATE[t] > rate).sort(byRate),
    downgrades: tiers.filter(t => TIER_MONTHLY_RATE[t] < rate).sort(byRate).reverse(),
  };
}

// An Account Manager may give away up to this share of a contract's annual value
// before it needs Director sign-off. Expressed against ARR rather than against the
// headline rate, so "10% for 12 months" and "20% for 6 months" — which cost exactly
// the same — are treated the same. The old rule gated on the percentage alone and
// so waved through a year-long 10% while stopping a two-month 15%.
export const SELF_APPROVAL_GIVEBACK_RATIO = 0.10;

// A retention offer may only be made inside this window before the renewal.
//
// Partly a business rule — discounting eleven months out gives money away before you know
// whether the account is even at risk. But it is also what makes the training data valid:
// because no discount can exist before this point, the account's state AT this point is
// guaranteed to be pre-treatment for every account, treated or not. That is the fixed
// reference the uplift model's control group needs.
export const OFFER_WINDOW_DAYS = 180;

// The offers anyone may make — exactly the uplift model's treatment arms, as recorded in
// models/uplift_config.json (treatment_pcts, treatment_months). server.ts warns at startup if the
// two ever disagree.
//
// The model is not one model but one per arm: it answers "would 10% for 6 months change this
// outcome?" by comparing the 10%-for-6-months model against the no-discount one. An offer off this
// grid has no model to ask, so the Discount Uplift Advisor cannot evaluate it beforehand and its
// renewal cannot train the model afterwards. The form used to accept any whole percentage and any
// duration from 1 to 12 months, which let through offers the model was never built to judge.
//
// "No discount" is ONE arm: 0% with no duration. It is not 0% for 3, 6, 9 or 12 months — that
// would be four identical control arms, splitting the group every treated arm is measured against.
export const OFFER_PCTS = [5, 10, 15, 20, 25] as const;
export const OFFER_MONTHS = [3, 6, 9, 12] as const;

/**
 * Whether an offer may be made. 0% is a walkthrough with no discount and is always allowed; its
 * duration means nothing and is discarded when stored. Any discount must be on the grid.
 */
export const isAllowedOffer = (pct: number, months: number): boolean =>
  pct === 0 ||
  ((OFFER_PCTS as readonly number[]).includes(pct) && (OFFER_MONTHS as readonly number[]).includes(months));

export const daysUntil = (date: Date | string, asOf: Date = new Date()): number =>
  Math.round((new Date(date).getTime() - asOf.getTime()) / 86400000);

// Midnight UTC of whatever day the given instant falls on.
export const startOfUTCDay = (d: Date | string = new Date()): Date => {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
};

/**
 * How many whole days ago a date-only value was. 0 for today or anything future.
 *
 * daysUntil compares instants, which is right for a renewal date but wrong here: a stored
 * date like "2026-09-08" is midnight UTC, so measuring it against 1pm the same day gives
 * -0.56, rounds to -1, and reports a reading taken this morning as a day old. Both sides
 * have to be normalised to the start of their day before the subtraction means anything.
 */
export const daysAgo = (date: Date | string, asOf: Date = new Date()): number =>
  Math.max(0, -daysUntil(startOfUTCDay(date), startOfUTCDay(asOf)));

export const isWithinOfferWindow = (renewalDate: Date | string, asOf: Date = new Date()): boolean =>
  daysUntil(renewalDate, asOf) <= OFFER_WINDOW_DAYS;

export const annualContractValue = (mrr: number): number => mrr * MONTHS_PER_TERM;

/** What the customer pays across the term when a discount covers its first N months. */
export const discountedTermValue = (mrr: number, pct: number, months: number): number =>
  mrr * (1 - pct / 100) * months + mrr * (MONTHS_PER_TERM - months);

/** What the discount costs us across the term. This is what the approval gate reads. */
export const givebackValue = (mrr: number, pct: number, months: number): number =>
  mrr * (pct / 100) * months;

export const selfApprovalCap = (mrr: number): number =>
  annualContractValue(mrr) * SELF_APPROVAL_GIVEBACK_RATIO;

export const needsDirectorApproval = (mrr: number, pct: number, months: number): boolean =>
  givebackValue(mrr, pct, months) > selfApprovalCap(mrr);

/** "10% for 6 months", or "no discount" — used in offers, audit rows and prompts. */
export function describeDiscount(pct: number, months: number): string {
  if (!pct || !months) return 'no discount';
  return `${pct}% for ${months} ${months === 1 ? 'month' : 'months'}`;
}

export const formatMoney = (amount: number): string =>
  `$${Math.round(amount).toLocaleString()}`;

// ---------------------------------------------------------------------------
// When a discount is actually in effect.
//
// A discount is approved now but covers the first N months of the UPCOMING term,
// so between approval and renewal nothing has happened yet: the customer is still
// paying full list price. The app used to collapse that whole span into "Active
// Retention Discount" from the moment of approval, and never expired it either —
// so an account granted 10% for 6 months read as permanently discounted, while
// `mrr` sat at list price the entire time, wrong in one direction and then the
// other.
//
// Everything below is derived from the start date plus the duration. Nothing
// stores an end date: it is startsAt plus months, and a second stored copy of a
// derived fact is exactly how the Director dashboard's risk bands drifted.
// ---------------------------------------------------------------------------

/** Calendar-month arithmetic that clamps rather than overflowing: 31 Jan + 1 month
 *  is 28 Feb, not 3 March. Terms renew on month-end dates often enough to matter. */
export function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDayOfMonth));
  return d;
}

export type DiscountState =
  | 'none'     // no discount on the account
  | 'offered'  // approved, but the term it applies to has not started
  | 'active'   // running right now; the customer is paying less
  | 'ended';   // its months have elapsed; back at list price

export interface DiscountStatus {
  state: DiscountState;
  startsAt: Date | null;
  endsAt: Date | null;
  /** What the account actually bills at today. Equals the list rate unless `active`. */
  effectiveMrr: number;
}

/**
 * The single source of truth for discount state, used by the server to compute
 * portfolio totals and by the client to label an account. Accepts an ISO string as
 * well as a Date so both sides can call it on the same value — JSON has no dates.
 */
export function discountStatus(
  listMrr: number,
  pct: number,
  months: number,
  startsAt: Date | string | null | undefined,
  asOf: Date = new Date(),
): DiscountStatus {
  const none: DiscountStatus = { state: 'none', startsAt: null, endsAt: null, effectiveMrr: listMrr };
  if (!pct || !months || pct <= 0 || months <= 0) return none;

  const start = startsAt ? new Date(startsAt) : null;

  // A discount with no start date is one whose window we cannot determine — rows
  // predating this change, if any survived the pricing reset. Report it as `offered`
  // rather than `active`: that keeps the customer at list price (never claiming a
  // discount is running when we don't know) and leaves the no-stacking lock on.
  if (!start || Number.isNaN(start.getTime())) {
    return { state: 'offered', startsAt: null, endsAt: null, effectiveMrr: listMrr };
  }

  const end = addMonths(start, months);
  if (asOf < start) return { state: 'offered', startsAt: start, endsAt: end, effectiveMrr: listMrr };
  if (asOf >= end) return { state: 'ended', startsAt: start, endsAt: end, effectiveMrr: listMrr };

  return { state: 'active', startsAt: start, endsAt: end, effectiveMrr: listMrr * (1 - pct / 100) };
}

/** "13 Jun 2027" — one format for contract dates wherever they are shown. */
export const formatTermDate = (date: Date | string): string =>
  new Date(date).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });

/**
 * How to describe a discount in the UI, in one place so the account page, the two
 * dashboards and the advisor cannot word the same state differently — which is how
 * "Active", "Executed" and "applied" all came to mean "approved at some point".
 */
export function describeDiscountStatus(pct: number, months: number, status: DiscountStatus): string {
  switch (status.state) {
    case 'none':
      return 'No retention discount';
    case 'offered':
      return status.startsAt
        ? `${describeDiscount(pct, months)} — starts at renewal on ${formatTermDate(status.startsAt)}`
        : `${describeDiscount(pct, months)} — scheduled for the next renewal`;
    case 'active':
      return `${describeDiscount(pct, months)} — active until ${formatTermDate(status.endsAt!)}`;
    case 'ended':
      return `${describeDiscount(pct, months)} — ended ${formatTermDate(status.endsAt!)}`;
  }
}

/** True while a discount blocks a new offer. An `ended` one no longer does — the old
 *  rule locked the offer form forever after a single discount. */
export const blocksNewOffer = (state: DiscountState): boolean =>
  state === 'offered' || state === 'active';
