import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Bootstraps an EMPTY database with the demo organisation: staff logins,
// customer accounts, their subscriptions, usage telemetry and support
// tickets. Never runs during normal operation — the app reads only from the
// database — so this exists for a fresh deployment, a reset Supabase
// project, or a clone of the repo.
//
// Seeds the two Account Managers (Sarah Jenkins, Elena Rostova) and splits
// all 9 accounts between them — balanced on risk (2 High Risk accounts each)
// and MRR (~$56k vs ~$50k), not just on count. mockData.ts's original
// "Alex Rivera" / "Jordan Vance" managers were dropped; their accounts are
// reassigned in the accountSeeds list below.
//
// No Account Director is seeded. A Director's approvals are gated on a
// biometric check, and a face can only be enrolled by the person themselves
// through the signup flow — so seeding a Director would create an account
// that looks authorised but can't actually approve anything. Register the
// Director through /signup instead.
//
// Discount requests and audit logs are NOT seeded — see the note further
// down. A fresh install opens on a dashboard where nothing has been
// requested or approved, because nothing has.

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

function monthsBefore(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() - months);
  return d;
}

function loginBucket(loginsPerMonth: number): 'Daily' | 'Weekly' | 'Rarely' {
  if (loginsPerMonth < 10) return 'Rarely';
  if (loginsPerMonth <= 25) return 'Weekly';
  return 'Daily';
}

