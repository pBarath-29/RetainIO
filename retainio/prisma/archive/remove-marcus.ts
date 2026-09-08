import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// One-shot: removes the seeded Account Director "Marcus Vance". Barath P —
// registered through the real signup flow, with an enrolled face — becomes
// the sole Director. Marcus predates face enrolment and had no biometric on
// file, so he could no longer approve anything anyway.
//
// Refuses to delete if anything still points at him rather than leaving
// dangling references; at time of writing he owned no accounts, raised or
// approved no discount requests, and appeared in no audit log.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

async function main() {
  const marcus = await prisma.user.findFirst({ where: { name: 'Marcus Vance' } });
  if (!marcus) {
    console.log('Marcus Vance is already gone.');
  } else {
    const refs = {
      accounts: await prisma.account.count({ where: { accountManagerId: marcus.id } }),
      requested: await prisma.discountRequest.count({ where: { requestedById: marcus.id } }),
      approved: await prisma.discountRequest.count({ where: { approvedById: marcus.id } }),
      auditLogs: await prisma.auditLog.count({ where: { approverId: marcus.id } }),
    };
    const total = Object.values(refs).reduce((a, b) => a + b, 0);
    if (total > 0) {
      console.error(`REFUSING to delete — still referenced: ${JSON.stringify(refs)}`);
      process.exit(1);
    }
    // faceSamples and sessions cascade / are cleared explicitly.
    await prisma.faceSample.deleteMany({ where: { userId: marcus.id } });
    await prisma.session.deleteMany({ where: { userId: marcus.id } });
    await prisma.user.delete({ where: { id: marcus.id } });
    console.log('Deleted Marcus Vance.');
  }

  console.log('\nRemaining users:');
  const users = await prisma.user.findMany({ include: { faceSamples: true }, orderBy: { name: 'asc' } });
  for (const u of users) {
    const accounts = await prisma.account.count({ where: { accountManagerId: u.id } });
    console.log(`  ${u.name.padEnd(16)} ${u.role.padEnd(18)} accounts=${accounts}  faceSamples=${u.faceSamples.length}`);
  }

  const directors = users.filter(u => u.role === 'account_director');
  console.log(`\nDirectors: ${directors.length} (${directors.map(d => d.name).join(', ') || 'none'})`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
