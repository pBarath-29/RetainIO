import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// One-shot: re-points seeded audit_logs whose actor is an Account Manager who
// doesn't manage that account, at the account's current manager.
//
// These rows are demo data seeded from mockData.ts, where the approver was
// assigned semi-arbitrarily — two of them sat on accounts that belonged to
// the managers removed in consolidate-managers.ts. They never described a
// real action, so correcting them is not the same as editing a genuine audit
// trail (which should always be append-only).
//
// Director-approved rows are deliberately left alone: a Director's approval
// really was theirs, and reattributing it to the account's manager would
// destroy the manager/director separation the trail exists to record.
//
// No text is rewritten — the `details` column uses generic wording
// ("Account Manager executed...", "Manager note: ...") with no names in it,
// verified before this ran.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

async function main() {
  const logs = await prisma.auditLog.findMany({
    include: { account: { include: { accountManager: true } }, approver: true },
    orderBy: { createdAt: 'desc' },
  });

  let changed = 0;
  for (const log of logs) {
    if (log.approver.role !== 'account_manager') {
      console.log(`skip  ${log.account.name.padEnd(24)} actor is ${log.approver.role} (${log.approver.name}) — left as-is`);
      continue;
    }
    if (log.approverId === log.account.accountManagerId) {
      console.log(`ok    ${log.account.name.padEnd(24)} already ${log.approver.name}`);
      continue;
    }
    await prisma.auditLog.update({
      where: { id: log.id },
      data: { approverId: log.account.accountManagerId },
    });
    console.log(`FIXED ${log.account.name.padEnd(24)} ${log.approver.name} -> ${log.account.accountManager.name}`);
    changed++;
  }

  // Same fix for discount_requests: the requester should be the account's own
  // manager. These are visible to a manager via account ownership, so a
  // mismatch shows Elena a request attributed to Sarah on Elena's account.
  const requests = await prisma.discountRequest.findMany({
    include: { account: { include: { accountManager: true } }, requestedBy: true },
  });
  let reqChanged = 0;
  for (const r of requests) {
    if (r.requestedBy.role !== 'account_manager') continue;
    if (r.requestedById === r.account.accountManagerId) {
      console.log(`ok    ${r.account.name.padEnd(24)} request already by ${r.requestedBy.name}`);
      continue;
    }
    await prisma.discountRequest.update({
      where: { id: r.id },
      data: { requestedById: r.account.accountManagerId },
    });
    console.log(`FIXED ${r.account.name.padEnd(24)} request ${r.requestedBy.name} -> ${r.account.accountManager.name}`);
    reqChanged++;
  }

  console.log(`\nRe-pointed ${changed} audit log(s) and ${reqChanged} discount request(s).\n--- Visibility now ---`);
  const users = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  for (const u of users) {
    const isDirector = u.role === 'account_director';
    const where = isDirector ? {} : {
      OR: [
        { approverId: u.id },
        { approver: { role: 'account_director' as const }, account: { accountManagerId: u.id } },
      ],
    };
    const visible = await prisma.auditLog.findMany({ where, include: { account: true } });
    console.log(`${u.name.padEnd(16)} (${u.role})  ${visible.length} entries: ${visible.map(l => l.account.name).join(', ') || '(none)'}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
