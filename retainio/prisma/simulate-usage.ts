import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { LoginFrequency } from '@prisma/client';
import { prisma } from '../db';
import {
  computeRealFusion, fusionRiskCategory, rollupMonthlyForAccount,
  saveShapExplanations, dateOnlyUTC, type RiskBandEnum,
} from '../fusionSnapshot';

/**
 * SIMULATED usage telemetry. This invents data — deliberately, and it should never be
 * described as anything else.
 *
 *   npx tsx prisma/simulate-usage.ts status
 *   npx tsx prisma/simulate-usage.ts backfill [days]     default 180
 *   npx tsx prisma/simulate-usage.ts daily
 *   npx tsx prisma/simulate-usage.ts reset
 *
 * WHY THIS EXISTS. Every account has exactly one usage snapshot, all captured on the same
 * day. Nothing ever writes a second, so nothing about an account ever changes: the churn
 * model scores identical inputs forever, the trajectory chart draws a line through
 * repeated values, and a six-month average would average one number. The models exist to
 * detect change — falling usage, rising tickets — and there was no change to detect.
 *
 * WHY IT IS HONEST TO DO THIS. The rest of the project is synthetic already: Churn.csv,
 * the 180,000-row uplift set, the nine fictional accounts. Simulated telemetry is
 * consistent with that. What would NOT be acceptable is the app presenting these readings
 * as measured. The write-up must state that usage telemetry is simulated, and this file is
 * named so nobody mistakes it for an ingestion job.
 *
 * HISTORY IS GENERATED BACKWARDS. Today's stored values are the fixed point; the simulator
 * works backwards to invent a plausible route to them. After a backfill every number on
 * screen is exactly what it was. Generating forwards from an invented start would overwrite
 * the present with fiction — and the current values are the ones the existing fusion
 * scores, SHAP explanations and risk bands were computed from.
 */
// import.meta.dirname, not __dirname: this file uses top-level await, so it is an ES
// module and __dirname does not exist in one.
const MANIFEST = path.join(import.meta.dirname, '.simulation-manifest.json');

type Trajectory = 'collapsing' | 'declining' | 'drifting' | 'stable' | 'healthy';

interface Manifest {
  createdAt: string;
  usageSnapshotIds: string[];
  fusionScoreIds: string[];
  churnPredictionIds: string[];
  sentimentPredictionIds: string[];
  monthsTouched: string[];
}

const emptyManifest = (): Manifest => ({
  createdAt: new Date().toISOString(), usageSnapshotIds: [], fusionScoreIds: [],
  churnPredictionIds: [], sentimentPredictionIds: [], monthsTouched: [],
});

function readManifest(): Manifest | null {
  if (!fs.existsSync(MANIFEST)) return null;
  // Fields are backfilled because a manifest written before one existed would otherwise
  // have `undefined` where an array is expected, and the first push against it throws —
  // losing the record of every row created in that run, which is what reset depends on.
  return { ...emptyManifest(), ...JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) };
}
const writeManifest = (m: Manifest) => fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2), 'utf8');

// Seeded PRNG (mulberry32), keyed per account, so a re-run reproduces the same history
// rather than inventing a different past each time.
function rng(seed: string) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Which story explains the state this account is already in.
 *
 * Derived from the values rather than hardcoded per account name, so it still holds if an
 * account is added or its numbers change. The point is that the invented history AGREES
 * with what the app already shows: an account whose SHAP drivers say "low usage, high
 * ticket friction" should have a history of decline, not a healthy climb ending in a
 * cliff.
 */
function fitTrajectory(u: {
  dailyUsageMins: number; supportTickets90Days: number;
  apiUtilizationRate: number; loginFrequencyBucket: string;
}): Trajectory {
  const friction = u.supportTickets90Days / (u.dailyUsageMins + 1);
  if (u.loginFrequencyBucket === 'Rarely' || friction > 0.8) return 'collapsing';
  if (friction > 0.35) return 'declining';
  if (u.dailyUsageMins < 25) return 'drifting';
  if (u.dailyUsageMins >= 50 && u.supportTickets90Days <= 2) return 'healthy';
  return 'stable';
}

