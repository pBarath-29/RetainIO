import 'dotenv/config';
import { prisma } from '../db';
import { discountStatus, describeDiscountStatus, addMonths, formatTermDate, formatMoney } from '../pricing';

/**
 * READ-ONLY. Reports where every account's discount sits in its lifecycle, and — for
 * accounts that have one — what the SAME stored row means at each point in its life.
 *
 * Nothing here writes. discountStatus() takes an `asOf` date, so the three states can be
 * shown by asking the stored row what it is on different dates rather than by moving the
 * dates themselves. The row on disk is never touched; only the question changes.
 *
 * This is the honest way to see the lifecycle: what the app will actually display on
 * those dates, derived from the real approved discount, with no invented state.
 *
 *   npx tsx prisma/check-discount-lifecycle.ts
 */
const accounts = await prisma.account.findMany({
  include: {
    subscriptions: { orderBy: { termStart: 'desc' }, take: 1 },
    auditLogs: { where: { discountApplied: { gt: 0 }, withdrawnAt: null }, orderBy: { createdAt: 'desc' }, take: 1 },
  },
  orderBy: { name: 'asc' },
});

console.log('\nCURRENT STATE (read from the database, nothing modified)');
console.log('─'.repeat(94));
console.log('account                   list MRR   billing   state     discount');
for (const a of accounts) {
  const sub = a.subscriptions[0];
  const log = a.auditLogs[0];
  const listMrr = sub ? Number(sub.mrr) : 0;
  const s = discountStatus(listMrr, log?.discountApplied ?? 0, log?.discountMonths ?? 0, log?.discountStartsAt);
  console.log(
    `${a.name.padEnd(24)} ${formatMoney(listMrr).padStart(8)} ${formatMoney(s.effectiveMrr).padStart(9)}  ` +
    `${s.state.padEnd(8)}  ${log ? describeDiscountStatus(log.discountApplied, log.discountMonths, s) : '—'}`
  );
}

const withDiscount = accounts.filter(a => a.auditLogs.length > 0);

if (withDiscount.length === 0) {
  console.log(
    '\nNo account has a discount yet, so every row reads "none".\n' +
    'Apply one in the Retention Offer tab and re-run this to see its full timeline.'
  );
} else {
  for (const a of withDiscount) {
    const sub = a.subscriptions[0];
    const log = a.auditLogs[0];
    const listMrr = sub ? Number(sub.mrr) : 0;
    const start = log.discountStartsAt;
    if (!start) continue;

    console.log(`\n\nTIMELINE — ${a.name}, ${log.discountApplied}% for ${log.discountMonths} months`);
    console.log(`(one stored row, read at five different dates — the row itself is unchanged)`);
    console.log('─'.repeat(94));
    console.log('date                what the app shows                                        billing   new offer');

    const points: [string, Date][] = [
      ['today', new Date()],
      ['day before renewal', new Date(start.getTime() - 86400000)],
      ['renewal day', start],
      ['mid-discount', addMonths(start, Math.max(1, Math.floor(log.discountMonths / 2)))],
      ['after it ends', addMonths(start, log.discountMonths + 1)],
    ];

    for (const [label, when] of points) {
      const s = discountStatus(listMrr, log.discountApplied, log.discountMonths, start, when);
      const blocked = s.state === 'offered' || s.state === 'active';
      console.log(
        `${formatTermDate(when).padEnd(14)} ${('(' + label + ')').padEnd(21)} ` +
        `${s.state.padEnd(8)} ${formatMoney(s.effectiveMrr).padStart(8)}   ${blocked ? 'blocked' : 'allowed'}`
      );
    }

    const end = addMonths(start, log.discountMonths);
    console.log(
      `\n  So: ${a.name} keeps paying ${formatMoney(listMrr)}/month until ${formatTermDate(start)}, ` +
      `then ${formatMoney(listMrr * (1 - log.discountApplied / 100))}/month until ${formatTermDate(end)}, ` +
      `then back to ${formatMoney(listMrr)}.`
    );
    console.log(
      `  Total given away over the term: ` +
      `${formatMoney(listMrr * (log.discountApplied / 100) * log.discountMonths)}.`
    );
  }
}

await prisma.$disconnect();
