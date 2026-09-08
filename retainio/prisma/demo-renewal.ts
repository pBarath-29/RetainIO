import 'dotenv/config';
import { prisma } from '../db';
import { addMonths, formatTermDate, formatMoney, TIER_MONTHLY_RATE, OFFER_WINDOW_DAYS } from '../pricing';
import { dateOnlyUTC } from '../fusionSnapshot';

/**
 * Creates (and removes) throwaway accounts whose renewal dates have already passed, so
 * the renewal loop can actually be watched instead of waiting until October.
 *
 * These are SEPARATE accounts, prefixed "DEMO —". Nothing belonging to the nine real
 * accounts is read, moved or modified: no dates are shifted, no discounts invented. When
 * you are done, `remove` deletes the demo accounts and everything attached to them.
 *
 *   npx tsx prisma/demo-renewal.ts create
 *   npx tsx prisma/demo-renewal.ts remove
 */
const PREFIX = 'DEMO — ';

async function create() {
  const existing = await prisma.account.count({ where: { name: { startsWith: PREFIX } } });
  if (existing > 0) {
    console.log(`${existing} demo account(s) already exist. Run "remove" first if you want a clean set.`);
    return;
  }

  const manager = await prisma.user.findFirst({ where: { role: 'account_manager' } });
  const director = await prisma.user.findFirst({ where: { role: 'account_director' } });
  if (!manager || !director) return console.log('Need an account manager and a director in the database.');

  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000);

  async function make(label: string, tier: 'Basic' | 'Pro' | 'Enterprise', termEnd: Date, review: string) {
    const account = await prisma.account.create({
      data: { name: PREFIX + label, logoInitials: 'DM', industry: 'Demonstration', accountManagerId: manager!.id },
    });
    await prisma.subscription.create({
      data: {
        accountId: account.id, planTier: tier, mrr: TIER_MONTHLY_RATE[tier],
        termStart: addMonths(termEnd, -12), termEnd, durationMonths: 12, status: 'active',
      },
    });
    // The churn model needs a usage row to have any features to freeze at the renewal.
    await prisma.usageSnapshot.create({
      data: {
        accountId: account.id, accountAgeDays: 420, dailyUsageMins: 38,
        loginFrequencyBucket: 'Weekly', supportTickets90Days: 4, apiUtilizationRate: 0.55,
      },
    });
    // The fusion pipeline chains churn -> sentiment -> fusion, so without a review there
    // is nothing for the sentiment model to read and the account never gets a risk score
    // at all. No score means the Model Feedback table can only say "no prediction", which
    // would leave the most interesting column of the demo blank.
    await prisma.customerReview.create({
      data: { accountId: account.id, reviewText: review },
    });

    // The index snapshot the real flow would have written when this account entered its
    // offer window, 180 days before the renewal. Without it a demo renewal produces a row
    // measured AT the renewal, which the export correctly flags as leaky and unusable —
    // so the demo would misrepresent what a real training row looks like.
    //
    // The values are deliberately HEALTHIER than the account's current ones: six months
    // before a renewal it had not yet declined to where it is now. That is the whole point
    // of measuring early, and a demo that skipped it would hide the point.
    const windowOpened = new Date(termEnd.getTime() - OFFER_WINDOW_DAYS * 86400000);
    await prisma.renewalIndexSnapshot.create({
      data: {
        accountId: account.id,
        renewalDate: dateOnlyUTC(termEnd),
        frozenAt: windowOpened,
        reason: 'window_open',
        daysToRenewal: OFFER_WINDOW_DAYS,
        featureSnapshot: {
          Account_Age_Days: 420 - OFFER_WINDOW_DAYS,
          Daily_Usage_Mins: Math.round(38 * 1.6),
          Support_Tickets_90Days: 2,
          API_Utilization_Rate: 0.78,
          Login_Frequency: 'Daily',
          Plan_Tier: tier,
        },
        churnProba: 0.31,
        sentimentScore: 0.42,
        fusedProba: 0.36,
        dominantShapDriver: 'price_sensitive',
      },
    });
    return account;
  }

  // 1. Renews on its own, and has a discount waiting for exactly this renewal — so the
  //    discount should move from "scheduled" to "active" without anyone doing anything.
  const renewing = await make('Renewing Corp', 'Enterprise', daysAgo(2),
    'The platform has been steady this quarter and the team is using it daily. A couple of minor sync delays but support resolved them quickly.');
  const renewingSub = await prisma.subscription.findFirstOrThrow({ where: { accountId: renewing.id } });
  await prisma.auditLog.create({
    data: {
      accountId: renewing.id,
      action: '10% Retention Discount for 6 months Executed',
      discountApplied: 10, discountMonths: 6,
      discountStartsAt: renewingSub.termEnd,
      approverId: director.id,
      verificationStatus: 'Direct Approval (Within Manager Limit)',
      details: 'Demo discount, approved ahead of the renewal it applies to.',
    },
  });

  // 2. Gave notice before its renewal, so it should churn rather than roll.
  const leaving = await make('Departing Ltd', 'Pro', daysAgo(1),
    'Repeated API rate-limit failures have broken our nightly pipeline three times this month. Our champion has left and nobody internally is defending the renewal.');
  const leavingSub = await prisma.subscription.findFirstOrThrow({ where: { accountId: leaving.id } });
  await prisma.renewalIntent.create({
    data: {
      accountId: leaving.id, kind: 'churning', effectiveFor: leavingSub.termEnd,
      source: 'manual', recordedById: manager.id, notes: 'Told us in writing they are moving to a competitor.',
    },
  });

  // 3. Moving down a tier at renewal, so it should renew AND reprice.
  const shrinking = await make('Downsizing PLC', 'Enterprise', daysAgo(1),
    'A company-wide budget freeze means we are cutting seats next year. The product works but we cannot justify the current tier.');
  const shrinkingSub = await prisma.subscription.findFirstOrThrow({ where: { accountId: shrinking.id } });
  await prisma.renewalIntent.create({
    data: {
      accountId: shrinking.id, kind: 'downgrading', targetTier: 'Basic', effectiveFor: shrinkingSub.termEnd,
      source: 'manual', recordedById: manager.id, notes: 'Cutting seats for next year.',
    },
  });

  console.log('Created 3 demo accounts, all with renewal dates that have already passed:\n');
  console.log(`  ${PREFIX}Renewing Corp     Enterprise ${formatMoney(TIER_MONTHLY_RATE.Enterprise)}/mo  renewal ${formatTermDate(renewingSub.termEnd)}`);
  console.log('     no intent + a 10% discount scheduled for this renewal');
  console.log(`  ${PREFIX}Departing Ltd     Pro        ${formatMoney(TIER_MONTHLY_RATE.Pro)}/mo  renewal ${formatTermDate(leavingSub.termEnd)}`);
  console.log('     churn intent recorded');
  console.log(`  ${PREFIX}Downsizing PLC    Enterprise ${formatMoney(TIER_MONTHLY_RATE.Enterprise)}/mo  renewal ${formatTermDate(shrinkingSub.termEnd)}`);
  console.log('     downgrade-to-Basic intent recorded');
  console.log('\nNone of them has been resolved yet — every one is still active and unchanged,');
  console.log('which is the point: an intent does nothing until its renewal is processed.');
  console.log('\nNow RESTART THE SERVER. The renewal pass runs on startup and will resolve all three.');
}

