import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// One-shot: collapses the four seeded Account Managers down to two, plus the
// one Account Director, and redistributes all 9 accounts between them.
//
// Alex Rivera and Jordan Vance are removed entirely. Their accounts move to
// Sarah Jenkins / Elena Rostova, chosen to keep both books balanced on risk
// (2 High Risk accounts each) and MRR (~$56k vs ~$50k) rather than just
// splitting by count. Any audit_log where a removed user was the approver is
// re-pointed at the account's new manager, since deleting a user those rows
// reference would otherwise violate the approver_id foreign key.
//
// prisma/seed.ts has been updated to match, so seeding a fresh database
// produces this same two-manager structure without needing this script.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const REMOVE_MANAGERS = ['Alex Rivera', 'Jordan Vance'];

// account name -> manager who should own it after this runs
const REASSIGN: Record<string, string> = {
  'Apex Logistics Global': 'Sarah Jenkins',
  'CloudPulse Technologies': 'Elena Rostova',
  'FinTech Nexus Solutions': 'Elena Rostova',
  'Synergy AI Studio': 'Elena Rostova',
};

async function main() {
  const users = await prisma.user.findMany();
  const byName = new Map(users.map(u => [u.name, u]));

  for (const [accountName, managerName] of Object.entries(REASSIGN)) {
    const manager = byName.get(managerName);
    const account = await prisma.account.findFirst({ where: { name: accountName } });
    if (!manager || !account) {
      console.warn(`Skipping ${accountName} -> ${managerName} (missing row)`);
      continue;
    }
    await prisma.account.update({ where: { id: account.id }, data: { accountManagerId: manager.id } });
    console.log(`Reassigned ${accountName.padEnd(26)} -> ${managerName}`);
  }

  // Re-point audit logs approved by a departing manager at whoever owns the
  // account now, so the trail stays readable and the FK stays valid.
  for (const name of REMOVE_MANAGERS) {
    const user = byName.get(name);
    if (!user) continue;
    const logs = await prisma.auditLog.findMany({ where: { approverId: user.id }, include: { account: true } });
    for (const log of logs) {
      const newManagerId = log.account.accountManagerId;
      await prisma.auditLog.update({ where: { id: log.id }, data: { approverId: newManagerId } });
      const newManager = users.find(u => u.id === newManagerId);
      console.log(`Audit log on ${log.account.name}: approver ${name} -> ${newManager?.name ?? newManagerId}`);
    }
  }

  for (const name of REMOVE_MANAGERS) {
    const user = byName.get(name);
    if (!user) { console.log(`${name}: already gone`); continue; }

    const stillOwns = await prisma.account.count({ where: { accountManagerId: user.id } });
    const stillRequested = await prisma.discountRequest.count({ where: { requestedById: user.id } });
    const stillApproved = await prisma.discountRequest.count({ where: { approvedById: user.id } });
    const stillAudited = await prisma.auditLog.count({ where: { approverId: user.id } });
    if (stillOwns || stillRequested || stillApproved || stillAudited) {
      console.error(
        `REFUSING to delete ${name} — still referenced ` +
        `(accounts=${stillOwns}, requested=${stillRequested}, approved=${stillApproved}, auditLogs=${stillAudited})`
      );
      continue;
    }

    await prisma.session.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    console.log(`Deleted user ${name}`);
  }

  console.log('\n--- Result ---');
  const remaining = await prisma.user.findMany({ orderBy: { name: 'asc' } });
  for (const u of remaining) {
    const accts = await prisma.account.findMany({
      where: { accountManagerId: u.id },
      include: { subscriptions: { orderBy: { termStart: 'desc' }, take: 1 }, fusionScores: { orderBy: { snapshotDate: 'desc' }, take: 1 } },
      orderBy: { name: 'asc' },
    });
    const mrr = accts.reduce((s, a) => s + Number(a.subscriptions[0]?.mrr ?? 0), 0);
    const high = accts.filter(a => (a.fusionScores[0]?.fusionScore ?? 0) > 70).length;
    console.log(`${u.name.padEnd(16)} (${u.role})  accounts=${accts.length}  MRR=$${mrr.toLocaleString()}  highRisk=${high}`);
    for (const a of accts) console.log(`     - ${a.name}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
