import 'dotenv/config';
import { prisma } from '../db';

/**
 * Gives every account a contact email, so retention offers can be emailed from the app.
 *
 *   npx tsx prisma/set-contact-emails.ts
 *
 * The demo customers are not real companies, so their offers go to an inbox you control:
 * DEMO_CONTACT_EMAIL, or the project mailbox (INGEST_IMAP_USER) when that is blank, in which case
 * the app emails itself. The address is read from .env rather than written here, so it never ends
 * up in the repository. Throwaway "DEMO — " accounts are left without one.
 */
const address = (process.env.DEMO_CONTACT_EMAIL || process.env.INGEST_IMAP_USER || '').trim();

if (!address.includes('@')) {
  console.log('Set DEMO_CONTACT_EMAIL, or INGEST_IMAP_USER, in .env first.');
} else {
  const { count } = await prisma.account.updateMany({
    where: { NOT: { name: { startsWith: 'DEMO — ' } } },
    data: { contactEmail: address },
  });
  console.log(`${count} account(s) now have ${address} as their contact email.`);
}

await prisma.$disconnect();