async function remove() {
  const ids = (await prisma.account.findMany({
    where: { name: { startsWith: PREFIX } }, select: { id: true, name: true },
  }));
  if (ids.length === 0) return console.log('No demo accounts to remove.');

  const accountIds = ids.map(a => a.id);

  // The daily snapshot job scores EVERY account, so a demo account that has been alive
  // across one run will have real churn/sentiment/fusion rows and SHAP explanations
  // hanging off it. Those have to go first or the account delete fails on a foreign key —
  // deleted innermost-first: SHAP hangs off a churn prediction, fusion off both.
  await prisma.shapExplanation.deleteMany({
    where: { churnPrediction: { accountId: { in: accountIds } } },
  });
  await prisma.fusionScore.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.fusionMonthlySummary.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.churnPrediction.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.sentimentPrediction.deleteMany({
    where: { review: { accountId: { in: accountIds } } },
  });
  await prisma.customerReview.deleteMany({ where: { accountId: { in: accountIds } } });
  // The snapshot also writes a Gemini-generated diagnosis per account.
  await prisma.aiExplanation.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.conversation.deleteMany({ where: { accountId: { in: accountIds } } });

  // Added after this script was first written, and its absence made `remove` fail on a
  // foreign key — leaving demo accounts behind while reporting nothing. Any table that
  // references an account has to be listed here or the cleanup silently stops working.
  await prisma.renewalIndexSnapshot.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.renewalRecord.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.renewalIntent.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.auditLog.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.discountRequest.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.usageSnapshot.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.subscription.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });

  console.log(`Removed ${ids.length} demo account(s): ${ids.map(a => a.name).join(', ')}`);
  console.log(`Your data: ${await prisma.account.count()} accounts, ${await prisma.auditLog.count()} audit rows, ${await prisma.renewalRecord.count()} renewal records.`);
}

const cmd = process.argv[2];
if (cmd === 'create') await create();
else if (cmd === 'remove') await remove();
else console.log('Usage: npx tsx prisma/demo-renewal.ts <create|remove>');

await prisma.$disconnect();