// How each metric stood `daysAgo` days ago, as a multiple of today's value.
// >1 for usage on a declining account (it used to be higher); <1 for tickets (there used
// to be fewer). `progress` runs 0 (today) to 1 (start of the window).
const SHAPE: Record<Trajectory, { usage: (p: number) => number; tickets: (p: number) => number; api: (p: number) => number }> = {
  collapsing: { usage: p => 1 + 3.2 * p, tickets: p => 1 - 0.80 * p, api: p => 1 + 2.6 * p },
  declining:  { usage: p => 1 + 1.5 * p, tickets: p => 1 - 0.60 * p, api: p => 1 + 1.2 * p },
  drifting:   { usage: p => 1 + 0.5 * p, tickets: p => 1 - 0.30 * p, api: p => 1 + 0.4 * p },
  stable:     { usage: p => 1 + 0.05 * p, tickets: p => 1 - 0.05 * p, api: p => 1 + 0.05 * p },
  healthy:    { usage: p => 1 - 0.40 * p, tickets: p => 1 + 0.80 * p, api: p => 1 - 0.35 * p },
};

// Login frequency steps DOWN as an account deteriorates, so a collapsing account was
// logging in daily six months ago. Derived from a usage threshold instead, this would
// contradict the seeded data (FinTech is Daily at 36 min/day, BioHealth Daily at 47).
function loginAt(current: string, trajectory: Trajectory, progress: number): LoginFrequency {
  const ladder = ['Rarely', 'Weekly', 'Daily'];
  const idx = ladder.indexOf(current);
  if (idx < 0) return current as LoginFrequency;
  const steps = trajectory === 'collapsing' ? (progress > 0.55 ? 2 : progress > 0.25 ? 1 : 0)
    : trajectory === 'declining' ? (progress > 0.6 ? 1 : 0)
    : trajectory === 'healthy' ? (progress > 0.7 ? -1 : 0)
    : 0;
  return ladder[Math.max(0, Math.min(2, idx + steps))] as LoginFrequency;
}

interface Reading {
  accountAgeDays: number; dailyUsageMins: number; supportTickets90Days: number;
  apiUtilizationRate: number; loginFrequencyBucket: LoginFrequency;
}

function readingFor(
  current: Reading, trajectory: Trajectory, daysAgo: number, windowDays: number, rand: () => number,
): Reading {
  const p = Math.min(1, daysAgo / windowDays);
  const s = SHAPE[trajectory];
  const jitter = () => 1 + (rand() - 0.5) * 0.12;  // +/-6% day-to-day noise

  return {
    // NOT simulated. An account's age on a past date is arithmetic, and adding noise to it
    // would be inventing a fact that is already known exactly.
    accountAgeDays: Math.max(1, current.accountAgeDays - daysAgo),
    dailyUsageMins: Math.max(1, Math.min(
      Math.round(current.dailyUsageMins * 3), Math.round(current.dailyUsageMins * s.usage(p) * jitter()))),
    supportTickets90Days: Math.max(0, Math.round(current.supportTickets90Days * s.tickets(p) * jitter())),
    // Not a 0..1 rate — Synergy sits at 1.6, so it is a ratio against a benchmark.
    apiUtilizationRate: Math.max(0.01, Math.min(3, Number((current.apiUtilizationRate * s.api(p) * jitter()).toFixed(4)))),
    loginFrequencyBucket: loginAt(current.loginFrequencyBucket, trajectory, p),
  };
}

const RISK_BAND_ENUM: Record<string, RiskBandEnum> = {
  'High Risk': 'High_Risk', 'Medium Risk': 'Medium_Risk', 'Low Risk': 'Low_Risk',
};

async function loadAccounts() {
  return prisma.account.findMany({
    include: {
      usageSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1 },
      customerReviews: { orderBy: { submittedAt: 'desc' }, take: 1 },
    },
    orderBy: { name: 'asc' },
  });
}

