import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// One-shot: rewrites the two seeded audit_log action strings into the shape
// the app generates at runtime ("<pct>% Retention Discount <verb>").
//
// These two rows came from mockData.ts as free-hand text and never went
// through server.ts's buildActionLabel, so they read differently from every
// row the app has written since. Only the wording changes — the account,
// actor, amount, verification status and timestamp are all untouched, so no
// fact about what happened is altered.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const RENAMES: { from: string; to: string }[] = [
  { from: '10% Retention Discount Approved', to: '10% Retention Discount Executed' },
  { from: 'Discount Approval Request Submitted (>10%)', to: '15% Retention Discount Request Submitted' },
  // Written by the rejection route before it was pointed at buildActionLabel:
  // it said "Discount" where every other row says "Retention Discount".
  { from: '12% Discount Request Rejected', to: '12% Retention Discount Request Rejected' },
];

async function main() {
  for (const { from, to } of RENAMES) {
    const { count } = await prisma.auditLog.updateMany({ where: { action: from }, data: { action: to } });
    console.log(count ? `"${from}"\n   -> "${to}"  (${count} row)` : `"${from}" — not found, already updated`);
  }

  console.log('\nAudit ledger now reads:');
  const logs = await prisma.auditLog.findMany({ include: { account: true }, orderBy: { createdAt: 'desc' } });
  for (const l of logs) {
    console.log(`  ${l.createdAt.toISOString().slice(0, 10)}  ${l.account.name.padEnd(24)} ${l.action}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
