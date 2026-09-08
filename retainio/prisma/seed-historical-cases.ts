import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { HistoricalCase } from '../src/types';

// Loads the AI Advisor's retrieval corpus into historical_cases.
//
// Idempotent — upserts on case_ref, so re-running updates the existing rows
// rather than duplicating them. Safe to run against a database that already
// has cases.
//
// These 22 cases are demo data: invented situations with plausible outcomes.
// What's real is the retrieval over them (Gemini embeddings + cosine
// similarity, and the structural match in knowledgeGraph.ts). Adding genuine
// cases here improves the advisor without touching any code.

// The corpus lives here rather than in a shared mock file: this script is
// the one place that needs it, and keeping it inline means the app itself
// carries no hardcoded case data at all.
const HISTORICAL_RAG_CASES: HistoricalCase[] = [
  {
    id: 'CASE-01',
    companyName: 'OmniData Inc',
    industry: 'Enterprise Software',
    initialRisk: 86,
    primaryIssue: 'v2 API migration breaking changes + 50% login reduction',
    actionTaken: 'Offered 12% renewal discount with dedicated engineering office hours for integration',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Technical friction combined with pricing concerns responds best to a combined discount + technical assistance package.'
  },
  {
    id: 'CASE-02',
    companyName: 'Starlight Media',
    industry: 'Media & Streaming',
    initialRisk: 92,
    primaryIssue: 'Executive sponsor turnover and non-usage of premium features',
    actionTaken: 'Conducted executive re-onboarding session, provided 10% discount',
    outcome: 'Retained (Upsold)',
    learnings: 'When sponsor leaves, re-engaging new VP within 14 days with tailored executive summary prevents churn.'
  },
  {
    id: 'CASE-03',
    companyName: 'QuantX Analytics',
    industry: 'Financial SaaS',
    initialRisk: 89,
    primaryIssue: 'Competitor offering 30% lower price point during contract renewal',
    actionTaken: 'Only sent automated generic email without discount offer',
    outcome: 'Churned',
    learnings: 'Delay in offering retention incentives and failing to leverage account manager relationship led to churn.'
  },
  {
    id: 'CASE-04',
    companyName: 'Vertex Logistics',
    industry: 'Supply Chain SaaS',
    initialRisk: 81,
    primaryIssue: 'Integration failures and recurring API timeouts during peak shipping season',
    actionTaken: 'Assigned a dedicated integration engineer and offered a 10% discount for the disruption',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'A pure technical problem still benefits from a small discount as a goodwill gesture, as long as the underlying fix ships too.'
  },
  {
    id: 'CASE-05',
    companyName: 'BrightPath Health',
    industry: 'Healthcare SaaS',
    initialRisk: 74,
    primaryIssue: 'Procurement freeze and budget cuts flagged during renewal conversations',
    actionTaken: 'Offered a 15% retention discount tied to a 2-year commitment',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Pure budget-driven risk responds strongly and predictably to a discount lever — the classic price-sensitive case.'
  },
  {
    id: 'CASE-06',
    companyName: 'NimbusCloud',
    industry: 'Cloud Infrastructure',
    initialRisk: 83,
    primaryIssue: 'Repeated platform outages during business hours, no pricing complaints raised',
    actionTaken: 'Root-caused and fixed the outage source, ran a technical walkthrough session, no discount offered',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'When the complaint is entirely technical, a discount is unnecessary — fixing the problem and demonstrating it in a walkthrough is what earns trust back.'
  },
  {
    id: 'CASE-07',
    companyName: 'Foundry Robotics',
    industry: 'Industrial Manufacturing Tech',
    initialRisk: 78,
    primaryIssue: 'Competitor undercut pricing by roughly 25% during a renewal cycle',
    actionTaken: 'Matched competitive pressure with a 20% discount',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Competitor price pressure needs a price response — technical reassurance alone does not address a price-driven objection.'
  },
  {
    id: 'CASE-08',
    companyName: 'Pinnacle Retail Systems',
    industry: 'Retail Technology',
    initialRisk: 88,
    primaryIssue: 'Champion/sponsor departed with no internal replacement identified',
    actionTaken: 'Executive outreach attempted, no new internal champion was ever established',
    outcome: 'Churned',
    learnings: 'A discount cannot fix a relationship vacuum — without a champion inside the account, no retention lever gets traction.'
  },
  {
    id: 'CASE-09',
    companyName: 'Solstice Financial',
    industry: 'FinTech',
    initialRisk: 85,
    primaryIssue: 'Persistent data synchronization errors between core banking system and the platform',
    actionTaken: 'Offered a 10% discount without addressing the underlying sync bug',
    outcome: 'Churned',
    learnings: 'A discount aimed at a technical problem the customer actually cares about fixing does not work — this is the exact failure mode the uplift model is built to avoid.'
  },
  {
    id: 'CASE-10',
    companyName: 'Everline Insurance',
    industry: 'InsurTech',
    initialRisk: 76,
    primaryIssue: 'Customer flagged a 40% year-over-year renewal price increase as unacceptable',
    actionTaken: 'Offered a 10% discount plus a quarterly payment plan to soften the increase',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Sticker-shock renewal pricing responds well to a combination of a modest discount and payment-term flexibility, not discount alone.'
  },
  {
    id: 'CASE-11',
    companyName: 'Kestrel Analytics',
    industry: 'Data & BI',
    initialRisk: 62,
    primaryIssue: 'Low, unclear feature engagement — no specific complaint raised',
    actionTaken: 'Ran a product training refresh and onboarding session for the account',
    outcome: 'Retained (Upsold)',
    learnings: 'When risk is driven by disengagement rather than a specific complaint, re-education often converts better than a discount.'
  },
  {
    id: 'CASE-12',
    companyName: 'Ridgeline Security',
    industry: 'Cybersecurity',
    initialRisk: 80,
    primaryIssue: 'Alerting system flooding the security team with false positives',
    actionTaken: 'Shipped a tuning fix and ran a dedicated walkthrough of the new alert thresholds',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'A product-quality problem needs a product fix demonstrated directly to the team experiencing it — a walkthrough closes that loop.'
  },
  {
    id: 'CASE-13',
    companyName: 'Amberlight Media',
    industry: 'AdTech',
    initialRisk: 87,
    primaryIssue: 'Company-wide budget freeze announced mid-contract',
    actionTaken: 'Offered a discount, but it arrived after the internal budget decision had already been finalized',
    outcome: 'Churned',
    learnings: 'Timing matters — even the right lever (discount for a budget-driven case) fails if it comes after the customer has already decided.'
  },
  {
    id: 'CASE-14',
    companyName: 'Cobalt Manufacturing',
    industry: 'Industrial IoT',
    initialRisk: 71,
    primaryIssue: 'Sensor data lag causing delayed dashboards on the shop floor',
    actionTaken: 'Delivered a performance fix and dedicated technical support, no discount offered',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Another confirmation that discounting a pure latency/performance complaint is unnecessary once the fix actually ships.'
  },
  {
    id: 'CASE-15',
    companyName: 'Driftwood Hospitality',
    industry: 'Hospitality SaaS',
    initialRisk: 69,
    primaryIssue: 'Poor initial onboarding experience left the team confused about core workflows',
    actionTaken: 'Assigned a dedicated Customer Success Manager and rebuilt the onboarding plan',
    outcome: 'Retained (Upsold)',
    learnings: 'Onboarding-driven risk is a relationship/enablement problem, not a pricing problem — a discount would have been the wrong lever entirely.'
  },
  {
    id: 'CASE-16',
    companyName: 'Ironclad Legal Tech',
    industry: 'LegalTech',
    initialRisk: 65,
    primaryIssue: 'Cheaper competitor with a narrower feature set was being evaluated',
    actionTaken: 'Ran a value-based renewal conversation highlighting feature gaps in the competitor, no discount given',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Not every price-adjacent risk needs a discount — sometimes reinforcing value differentiation is enough to hold the line.'
  },
  {
    id: 'CASE-17',
    companyName: 'Meridian Biotech',
    industry: 'Biotech SaaS',
    initialRisk: 73,
    primaryIssue: 'Internal security/compliance audit raised concerns about data handling',
    actionTaken: 'Provided a dedicated security review session and documentation package, no discount offered',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Compliance-driven risk is resolved with reassurance and documentation, not a commercial lever.'
  },
  {
    id: 'CASE-18',
    companyName: 'Palisade Education',
    industry: 'EdTech',
    initialRisk: 58,
    primaryIssue: 'Seasonal usage drop during summer break, mistaken internally for disengagement',
    actionTaken: 'Proactive check-in call confirming the drop was expected seasonal behavior',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Not every risk signal needs an intervention — sometimes the right action is confirming the account is fine and doing nothing further.'
  },
  {
    id: 'CASE-19',
    companyName: 'Thornwood Energy',
    industry: 'Energy & Utilities',
    initialRisk: 84,
    primaryIssue: 'Sector-wide budget cuts following a downturn in energy markets',
    actionTaken: 'Offered a discount bundled with an extended multi-year contract term',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Macro/sector-driven budget pressure responds well to a discount when it is paired with a longer commitment that also benefits the vendor.'
  },
  {
    id: 'CASE-20',
    companyName: 'Voxel Gaming',
    industry: 'Gaming & Media',
    initialRisk: 90,
    primaryIssue: 'Aggressive API rate limiting was blocking core product functionality',
    actionTaken: 'Offered a discount without resolving the rate-limiting issue',
    outcome: 'Churned',
    learnings: 'A second confirmation that discounting a blocking technical issue, without fixing it, does not move the outcome.'
  },
  {
    id: 'CASE-21',
    companyName: 'Halcyon Wellness',
    industry: 'Health & Wellness',
    initialRisk: 82,
    primaryIssue: 'Multiple unresolved support escalations had eroded trust in the account team',
    actionTaken: 'Executive apology call, discount offer, and a dedicated support track — combined package',
    outcome: 'Retained (Renewed Full Term)',
    learnings: 'Trust-erosion cases from repeated poor support need a multi-part response — a discount alone would have read as tone-deaf.'
  },
  {
    id: 'CASE-22',
    companyName: 'Granite Peak Logistics',
    industry: 'Logistics',
    initialRisk: 79,
    primaryIssue: 'Aggressive undercut pricing from a new market entrant',
    actionTaken: 'Matched the competitive discount and added a loyalty-tier upgrade',
    outcome: 'Retained (Upsold)',
    learnings: 'Matching a competitor discount can be turned into an upsell opportunity rather than a pure defensive cost.'
  }
];

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

