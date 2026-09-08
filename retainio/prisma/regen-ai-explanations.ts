import 'dotenv/config';
import { prisma } from '../db';
import { generateAiExplanation } from '../fusionSnapshot';

// One-shot: replaces the stale seeded ai_explanations rows with real ones
// generated from each account's actual model output. Going forward,
// runDailySnapshotForToday() regenerates these itself, so this only exists to
// clear the seeded backlog.
async function main() {
  const accounts = await prisma.account.findMany({ orderBy: { name: 'asc' } });
  for (const a of accounts) {
    const ok = await generateAiExplanation(a.id);
    const row = await prisma.aiExplanation.findFirst({ where: { accountId: a.id } });
    const fusion = await prisma.fusionScore.findFirst({
      where: { accountId: a.id },
      orderBy: { snapshotDate: 'desc' },
    });
    console.log(`\n=== ${a.name} — real fusion score ${fusion?.fusionScore} (${fusion?.riskCategory}) ===`);
    console.log(ok ? row?.summary : '  FAILED');
  }
  await prisma.$disconnect();
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1); });
