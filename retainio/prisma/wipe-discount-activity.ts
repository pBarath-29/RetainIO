import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Clears the seeded discount/approval activity so the app starts from a state
// where genuinely nothing has been requested, approved or rejected.
//
// These rows came from prisma/seed.ts loading mockData.ts's hand-authored
// INITIAL_DISCOUNT_REQUESTS and INITIAL_AUDIT_LOGS, plus a couple left over
// from smoke-testing. They were also mutually inconsistent: the two mock
// arrays name different accounts, so the ledger claimed submissions for
// CloudPulse/BioHealth/Synergy while the only actual requests were for
// Acme/Globex/Umbrella.
//
// Deliberately NOT touched: churn/sentiment/fusion predictions, SHAP factors
// and monthly summaries. Those are real model output — deleting them would
// empty the risk scores and trend charts for no reason.
//
// currentDiscountApproved needs no separate clearing: mapAccount derives it
// from audit_logs, so removing those resets every badge to "None".

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

async function main() {
  const beforeLogs = await prisma.auditLog.count();
  const beforeReqs = await prisma.discountRequest.count();
  console.log(`Before:  audit_logs=${beforeLogs}  discount_requests=${beforeReqs}`);

  // Order matters only if a FK ever links them; deleting logs first is safe either way.
  const logs = await prisma.auditLog.deleteMany({});
  const reqs = await prisma.discountRequest.deleteMany({});
  console.log(`Deleted: ${logs.count} audit log(s), ${reqs.count} discount request(s)`);

  console.log('\nUntouched (still real):');
  console.log(`  churn_predictions        ${await prisma.churnPrediction.count()}`);
  console.log(`  sentiment_predictions    ${await prisma.sentimentPrediction.count()}`);
  console.log(`  fusion_scores            ${await prisma.fusionScore.count()}`);
  console.log(`  fusion_monthly_summaries ${await prisma.fusionMonthlySummary.count()}`);
  console.log(`  shap_explanations        ${await prisma.shapExplanation.count()}`);
  console.log(`  accounts ${await prisma.account.count()}  users ${await prisma.user.count()}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
