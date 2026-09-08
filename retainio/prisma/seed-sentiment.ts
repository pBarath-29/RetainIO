import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Runs every seeded support ticket's real body text through the real
// trained sentiment model (model_service's new /predict/sentiment,
// models/sentiment_naive_bayes.pkl) instead of leaving sentiment_predictions
// empty or guessing with Gemini. Requires model_service running on :8000.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });
const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL || 'http://127.0.0.1:8000';

async function main() {
  const tickets = await prisma.customerReview.findMany({ include: { account: true } });
  let count = 0;

  for (const ticket of tickets) {
    const res = await fetch(`${MODEL_SERVICE_URL}/predict/sentiment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ticket.reviewText }),
    });
    if (!res.ok) {
      console.warn(`Skipping ${ticket.account.name} — model_service returned ${res.status}`);
      continue;
    }
    const data = await res.json();

    await prisma.sentimentPrediction.create({
      data: {
        reviewId: ticket.id,
        classification: data.classification,
        riskWeight: data.risk_weight,
      },
    });
    console.log(`${ticket.account.name}: ${data.classification} (risk weight ${data.risk_weight})`);
    count++;
  }

  console.log(`Seeded ${count} real sentiment_predictions.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
