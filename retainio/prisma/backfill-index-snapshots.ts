import 'dotenv/config';
import { prisma } from '../db';
import { captureIndexSnapshot, dateOnlyUTC } from '../fusionSnapshot';
import { OFFER_WINDOW_DAYS, daysUntil, formatTermDate } from '../pricing';

/**
 * One-shot: reconstruct the index snapshot for accounts that are ALREADY inside their
 * offer window.
 *
 *   npx tsx prisma/backfill-index-snapshots.ts
 *
 * The daily job freezes each account on the day it crosses OFFER_WINDOW_DAYS from renewal.
 * But several accounts crossed that line before the job existed, so their window-open date
 * is in the past and the job will never revisit it. Without this they would reach their
 * renewal with no pre-treatment measurement, and their outcome would only be usable with
 * features taken AT the renewal — the leaky case the index exists to avoid.
 *
 * This is only possible because the usage history exists. Each account is measured at its
 * own window-open date using the snapshot that was current then, not today's values. If
 * the history does not reach back that far, the account is reported and skipped rather
 * than being frozen with the wrong day's numbers.
 */
const subs = await prisma.subscription.findMany({
  where: { status: 'active' }, include: { account: true }, orderBy: { termEnd: 'asc' },
});

console.log(`\nOffer window: ${OFFER_WINDOW_DAYS} days before renewal\n`);
console.log('account                    renewal        window opened   status');
console.log('-'.repeat(92));

let created = 0, skipped = 0, tooEarly = 0;

for (const sub of subs) {
  const daysOut = daysUntil(sub.termEnd);
  const windowOpened = new Date(sub.termEnd.getTime() - OFFER_WINDOW_DAYS * 86400000);
  const name = sub.account.name.padEnd(26);
  const dates = `${formatTermDate(sub.termEnd).padEnd(14)} ${formatTermDate(windowOpened).padEnd(15)}`;

  if (daysOut > OFFER_WINDOW_DAYS) {
    console.log(`${name} ${dates} not in window yet (${daysOut}d out) — the daily job will handle it`);
    tooEarly++;
    continue;
  }

  const existing = await prisma.renewalIndexSnapshot.findUnique({
    where: { accountId_renewalDate: { accountId: sub.accountId, renewalDate: dateOnlyUTC(sub.termEnd) } },
  });
  if (existing) {
    console.log(`${name} ${dates} already frozen (${existing.reason})`);
    skipped++;
    continue;
  }

  // Is there history reaching back to the window-open date? Freezing an account with
  // today's numbers and labelling them as the window-open state would be worse than
  // leaving the gap, because nothing downstream could tell the difference.
  const oldest = await prisma.usageSnapshot.findFirst({
    where: { accountId: sub.accountId }, orderBy: { capturedAt: 'asc' },
  });
  if (!oldest || oldest.capturedAt > windowOpened) {
    console.log(`${name} ${dates} SKIPPED — usage history only reaches ${oldest ? formatTermDate(oldest.capturedAt) : 'nothing'}`);
    skipped++;
    continue;
  }

  const snap = await captureIndexSnapshot(sub.accountId, 'window_open', windowOpened);
  if (!snap) {
    console.log(`${name} ${dates} SKIPPED — could not build features`);
    skipped++;
    continue;
  }
  const f = snap.featureSnapshot as any;
  console.log(`${name} ${dates} frozen: ${f.Daily_Usage_Mins}min, ${f.Support_Tickets_90Days} tickets, risk ${snap.fusedProba !== null ? Math.round(snap.fusedProba * 100) : '—'}`);
  created++;
}

console.log(`\n${created} frozen, ${skipped} skipped, ${tooEarly} not in window yet.`);
await prisma.$disconnect();
