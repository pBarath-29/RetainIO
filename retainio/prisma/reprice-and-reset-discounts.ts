import 'dotenv/config';
import { prisma } from '../db';
import { MONTHS_PER_TERM, TIER_MONTHLY_RATE, annualContractValue, formatMoney } from '../pricing';

/**
 * One-shot migration to the standardised pricing model.
 *
 *   - every subscription is repriced to its plan tier's standard rate
 *   - every term becomes 12 months, with renewals staggered across the coming year
 *   - all discount state is cleared
 *
 * Pricing was ad-hoc before this (CloudPulse 17,500/mo, Novus 2,917/mo) with no
 * relationship to plan tier, and terms were ONE MONTH — with nothing in the app that
 * ever renews a subscription, so `termEnd` simply drifted into the past and
 * Days_To_Renewal went negative.
 *
 * Discounts are wiped rather than backfilled because `currentDiscountApproved` is
 * derived from the most recent audit row carrying a discount, and rows written before
 * this change have no duration on them. A discount with no duration cannot be costed,
 * which is the whole thing this change exists to fix — so they go rather than being
 * guessed at. This deletes audit_logs and discount_requests, the same reset
 * prisma/wipe-discount-activity.ts performs.
 */
async function main() {
  const subs = await prisma.subscription.findMany({ include: { account: true } });

  // Renewals are STAGGERED across the coming year rather than all landing on the same
  // day. Every contract expiring simultaneously is not something a real portfolio does,
  // and it makes the renewal column, the "days to renewal" sort and any sense of
  // urgency meaningless - every account would read "365 days" forever.
  //
  // Deterministic so re-running is idempotent: accounts are spread by their position in
  // a name-ordered list, one renewal roughly every few weeks.
  const today = new Date();
  const staggerDays = (index: number, total: number) =>
    Math.max(14, Math.round(((index + 1) / total) * 365));

  console.log(`repricing ${subs.length} subscriptions\n`);
  let totalBefore = 0;
  let totalAfter = 0;

  const ordered = [...subs].sort((a, b) => a.account.name.localeCompare(b.account.name));

  for (const sub of ordered) {
    const tier = sub.planTier as keyof typeof TIER_MONTHLY_RATE;
    const rate = TIER_MONTHLY_RATE[tier];
    if (!rate) {
      console.log(`  SKIP ${sub.account.name} — unknown plan tier "${sub.planTier}"`);
      continue;
    }

    const before = Number(sub.mrr);
    totalBefore += before;
    totalAfter += rate;

    const termEnd = new Date(today);
    termEnd.setDate(termEnd.getDate() + staggerDays(ordered.indexOf(sub), ordered.length));
    const termStart = new Date(termEnd);
    termStart.setMonth(termStart.getMonth() - MONTHS_PER_TERM);

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { mrr: rate, durationMonths: MONTHS_PER_TERM, termStart, termEnd },
    });

    const arrow = rate > before ? 'up  ' : rate < before ? 'down' : 'same';
    console.log(
      `  ${sub.account.name.padEnd(24)} ${tier.padEnd(11)} ` +
      `${formatMoney(before).padStart(9)} -> ${formatMoney(rate).padStart(7)}/mo ${arrow}  ` +
      `(${formatMoney(annualContractValue(rate))}/yr)  renews ${termEnd.toISOString().slice(0, 10)}`
    );
  }

  const audits = await prisma.auditLog.deleteMany({});
  const requests = await prisma.discountRequest.deleteMany({});

  console.log(`\ncleared ${audits.count} audit rows and ${requests.count} discount requests`);
  console.log(`portfolio MRR ${formatMoney(totalBefore)} -> ${formatMoney(totalAfter)}`);
  console.log(`portfolio ARR ${formatMoney(totalAfter * MONTHS_PER_TERM)}`);
  console.log(`all terms now ${MONTHS_PER_TERM} months, renewals staggered across the coming year`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
