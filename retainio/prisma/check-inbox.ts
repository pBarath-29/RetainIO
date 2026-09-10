import 'dotenv/config';
import { prisma } from '../db';
import { ingestInbox, mailIngestConfigured } from '../mailIngest';
import { rescoreAccountToday } from '../fusionSnapshot';

/**
 * Runs the mail ingester by hand, without the server or the UI.
 *
 *   npx tsx prisma/check-inbox.ts
 *
 * Same code path the poll and the "Check inbox now" button use, so a problem reproduced here
 * is the problem they would hit.
 */
async function main() {
  if (!mailIngestConfigured()) {
    console.log('Email ingestion is not configured.');
    console.log('Set INGEST_IMAP_HOST, INGEST_IMAP_USER and INGEST_IMAP_PASSWORD in .env.');
    return;
  }

  console.log(`Checking ${process.env.INGEST_IMAP_USER} for "${process.env.INGEST_SUBJECT_PREFIX || 'RetainIO Feedback:'}"...\n`);
  const summary = await ingestInbox(true);

  console.log(`\n${summary.ingested} ingested, ${summary.unmatched} unmatched, ` +
              `${summary.skipped} already seen, ${summary.failed} failed.`);
  for (const note of summary.notes) console.log(`  - ${note}`);

  // Once per account, not once per email: rescoreAccountToday writes a new churn and
  // sentiment prediction row every call, so three emails for one customer would otherwise
  // leave three sets of rows to reach one answer.
  for (const accountId of summary.accountIds) {
    try {
      const r = await rescoreAccountToday(accountId);
      console.log(`  re-scored -> fusion ${r.fusionScore}/100, sentiment ${r.classification}`);
    } catch (err: any) {
      console.warn(`  re-score failed (review still saved): ${err.message || err}`);
    }
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