async function status() {
  const accounts = await loadAccounts();
  console.log('\naccount                     snapshots   span                       trajectory');
  console.log('-'.repeat(84));
  for (const a of accounts) {
    const all = await prisma.usageSnapshot.findMany({
      where: { accountId: a.id }, orderBy: { capturedAt: 'asc' },
    });
    const u = a.usageSnapshots[0];
    const span = all.length
      ? `${all[0].capturedAt.toISOString().slice(0, 10)} .. ${all[all.length - 1].capturedAt.toISOString().slice(0, 10)}`
      : '—';
    console.log(`${a.name.padEnd(27)} ${String(all.length).padStart(5)}   ${span.padEnd(26)} ${u ? fitTrajectory(u) : '—'}`);
  }
  console.log(`\ntotals: ${await prisma.usageSnapshot.count()} usage snapshots, ` +
              `${await prisma.fusionScore.count()} fusion scores, ` +
              `${await prisma.fusionMonthlySummary.count()} monthly summaries`);
  const m = readManifest();
  console.log(m
    ? `\nsimulation manifest: ${m.usageSnapshotIds.length} snapshots + ${m.fusionScoreIds.length} scores created ${m.createdAt.slice(0, 10)}`
    : '\nno simulation manifest — nothing has been generated');
}

async function backfill(days: number) {
  if (readManifest()) {
    console.log('A simulation already exists. Run `reset` first if you want to regenerate.');
    return;
  }

  const accounts = await loadAccounts();
  const today = dateOnlyUTC();
  const manifest: Manifest = emptyManifest();

  console.log(`\nGenerating ${days} days of simulated telemetry for ${accounts.length} accounts.`);
  console.log('Today\'s values are the fixed point — history is generated backwards to reach them.\n');

  for (const account of accounts) {
    const current = account.usageSnapshots[0];
    if (!current) { console.log(`  ${account.name}: no usage snapshot, skipped`); continue; }

    const trajectory = fitTrajectory(current);
    const rand = rng(account.id);
    const base: Reading = {
      accountAgeDays: current.accountAgeDays,
      dailyUsageMins: current.dailyUsageMins,
      supportTickets90Days: current.supportTickets90Days,
      apiUtilizationRate: current.apiUtilizationRate,
      loginFrequencyBucket: current.loginFrequencyBucket,
    };

    // The sentiment model reads the review text, which never changes. Computing it once
    // per account rather than once per day turns ~1,600 model calls into 9.
    let sentimentPredictionId: string | null = null;
    let firstDay = true;

    // History is anchored to the EXISTING snapshot's own date and generated strictly
    // before it, so that row stays the latest and its values stay exactly what they are.
    //
    // Anchoring to today instead put generated rows after it: the newest one then became
    // the account's current reading, replacing the seeded values with jittered ones
    // (Acme's usage read 19 instead of 17) and making accountAgeDays jump backwards,
    // because the seeded snapshot is dated weeks ago rather than today.
    const anchor = dateOnlyUTC(current.capturedAt);
    const readings: { date: Date; reading: Reading }[] = [];
    for (let d = days; d >= 1; d--) {
      const date = new Date(anchor.getTime() - d * 86400000);
      readings.push({ date, reading: readingFor(base, trajectory, d, days, rand) });
    }

    let scored = 0;
    for (const { date, reading } of readings) {
      const snap = await prisma.usageSnapshot.create({
        data: { accountId: account.id, capturedAt: date, ...reading },
      });
      manifest.usageSnapshotIds.push(snap.id);

      // Skip a day that already has a real score rather than competing with it — the
      // unique constraint is on (accountId, snapshotDate) and those rows are not ours.
      const existing = await prisma.fusionScore.findUnique({
        where: { accountId_snapshotDate: { accountId: account.id, snapshotDate: date } },
      });
      if (existing) continue;

      try {
        const { churnData, sentData, fusionData } = await computeRealFusion(account.id, undefined, reading);

        const churn = await prisma.churnPrediction.create({
          data: { accountId: account.id, predictedAt: date, churnProba: churnData.churn_proba,
                  riskBand: RISK_BAND_ENUM[churnData.risk_band] },
        });
        manifest.churnPredictionIds.push(churn.id);
        // Deliberately no SHAP for historical days: only the latest prediction's factors
        // are ever displayed, and generating them here would add thousands of unread rows.

        if (firstDay) {
          const sent = await prisma.sentimentPrediction.create({
            data: { reviewId: account.customerReviews[0]?.id, predictedAt: date,
                    classification: sentData.classification, riskWeight: sentData.risk_weight },
          });
          manifest.sentimentPredictionIds.push(sent.id);
          sentimentPredictionId = sent.id;
          firstDay = false;
        }

        const fs_ = await prisma.fusionScore.create({
          data: {
            accountId: account.id, snapshotDate: date,
            churnPredictionId: churn.id, sentimentPredictionId,
            fusionScore: Math.round(fusionData.fusion_proba * 100),
            riskCategory: fusionRiskCategory(fusionData.fusion_proba),
          },
        });
        manifest.fusionScoreIds.push(fs_.id);
        manifest.monthsTouched.push(date.toISOString().slice(0, 7));
        scored++;
      } catch (err: any) {
        console.log(`  ${account.name} ${date.toISOString().slice(0, 10)}: ${err.message || err}`);
      }
    }

    const oldest = readings[0].reading;
    console.log(
      `  ${account.name.padEnd(26)} ${trajectory.padEnd(11)} ` +
      `usage ${String(oldest.dailyUsageMins).padStart(3)} -> ${String(base.dailyUsageMins).padStart(3)} min   ` +
      `tickets ${String(oldest.supportTickets90Days).padStart(2)} -> ${String(base.supportTickets90Days).padStart(2)}   ` +
      `${scored} day(s) scored`
    );
  }

  // Rebuild the monthly averages both trend charts read.
  const months = [...new Set(manifest.monthsTouched)].sort();
  for (const account of accounts) {
    for (const m of months) {
      const [y, mo] = m.split('-').map(Number);
      await rollupMonthlyForAccount(account.id, new Date(Date.UTC(y, mo - 1, 1)));
    }
  }

  writeManifest(manifest);
  console.log(`\n${manifest.usageSnapshotIds.length} usage snapshots, ${manifest.fusionScoreIds.length} fusion scores,`);
  console.log(`${months.length} month(s) of rollups rebuilt.`);
  console.log(`\nManifest: prisma/.simulation-manifest.json — reset deletes exactly these rows.`);
}