async function main() {
  // ---- users -------------------------------------------------------
  const userSeeds = [
    { name: 'Sarah Jenkins', role: 'account_manager' as const, email: 'sarah.jenkins@retain.io', title: 'Senior Account Manager', department: 'Customer Success', employeeId: 'EMP-9042', maxSelfApprovalLimit: 10, avatarInitials: 'SJ' },
    { name: 'Elena Rostova', role: 'account_manager' as const, email: 'elena.rostova@retain.io', title: 'Account Manager', department: 'Customer Success', employeeId: 'EMP-9043', maxSelfApprovalLimit: 10, avatarInitials: 'ER' },
  ];

  const usersByName = new Map<string, { id: string }>();
  for (const u of userSeeds) {
    const created = await prisma.user.create({ data: u });
    usersByName.set(u.name, created);
  }

  // ---- accounts + subscriptions + usage_snapshots + support_tickets --
  const accountSeeds = [
    { name: 'Acme Corp', logo: 'AC', industry: 'Enterprise Software', manager: 'Sarah Jenkins', mrr: 12083, plan: 'Enterprise' as const, renewal: '2026-08-12', duration: 1,
      accountAgeDays: 912, dailyUsageMins: 17, loginsPerMonth: 12, supportTickets90Days: 8, apiUsageRate: 2400, apiBenchmark: 15000,
      ticketBody: 'Integration keeps failing after the recent v3 upgrade and API latency increased significantly. Our team is struggling to meet SLA.' },
    { name: 'Globex Inc', logo: 'GI', industry: 'Global Manufacturing & Logistics', manager: 'Elena Rostova', mrr: 15833, plan: 'Enterprise' as const, renewal: '2026-08-19', duration: 1,
      accountAgeDays: 654, dailyUsageMins: 21, loginsPerMonth: 18, supportTickets90Days: 9, apiUsageRate: 3100, apiBenchmark: 18000,
      ticketBody: 'Budget freezes across operational units require 20% cost reduction or non-renewal in Q4.' },
    { name: 'Umbrella Tech', logo: 'UT', industry: 'Cybersecurity & Infrastructure', manager: 'Elena Rostova', mrr: 7333, plan: 'Enterprise' as const, renewal: '2026-08-25', duration: 1,
      accountAgeDays: 418, dailyUsageMins: 29, loginsPerMonth: 24, supportTickets90Days: 4, apiUsageRate: 8500, apiBenchmark: 12000,
      ticketBody: 'Downsized security team by 30 seats; requesting 12% fee adjustment to retain enterprise tier.' },
    { name: 'CloudPulse Technologies', logo: 'CP', industry: 'Cloud Infrastructure', manager: 'Elena Rostova', mrr: 17500, plan: 'Enterprise' as const, renewal: '2026-08-15', duration: 1,
      accountAgeDays: 214, dailyUsageMins: 8, loginsPerMonth: 5, supportTickets90Days: 12, apiUsageRate: 800, apiBenchmark: 25000,
      ticketBody: 'We are completely blocked by downtime in US-East cluster. We are requesting immediate termination of contract and refund.' },
    { name: 'FinTech Nexus Solutions', logo: 'FN', industry: 'Financial Technology', manager: 'Elena Rostova', mrr: 7333, plan: 'Pro' as const, renewal: '2026-09-02', duration: 1,
      accountAgeDays: 507, dailyUsageMins: 36, loginsPerMonth: 28, supportTickets90Days: 4, apiUsageRate: 9200, apiBenchmark: 12000,
      ticketBody: 'Product works overall, but pricing feels high compared to new market alternatives.' },
    { name: 'BioHealth Systems', logo: 'BH', industry: 'Healthcare SaaS', manager: 'Sarah Jenkins', mrr: 14583, plan: 'Enterprise' as const, renewal: '2026-08-22', duration: 1,
      accountAgeDays: 763, dailyUsageMins: 47, loginsPerMonth: 38, supportTickets90Days: 3, apiUsageRate: 18400, apiBenchmark: 18000,
      ticketBody: 'HIPAA compliance audit export took longer than expected during our internal review.' },
    { name: 'Apex Logistics Global', logo: 'AL', industry: 'Supply Chain & Logistics', manager: 'Sarah Jenkins', mrr: 26667, plan: 'Enterprise' as const, renewal: '2026-09-04', duration: 1,
      accountAgeDays: 1104, dailyUsageMins: 84, loginsPerMonth: 92, supportTickets90Days: 2, apiUsageRate: 48000, apiBenchmark: 35000,
      ticketBody: 'RetainIO / platform has automated our tracking workflows tremendously. Looking forward to expansion next quarter.' },
    { name: 'Novus Media Labs', logo: 'NM', industry: 'Digital Media & Marketing', manager: 'Sarah Jenkins', mrr: 2917, plan: 'Basic' as const, renewal: '2026-08-09', duration: 1,
      accountAgeDays: 331, dailyUsageMins: 23, loginsPerMonth: 14, supportTickets90Days: 5, apiUsageRate: 1200, apiBenchmark: 5000,
      ticketBody: 'Pricing on basic tier feels too steep given recent decrease in active marketing campaigns.' },
    { name: 'Synergy AI Studio', logo: 'SA', industry: 'Design & AI Agency', manager: 'Elena Rostova', mrr: 2000, plan: 'Basic' as const, renewal: '2026-08-28', duration: 1,
      accountAgeDays: 958, dailyUsageMins: 56, loginsPerMonth: 42, supportTickets90Days: 1, apiUsageRate: 6400, apiBenchmark: 4000,
      ticketBody: 'Basic tier fits our boutique agency needs perfectly. Great API performance.' },
  ];

  const accountsByName = new Map<string, { id: string }>();

  for (const a of accountSeeds) {
    const account = await prisma.account.create({
      data: {
        name: a.name,
        logoInitials: a.logo,
        industry: a.industry,
        accountManagerId: usersByName.get(a.manager)!.id,
      },
    });
    accountsByName.set(a.name, account);

    const termEnd = new Date(a.renewal);
    await prisma.subscription.create({
      data: {
        accountId: account.id,
        planTier: a.plan,
        mrr: a.mrr,
        termStart: monthsBefore(termEnd, a.duration),
        termEnd,
        durationMonths: a.duration,
        status: 'active',
      },
    });

    await prisma.usageSnapshot.create({
      data: {
        accountId: account.id,
        accountAgeDays: a.accountAgeDays,
        dailyUsageMins: a.dailyUsageMins,
        loginFrequencyBucket: loginBucket(a.loginsPerMonth),
        supportTickets90Days: a.supportTickets90Days,
        apiUtilizationRate: Number((a.apiUsageRate / a.apiBenchmark).toFixed(4)),
      },
    });

    await prisma.customerReview.create({
      data: {
        accountId: account.id,
        reviewText: a.ticketBody,
      },
    });
  }

  // discount_requests and audit_logs are deliberately NOT seeded.
  //
  // They used to be, from mockData.ts's INITIAL_DISCOUNT_REQUESTS and
  // INITIAL_AUDIT_LOGS — two independently written arrays naming different
  // accounts, so the seeded ledger claimed submissions for accounts that had
  // no request, while the accounts that did have requests had no submission
  // logged. Worse, it meant a fresh install opened on a dashboard already
  // showing approvals and pending escalations nobody had performed.
  //
  // Both tables are now only ever written by real actions in the app, where
  // server.ts creates the request and its audit entry in one transaction —
  // so they cannot disagree.

  console.log(`Seeded ${userSeeds.length} users, ${accountSeeds.length} accounts (+ subscriptions, usage snapshots, support tickets). No discount requests or audit logs — those come from real actions only.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
