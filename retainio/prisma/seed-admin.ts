import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

// Creates the admin login and wires up the initial reporting lines.
//
// Separate from the migration that added the 'admin' enum value: Postgres
// refuses to use a new enum value inside the transaction that created it, and
// Prisma runs each migration in one transaction.
//
// Idempotent — re-running updates the existing rows instead of duplicating.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const ADMIN_EMAIL = 'admin@retain.io';
const ADMIN_PASSWORD = 'RetainIO!2026';

async function main() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { role: 'admin' },
    create: {
      name: 'System Admin',
      email: ADMIN_EMAIL,
      passwordHash,
      role: 'admin',
      title: 'Platform Administrator',
      department: 'Operations',
      employeeId: 'ADM-1001',
      // Admins run the org, they don't approve discounts — so no self-approval
      // limit to speak of and no biometric requirement.
      maxSelfApprovalLimit: 0,
      avatarInitials: 'SA',
    },
  });
  console.log(`Admin ready: ${admin.name} <${admin.email}>`);

  // Both existing Managers report to the one Director. This is now the actual
  // reason that Director can see all 9 accounts — previously it was hardcoded
  // into the scoping rule.
  const director = await prisma.user.findFirst({ where: { role: 'account_director' } });
  if (!director) {
    console.warn('No Account Director exists yet — assign Managers once one registers.');
  } else {
    const { count } = await prisma.user.updateMany({
      where: { role: 'account_manager' },
      data: { directorId: director.id },
    });
    console.log(`Assigned ${count} Account Manager(s) to ${director.name}.`);
  }

  console.log('\nFinal state:');
  const users = await prisma.user.findMany({ include: { director: true, managers: true }, orderBy: { role: 'asc' } });
  for (const u of users) {
    const owns = await prisma.account.count({ where: { accountManagerId: u.id } });
    const reportsTo = u.director ? ` -> reports to ${u.director.name}` : '';
    const team = u.managers.length ? ` (team: ${u.managers.map(m => m.name).join(', ')})` : '';
    console.log(`  ${u.name.padEnd(16)} ${u.role.padEnd(18)} accounts=${owns}${reportsTo}${team}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