const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL || 'http://127.0.0.1:8000';

/**
 * Every simulated day needs the Python service to score it, and the usage row is written
 * before the scoring is attempted. So if the service is down, the loop lays down a row per
 * missing day and then fails to score any of them — and on the next run those days are no
 * longer missing, so nothing ever goes back for them. The hole becomes permanent.
 *
 * Writing nothing is recoverable; writing unscoreable rows is not. Hence one probe up
 * front, and no work at all if it fails.
 */
async function modelServiceUp(): Promise<boolean> {
  try {
    const r = await fetch(`${MODEL_SERVICE_URL}/health`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

export interface GapFillResult {
  days: number;
  scored: number;
  /** Set when the pass declined to run at all, with the reason. */
  skipped?: string;
}

/**
 * Fills every missing day between each account's newest reading and today, scoring each.
 *
 * The backfill anchors to the seeded snapshot's own date so it does not overwrite the
 * present, which leaves a hole between that date and now. This closes it, and doubles as
 * the repair for any stretch where the machine was simply off — without it those days stay
 * permanently blank and the trend chart has a break in the middle.
 *
 * This is what runs on a schedule. An earlier version advanced exactly one day, which
 * meant a laptop that had been shut for a week came back and wrote only today, leaving the
 * six days behind it blank forever.
 */
export async function fillUsageGaps(log = false): Promise<GapFillResult> {
  const say = (line: string) => { if (log) console.log(line); };

  if (!await modelServiceUp()) {
    return { days: 0, scored: 0, skipped: `model service unreachable at ${MODEL_SERVICE_URL}` };
  }

  const accounts = await loadAccounts();
  const today = dateOnlyUTC();
  const manifest = readManifest() ?? emptyManifest();

  let totalDays = 0, totalScored = 0;
  say('');

  for (const account of accounts) {
    const current = account.usageSnapshots[0];
    if (!current) continue;

    const from = dateOnlyUTC(current.capturedAt);
    const missing = Math.round((today.getTime() - from.getTime()) / 86400000);
    if (missing <= 0) { say(`  ${account.name.padEnd(26)} already current`); continue; }

    const trajectory = fitTrajectory(current);
    const rand = rng(account.id + 'catchup');
    const base: Reading = {
      accountAgeDays: current.accountAgeDays,
      dailyUsageMins: current.dailyUsageMins,
      supportTickets90Days: current.supportTickets90Days,
      apiUtilizationRate: current.apiUtilizationRate,
      loginFrequencyBucket: current.loginFrequencyBucket,
    };

    let scored = 0;
    let last = base;
    for (let d = 1; d <= missing; d++) {
      const date = new Date(from.getTime() + d * 86400000);
      // Negative daysAgo walks the trajectory FORWARD from the anchor rather than back.
      const reading = readingFor(base, trajectory, -d, 180, rand);
      last = reading;

      const snap = await prisma.usageSnapshot.create({
        data: { accountId: account.id, capturedAt: date, ...reading },
      });
      manifest.usageSnapshotIds.push(snap.id);

      // Days that already carry a real score are left alone — those rows are not ours.
      const existing = await prisma.fusionScore.findUnique({
        where: { accountId_snapshotDate: { accountId: account.id, snapshotDate: date } },
      });
      if (existing) continue;

      try {
        const { churnData, sentData, fusionData, churnFeatures } =
          await computeRealFusion(account.id, undefined, reading);
        const churn = await prisma.churnPrediction.create({
          data: { accountId: account.id, predictedAt: date, churnProba: churnData.churn_proba,
                  riskBand: RISK_BAND_ENUM[churnData.risk_band] },
        });
        manifest.churnPredictionIds.push(churn.id);

        // SHAP for the NEWEST day only. Historical days genuinely do not need it — nothing
        // displays them — but the newest row is the one the account page reads, and this
        // pass writing a fusion score for that day makes runDailySnapshotForToday skip the
        // account entirely. So if the factors are not generated here, nothing generates
        // them: the account page received no shapFactors at all and the SHAP tab took the
        // whole app down with it.
        //
        // Not tracked by id in the manifest: reset deletes SHAP rows by their parent
        // churn prediction, which is already recorded, and that also catches any written
        // against our predictions by another code path.
        if (d === missing) {
          try {
            await saveShapExplanations(churn.id, churnFeatures);
          } catch (shapErr: any) {
            console.warn(`    SHAP failed for ${account.name}: ${shapErr.message || shapErr}`);
          }
        }

        const sent = await prisma.sentimentPrediction.create({
          data: { reviewId: account.customerReviews[0]?.id, predictedAt: date,
                  classification: sentData.classification, riskWeight: sentData.risk_weight },
        });
        manifest.sentimentPredictionIds.push(sent.id);
        const fs_ = await prisma.fusionScore.create({
          data: { accountId: account.id, snapshotDate: date,
                  churnPredictionId: churn.id, sentimentPredictionId: sent.id,
                  fusionScore: Math.round(fusionData.fusion_proba * 100),
                  riskCategory: fusionRiskCategory(fusionData.fusion_proba) },
        });
        manifest.fusionScoreIds.push(fs_.id);
        manifest.monthsTouched.push(date.toISOString().slice(0, 7));
        scored++;
      } catch (err: any) {
        console.warn(`    ${date.toISOString().slice(0, 10)}: ${err.message || err}`);
      }
    }

    totalDays += missing; totalScored += scored;
    say(`  ${account.name.padEnd(26)} +${String(missing).padStart(2)} day(s)  ` +
        `usage ${String(base.dailyUsageMins).padStart(3)} -> ${String(last.dailyUsageMins).padStart(3)} min   ${scored} scored`);
  }

  if (totalDays === 0) return { days: 0, scored: 0 };

  for (const account of accounts) {
    for (const m of [...new Set(manifest.monthsTouched)]) {
      const [y, mo] = m.split('-').map(Number);
      await rollupMonthlyForAccount(account.id, new Date(Date.UTC(y, mo - 1, 1)));
    }
  }

  writeManifest(manifest);
  say(`\n${totalDays} day(s) filled, ${totalScored} scored. History is now continuous to today.`);
  return { days: totalDays, scored: totalScored };
}

async function reset() {
  const m = readManifest();
  if (!m) { console.log('No manifest — nothing to reset.'); return; }

  // Deletes EXACTLY the ids this script created. The database also holds real usage
  // snapshots and real fusion scores; a reset that removed "everything recent" would take
  // those too, and they are not reproducible.
  const f = await prisma.fusionScore.deleteMany({ where: { id: { in: m.fusionScoreIds } } });
  // SHAP rows hang off a churn prediction with no cascade, so they have to go first or the
  // prediction delete fails on a foreign key and reset silently stops half-done.
  const x = await prisma.shapExplanation.deleteMany({
    where: { churnPredictionId: { in: m.churnPredictionIds } },
  });
  const c = await prisma.churnPrediction.deleteMany({ where: { id: { in: m.churnPredictionIds } } });
  const s = await prisma.sentimentPrediction.deleteMany({ where: { id: { in: m.sentimentPredictionIds } } });
  const u = await prisma.usageSnapshot.deleteMany({ where: { id: { in: m.usageSnapshotIds } } });

  const accounts = await prisma.account.findMany({ select: { id: true } });
  for (const a of accounts) {
    for (const month of [...new Set(m.monthsTouched)]) {
      const [y, mo] = month.split('-').map(Number);
      const monthStart = new Date(Date.UTC(y, mo - 1, 1));
      const rebuilt = await rollupMonthlyForAccount(a.id, monthStart);
      // No scores left in that month once the simulated ones are gone: drop the summary
      // rather than leave an average of nothing behind it.
      if (!rebuilt) {
        await prisma.fusionMonthlySummary.deleteMany({ where: { accountId: a.id, monthStart } });
      }
    }
  }

  fs.unlinkSync(MANIFEST);
  console.log(`Removed ${u.count} usage snapshots, ${f.count} fusion scores, ${c.count} churn + ${s.count} sentiment predictions, ${x.count} SHAP rows.`);
  console.log(`Now: ${await prisma.usageSnapshot.count()} usage snapshots, ${await prisma.fusionScore.count()} fusion scores, ${await prisma.fusionMonthlySummary.count()} monthly summaries.`);
}

// Only dispatch when run directly. server.ts imports simulateOneDay from this file for
// the SIMULATE_USAGE hook, and without this guard that import would execute the CLI —
// printing usage text on boot and disconnecting the shared Prisma client out from under
// the server.
const isDirectRun = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (isDirectRun) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'status') await status();
  else if (cmd === 'backfill') await backfill(Number(arg) || 180);
  // `daily` is the same operation as `catchup`: advancing to today IS filling the gap when
  // the gap happens to be one day. Two commands that differed only in how many missed days
  // they repaired was a trap, because the one named for daily use was the one that left
  // holes behind.
  else if (cmd === 'catchup' || cmd === 'daily') {
    const r = await fillUsageGaps(true);
    if (r.skipped) console.log(`Skipped — ${r.skipped}. Start model_service and run this again.`);
    else if (r.days === 0) console.log('Every account is already current. Nothing to fill.');
  }
  else if (cmd === 'reset') await reset();
  else console.log('Usage: npx tsx prisma/simulate-usage.ts <status|backfill [days]|catchup|daily|reset>');

  await prisma.$disconnect();
}
