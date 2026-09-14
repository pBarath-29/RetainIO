import 'dotenv/config';
import { runDailySnapshotForToday } from '../fusionSnapshot';
import { prisma } from '../db';

// Manual/external trigger for the daily fusion snapshot — the same function
// server.ts calls on startup and every 6h while it's running, exposed here
// so it can also be run by hand, or registered in an external scheduler
// (Windows Task Scheduler locally; once hosted on Render or similar,
// server.ts's own in-process check becomes the real mechanism and this
// script is just a manual convenience). Requires model_service running and
// the database reachable.
//
//   npx tsx prisma/run-daily-snapshot.ts

async function main() {
  const summary = await runDailySnapshotForToday();
  console.log(`Daily fusion snapshot for ${summary.date}:`);
  console.log(`  ${summary.succeeded} computed, ${summary.skipped} already done today, ${summary.churned} churned (not re-scored), ${summary.errors.length} failed.`);
  if (summary.errors.length) {
    console.log('Errors:');
    for (const e of summary.errors) console.log(`  ${e.account}: ${e.message}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