// The TS union uses the display strings; Prisma's enum identifiers can't
// contain spaces or parentheses, so map between them.
const OUTCOME_ENUM: Record<string, 'Retained_Renewed' | 'Retained_Upsold' | 'Churned'> = {
  'Retained (Renewed Full Term)': 'Retained_Renewed',
  'Retained (Upsold)': 'Retained_Upsold',
  'Churned': 'Churned',
};

async function main() {
  let created = 0, updated = 0;

  for (const c of HISTORICAL_RAG_CASES) {
    const outcome = OUTCOME_ENUM[c.outcome];
    if (!outcome) {
      console.warn(`Skipping ${c.id} — unrecognised outcome "${c.outcome}"`);
      continue;
    }

    const existing = await prisma.historicalCase.findUnique({ where: { caseRef: c.id } });
    await prisma.historicalCase.upsert({
      where: { caseRef: c.id },
      create: {
        caseRef: c.id,
        companyName: c.companyName,
        industry: c.industry,
        initialRisk: c.initialRisk,
        primaryIssue: c.primaryIssue,
        actionTaken: c.actionTaken,
        outcome,
        learnings: c.learnings,
      },
      update: {
        companyName: c.companyName,
        industry: c.industry,
        initialRisk: c.initialRisk,
        primaryIssue: c.primaryIssue,
        actionTaken: c.actionTaken,
        outcome,
        learnings: c.learnings,
      },
    });
    existing ? updated++ : created++;
  }

  console.log(`historical_cases: ${created} created, ${updated} updated (${await prisma.historicalCase.count()} total).`);

  const byOutcome = await prisma.historicalCase.groupBy({ by: ['outcome'], _count: true });
  for (const row of byOutcome) console.log(`  ${row.outcome.padEnd(18)} ${row._count}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
