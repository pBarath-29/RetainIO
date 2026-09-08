import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// One-shot: fills riskWeight on sentiment_predictions rows written before
// that column existed. Re-reads each row's original ticket text through
// /predict/sentiment (deterministic — same text, same model, same output)
// rather than guessing; safe to re-run (only touches rows where it's null).

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });
const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL || 'http://127.0.0.1:8000';

async function main() {
  const rows = await prisma.sentimentPrediction.findMany({
    where: { riskWeight: null },
    include: { supportTicket: true },
  });

  let updated = 0;
  for (const row of rows) {
    if (!row.supportTicket) {
      console.warn(`Skipping ${row.id} — no linked support ticket text.`);
      continue;
    }
    const res = await fetch(`${MODEL_SERVICE_URL}/predict/sentiment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: row.supportTicket.body }),
    });
    if (!res.ok) {
      console.warn(`Skipping ${row.id} — model_service returned ${res.status}`);
      continue;
    }
    const data = await res.json();

    await prisma.sentimentPrediction.update({
      where: { id: row.id },
      data: { riskWeight: data.risk_weight },
    });
    console.log(`${row.id}: riskWeight=${data.risk_weight}`);
    updated++;
  }

  console.log(`Backfilled ${updated}/${rows.length} sentiment_predictions rows.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
