import nodemailer from 'nodemailer';

/**
 * Outbound mail: the retention offer emails.
 *
 * Sent from the same dedicated mailbox mailIngest.ts reads, so one app password covers both
 * directions. SMTP_HOST / SMTP_PORT name the provider's outgoing server; the login is
 * INGEST_IMAP_USER / INGEST_IMAP_PASSWORD.
 *
 *   Yahoo    smtp.mail.yahoo.com   465
 *   Gmail    smtp.gmail.com        465
 *   iCloud   smtp.mail.me.com      587
 *
 * MAIL_SEND_MODE=log builds each message and hands it to nodemailer's JSON transport instead of a
 * server, so tests run everything up to the network without sending anything.
 */
const logMode = () => process.env.MAIL_SEND_MODE === 'log';

export function mailSendConfigured(): boolean {
  if (logMode()) return true;
  return Boolean(process.env.SMTP_HOST && process.env.INGEST_IMAP_USER && process.env.INGEST_IMAP_PASSWORD);
}

function transport() {
  if (logMode()) return nodemailer.createTransport({ jsonTransport: true });
  const port = Number(process.env.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 is TLS from the first byte; 587 starts plain and upgrades with STARTTLS.
    secure: port === 465,
    auth: { user: process.env.INGEST_IMAP_USER, pass: process.env.INGEST_IMAP_PASSWORD },
    // A mail server that never answers must not hold the offer window open indefinitely.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export interface OutgoingMail {
  fromName: string;
  to: { name: string; address: string };
  subject: string;
  text: string;
}

/** Sends one plain-text email from the project mailbox. Throws with the server's reason if refused. */
export async function sendMail(mail: OutgoingMail): Promise<{ messageId: string }> {
  const info = await transport().sendMail({
    // The address must be the mailbox that signs in - providers refuse anything else - so the
    // sender's name goes in the display name instead.
    from: { name: mail.fromName, address: process.env.INGEST_IMAP_USER || 'retainio@localhost' },
    to: { name: mail.to.name, address: mail.to.address },
    subject: mail.subject,
    text: mail.text,
  });
  if (logMode()) console.log(`[mail:log] "${mail.subject}" -> ${mail.to.address} (not sent: MAIL_SEND_MODE=log)`);
  return { messageId: info.messageId };
}
