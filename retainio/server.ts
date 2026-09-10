import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import cookieParser from 'cookie-parser';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { tool } from '@langchain/core/tools';
import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { searchHistoricalCases } from './ragSearch';
import { searchDocuments } from './docsSearch';
import { findSimilarCases } from './knowledgeGraph';
import type { Account } from './src/types';
import { prisma } from './db';
import {
  MONTHS_PER_TERM, describeDiscount, givebackValue, needsDirectorApproval,
  selfApprovalCap, discountedTermValue, formatMoney, annualContractValue,
  discountStatus, describeDiscountStatus, blocksNewOffer, TIER_MONTHLY_RATE, addMonths,
  OFFER_WINDOW_DAYS, daysUntil, daysAgo, formatTermDate, tierMoves,
} from './pricing';
import {
  computeRealFusion, runDailySnapshotForToday, loadModelFeatures, fusionRiskCategory,
  deriveDominantDriver, classifyReviewCategory, rescoreAccountToday,
  SENTIMENT_RISK_WEIGHT, captureIndexSnapshot, captureDueIndexSnapshots, dateOnlyUTC,
  type SentimentClassValue,
} from './fusionSnapshot';
import { runRenewalsForToday, isRetained } from './renewals';
import { ingestInbox, mailIngestConfigured } from './mailIngest';

dotenv.config();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Render (and most hosts) assign the port through the environment and expect the app to
// bind to it — a hardcoded 3000 would fail health checks there. Falls back to 3000 locally.
const PORT = Number(process.env.PORT) || 3000;
const MODEL_SERVICE_URL = process.env.MODEL_SERVICE_URL || 'http://127.0.0.1:8000';

// -------------------------------------------------------------
// Authentication — real password check + sessions, replacing LoginPage.tsx's
// old "pick a name from a dropdown" flow. Sessions are opaque random tokens
// in an httpOnly cookie; only a SHA-256 hash of the token is stored in
// sessions.token_hash, so a database leak alone doesn't hand out valid
// sessions. Every endpoint below that used to trust a client-supplied
// requestedById/approvedById/approverId now derives that identity from the
// session instead — the previous version would let anyone POST any user id
// into the request body and have it recorded as if they were that person.
// -------------------------------------------------------------

const SESSION_COOKIE = 'retainio_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Deletes sessions whose expiry has passed. requireAuth already refuses them,
// so this is housekeeping rather than a security fix — without it the table
// grows forever, since nothing else ever removes a session that simply aged
// out (as opposed to being logged out).
async function pruneExpiredSessions(): Promise<number> {
  const { count } = await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}

async function createSession(userId: string, rememberDevice: boolean) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + (rememberDevice ? REMEMBER_TTL_MS : SESSION_TTL_MS));

  // One active session per user. Signing in again previously left the old row
  // valid but unreachable — the browser overwrote its cookie, so nothing could
  // ever log that session out and it stayed usable until it expired. Replacing
  // them means "signing in here signs you out elsewhere", which is a
  // deliberate trade of multi-device convenience for no orphaned sessions.
  await prisma.session.deleteMany({ where: { userId } });

  await prisma.session.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      rememberDevice,
    },
  });
  return { token, expiresAt };
}

// Attaches req.userId/req.user when a valid, non-expired session cookie is
// present; otherwise responds 401 and stops the request here. Any route
// that reads or writes account/discount/audit data goes through this.
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return res.status(401).json({ error: 'Not signed in.' });

    const session = await prisma.session.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date()) {
      res.clearCookie(SESSION_COOKIE);
      return res.status(401).json({ error: 'Session expired — please sign in again.' });
    }

    // Deactivation clears sessions, so this is a backstop rather than the
    // main path — but it means access dies with the flag even if a session
    // were created another way, instead of surviving until it expires.
    if (!session.user.isActive) {
      await prisma.session.deleteMany({ where: { userId: session.userId } });
      res.clearCookie(SESSION_COOKIE);
      return res.status(403).json({ error: 'This account has been deactivated. Contact your administrator.' });
    }

    (req as any).userId = session.userId;
    (req as any).user = session.user;
    next();
  } catch (error: any) {
    console.error('Error in requireAuth:', error);
    res.status(500).json({ error: 'Authentication check failed.' });
  }
}

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, rememberDevice } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const user = await prisma.user.findUnique({ where: { email } });
    // Compare against a dummy hash when the user doesn't exist, so a bad
    // email and a bad password take the same amount of time to reject —
    // otherwise the response time itself leaks which emails are real.
    const hashToCheck = user?.passwordHash ?? '$2b$12$oX02Wz3av2gOT5n7cKXgV.KPCXfTJUve932k5BPELcQ00/GGn.dIi';
    const passwordMatches = await bcrypt.compare(password, hashToCheck);

    if (!user || !passwordMatches) {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    // The system actor exists only to be named in audit rows. It has no password hash,
    // so this is unreachable in practice — but the guarantee that it cannot hold a
    // session should not rest on a null column staying null.
    if (user.role === 'system') {
      return res.status(401).json({ error: 'Incorrect email or password.' });
    }

    // Checked after the password so a deactivated account can't be told apart
    // from a wrong password by anyone who doesn't already know the password.
    if (!user.isActive) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact your administrator.' });
    }

    const { token, expiresAt } = await createSession(user.id, Boolean(rememberDevice));
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      expires: expiresAt,
    });
    res.json({ user: mapUser(user) });
  } catch (error: any) {
    console.error('Error in POST /api/auth/login:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// Self-registration. Account Managers and Directors sign up through the same
// form; the only difference is that a Director must also enrol their face,
// since they're the role whose approvals are gated on a biometric check.
//
// A brand-new user manages no accounts — accounts are assigned separately —
// so their dashboard legitimately comes back empty until someone gives them
// one. That's an expected state, not an error.
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, role, title, department, rememberDevice } = req.body;

    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    // Only Directors self-register. Account Manager logins are created by an
    // admin (POST /api/admin/users), because a Manager's account is only
    // meaningful once someone has assigned them a Director and accounts —
    // and admins are never self-served at all.
    if (role !== 'account_director') {
      return res.status(403).json({
        error: 'Only Account Directors can self-register. Ask an administrator to create your account.',
      });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash: await bcrypt.hash(password, 12),
        role: 'account_director',
        title: title?.trim() || 'Account Director',
        department: department?.trim() || 'Customer Success',
        // Unique per row and human-readable; the seeded users use the same shape.
        employeeId: `DIR-${Date.now().toString().slice(-6)}`,
        maxSelfApprovalLimit: 30,
        avatarInitials: initialsFor(name),
      },
    });

    // Honours the same "remember this device" choice as login — signup used to
    // hardcode false, so a Director who ticked the box still got 12 hours.
    const { token, expiresAt } = await createSession(user.id, Boolean(rememberDevice));
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      expires: expiresAt,
    });
    // A Director without an enrolled face can't approve anything (see
    // /api/face-verify), so the client runs the camera step before finishing.
    res.json({ user: mapUser(user), faceEnrollmentRequired: true });
  } catch (error: any) {
    console.error('Error in POST /api/auth/signup:', error);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

// Face enrolment for the signed-in user. Called during signup (Directors) and
// re-callable to add more samples, which improves match reliability.
app.post('/api/auth/enroll-face', requireAuth, async (req, res) => {
  try {
    const user = (req as any).user;
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'No image received.' });

    const result = await embedFace(imageBase64);
    if (result.status === 'bridge-down') {
      return res.status(502).json({ error: 'Face service is offline — start model_service and try again.' });
    }
    if (result.status === 'rejected') return res.status(400).json({ error: result.error });

    // The embedding is persisted, not the photo — see the FaceSample model.
    await prisma.faceSample.create({ data: { userId: user.id, embedding: result.embedding } });
    await prisma.user.update({ where: { id: user.id }, data: { faceEnrolledAt: new Date() } });

    const samples = await prisma.faceSample.count({ where: { userId: user.id } });
    res.json({ ok: true, samples });
  } catch (error: any) {
    console.error('Error in POST /api/auth/enroll-face:', error);
    res.status(500).json({ error: 'Face enrolment failed.' });
  }
});

// Gate for every route that changes org structure. Runs after requireAuth,
// so req.user is already the session's user — the role is never taken from
// the request body.
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access required.' });
  }
  next();
}

function initialsFor(name: string): string {
  return name.trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'NA';
}

// Admin: create an Account Manager login. Managers can't self-register, so
// this is the only way one comes into existence. directorId is optional here
// — an unassigned Manager is a valid, if idle, state.
app.post('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, title, department, directorId } = req.body;
    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Name, email and password are required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (await prisma.user.findUnique({ where: { email: normalizedEmail } })) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    if (directorId) {
      const director = await prisma.user.findUnique({ where: { id: directorId } });
      if (!director || director.role !== 'account_director' || !director.isActive) {
        return res.status(400).json({ error: 'That director does not exist or is deactivated.' });
      }
    }

    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        passwordHash: await bcrypt.hash(password, 12),
        role: 'account_manager',
        title: title?.trim() || 'Account Manager',
        department: department?.trim() || 'Customer Success',
        employeeId: `EMP-${Date.now().toString().slice(-6)}`,
        maxSelfApprovalLimit: 10,
        // Managers escalate above 10% rather than approving biometrically,
        avatarInitials: initialsFor(name),
        directorId: directorId || null,
      },
    });
    res.json({ user: mapUser(user) });
  } catch (error: any) {
    console.error('Error in POST /api/admin/users:', error);
    res.status(500).json({ error: 'Could not create the account manager.' });
  }
});

// Admin: set (or clear, with null) which Director a Manager reports to.
// This is what actually determines a Director's dashboard contents.
app.patch('/api/admin/users/:id/director', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { directorId } = req.body;

    const manager = await prisma.user.findUnique({ where: { id } });
    if (!manager) return res.status(404).json({ error: 'User not found.' });
    if (manager.role !== 'account_manager') {
      return res.status(400).json({ error: 'Only Account Managers report to a Director.' });
    }

    if (directorId) {
      const director = await prisma.user.findUnique({ where: { id: directorId } });
      if (!director || director.role !== 'account_director' || !director.isActive) {
        return res.status(400).json({ error: 'That director does not exist or is deactivated.' });
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { directorId: directorId || null },
      include: { director: true },
    });
    res.json({ user: mapUser(updated) });
  } catch (error: any) {
    console.error('Error in PATCH /api/admin/users/:id/director:', error);
    res.status(500).json({ error: 'Could not update the reporting line.' });
  }
});

// Admin: reassign a customer account to a different Account Manager. This is
// what lets a newly created Manager stop showing "No accounts assigned".
app.patch('/api/admin/accounts/:id/manager', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { accountManagerId } = req.body;

    const manager = await prisma.user.findUnique({ where: { id: accountManagerId } });
    if (!manager || manager.role !== 'account_manager' || !manager.isActive) {
      return res.status(400).json({ error: 'Accounts can only be assigned to an active Account Manager.' });
    }
    if (!(await prisma.account.findUnique({ where: { id } }))) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    await prisma.account.update({ where: { id }, data: { accountManagerId } });
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error in PATCH /api/admin/accounts/:id/manager:', error);
    res.status(500).json({ error: 'Could not reassign the account.' });
  }
});

// Admin: revoke or restore a login without touching history. This is the
// normal way to remove someone's access — DELETE below only works for a user
// who has never done anything, because deleting one who has would either
// break a foreign key or erase the audit entries that name them.
app.patch('/api/admin/users/:id/active', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be true or false.' });
    }
    if (id === (req as any).user.id && !isActive) {
      return res.status(400).json({ error: 'You cannot deactivate your own administrator account.' });
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive, deactivatedAt: isActive ? null : new Date() },
      include: { director: true },
    });

    // Deactivating has to take effect now, not whenever their cookie happens
    // to expire — otherwise a revoked user keeps working for up to 30 days.
    if (!isActive) {
      await prisma.session.deleteMany({ where: { userId: id } });
    }

    res.json({ user: mapUser(updated) });
  } catch (error: any) {
    console.error('Error in PATCH /api/admin/users/:id/active:', error);
    res.status(500).json({ error: 'Could not update the account status.' });
  }
});


app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } }).catch(() => {});
    }
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error in POST /api/auth/logout:', error);
    res.status(500).json({ error: 'Logout failed.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  res.json({ user: mapUser((req as any).user) });
});
// Cosine distance below which two face embeddings are considered the same
// person — lower is more similar. This is the value the original recognizer
// used; model_service only produces vectors now, so the decision lives here.
const FACE_MATCH_THRESHOLD = 0.4;

// Turns a browser image into a 512-d FaceNet vector via model_service. The
// bridgeDown case is distinguished from a normal failure because a face gate
// must fail CLOSED when its backend is unreachable, not fall through.
type EmbedResult =
  | { status: 'ok'; embedding: number[] }
  | { status: 'rejected'; error: string }
  | { status: 'bridge-down' };

async function embedFace(imageBase64: string): Promise<EmbedResult> {
  try {
    const r = await fetch(`${MODEL_SERVICE_URL}/face/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageBase64 }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) return { status: 'rejected', error: data.error || 'Face processing failed.' };
    return { status: 'ok', embedding: data.embedding };
  } catch (bridgeError) {
    console.error('Face engine unreachable:', bridgeError);
    return { status: 'bridge-down' };
  }
}

// scipy.spatial.distance.cosine, which is what keras_facenet's
// compute_distance uses (its distance_metric is "cosine"): 1 - similarity.
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 1 : 1 - dot / denom;
}

// Maps an Account (retainio's display/demo data) to the exact raw feature schema
// churn_model.ipynb's pipeline expects. Login_Frequency/Plan_Tier vocab confirmed directly
// against the training data: Login_Frequency in {Daily, Weekly, Rarely}, Plan_Tier in
// {Enterprise, Pro, Basic} (OneHotEncoder has handle_unknown='ignore', so an unmapped Plan_Tier
// value degrades gracefully rather than erroring).
// The six churn-model features, read from the account's own rows.
//
// This used to take whatever `contextAccount` the browser posted and fall back
// to placeholder values for anything missing (365 days, 30 minutes, 0 tickets,
// a 0.5 utilisation rate). A request carrying only an id and a name therefore
// produced a confident, entirely fictional prediction: CloudPulse - a real
// 92/100 High Risk account - was reported by the advisor as "16.2% churn risk,
// classified as Low Risk", because the model scored the placeholders.
//
// The numbers the advisor states have to come from the same place the
// dashboard's do, so they are loaded here rather than accepted from the client.
// Mirrors computeUpliftForAccount, which already worked this way.
// The account profile the knowledge graph matches on: industry, the SHAP
// factors that raised its risk, and the review text. Read here for the same
// reason loadModelFeatures does - these were taken from the request body, so a
// thin or stale payload quietly produced a wrong precedent, or none at all.
async function loadGraphProfile(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      customerReviews: { orderBy: { submittedAt: 'desc' }, take: 1 },
      fusionScores: {
        orderBy: { snapshotDate: 'desc' },
        take: 1,
        include: { churnPrediction: { include: { shapExplanations: true } } },
      },
    },
  });
  if (!account) return null;

  const shapFactors = (account.fusionScores[0]?.churnPrediction?.shapExplanations ?? [])
    .filter(f => f.direction === 'risk_increase')
    .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
    .slice(0, 5)
    .map(f => ({ feature: f.featureName, description: f.description, direction: f.direction, impact: f.impact }));

  return {
    industry: account.industry,
    shapFactors: shapFactors as any,
    reviewText: account.customerReviews[0]?.reviewText,
  };
}


// An account's current offer and where it is in its life, read from our own records.
// Used by the advisor prompt and by mapAccount's callers rather than trusting a
// client-supplied account object, which is what the browser happens to hold.
async function loadDiscountState(accountId: string) {
  const [sub, lastApplied] = await Promise.all([
    prisma.subscription.findFirst({ where: { accountId }, orderBy: { termStart: 'desc' } }),
    prisma.auditLog.findFirst({
      where: { accountId, discountApplied: { gt: 0 } },
      orderBy: { createdAt: 'desc' },
    }),
  ]);
  const listMrr = sub ? Number(sub.mrr) : 0;
  const pct = lastApplied?.discountApplied ?? 0;
  const months = lastApplied?.discountMonths ?? 0;
  return {
    pct, months, listMrr,
    renewalDate: sub?.termEnd ?? null,
    status: discountStatus(listMrr, pct, months, lastApplied?.discountStartsAt),
  };
}


const TOOL_DISPLAY_NAMES: Record<string, string> = {
  get_risk_analysis: 'Risk Analysis Engine',
  get_shap_explanation: 'SHAP Explanation Engine',
  search_historical_cases: 'Historical Case RAG',
  search_knowledge_graph: 'Knowledge Graph Search',
  search_documents: 'RAG Documents',
  get_uplift_recommendation: 'Uplift Model (Discount Optimiser)',
  propose_retention_offer: 'Retention Offer Card',
};

// Initialize Google GenAI
const getGenAI = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY is not defined in environment variables. Falling back to local intelligence.');
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build'
      }
    }
  });
};

// -------------------------------------------------------------
// 1. AI Retention Advisor Chat (LangGraph + Gemini Agent with Specialist Tool Calls)
// -------------------------------------------------------------
// Per-user throttle on the agent endpoint. Every advisor question can fan out
// into several Gemini calls (one per tool the agent picks, plus the answer), so
// an unthrottled endpoint lets one signed-in session drive unbounded spend.
// Deliberately in-memory and dependency-free: a single server process, and a
// limit that resets on restart is the right trade for this.
// How many prior turns of a thread the agent is given. Enough for follow-ups
// ("what about a bigger discount?") without resending a long transcript.
const HISTORY_TURN_LIMIT = 10;

const ADVISOR_WINDOW_MS = 60_000;
const ADVISOR_MAX_PER_WINDOW = 12;
const advisorHits = new Map<string, number[]>();

function advisorRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = (req as any).userId as string;
  const now = Date.now();
  const recent = (advisorHits.get(userId) ?? []).filter(t => now - t < ADVISOR_WINDOW_MS);

  if (recent.length >= ADVISOR_MAX_PER_WINDOW) {
    const retryInSec = Math.ceil((ADVISOR_WINDOW_MS - (now - recent[0])) / 1000);
    return res.status(429).json({
      text: `You are sending questions faster than the advisor can answer them. Try again in ${retryInSec}s.`,
      toolCalls: [],
      actionCard: null,
    });
  }

  recent.push(now);
  advisorHits.set(userId, recent);
  next();
}

// Checks that every figure the agent quotes traces back to something a tool
// actually returned this turn.
//
// The agent is instructed to ground its answers, but instructions are not
// enforcement, and this project has twice shipped confident invented numbers:
// the seeded ai_explanations claimed "68% risk" for an account the model scored
// 17, and the advisor's own error path used to report a hardcoded "85% risk
// profile". Removing those sources was the real fix; this is the check that
// notices if it happens again.
//
// Deliberately conservative. It compares against the concatenated tool output
// with a small numeric tolerance, so a rounded restatement ("99%" for a tool's
// "99.0%") counts as grounded. Under-flagging is the right failure mode - a
// warning that cries wolf gets ignored.
function findUngroundedFigures(answer: string, groundTruth: string[]): string[] {
  // Thousands separators have to be part of the token. Matching bare \d+ split
  // "$1,200" into "1" and "200", and the orphaned "200" then matched nothing and was
  // reported as an invented figure - so every correct money value above $999 raised a
  // false alarm. A guard that cries wolf on correct answers is worse than no guard.
  const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
  const parse = (t: string) => Number(t.replace(/,/g, ''));

  const haystack = groundTruth.join(' ');
  const haystackNumbers = (haystack.match(NUMBER) ?? []).map(parse);

  const quoted = answer.match(NUMBER) ?? [];
  const ungrounded = quoted.filter(token => {
    if (haystack.includes(token)) return false;
    const value = parse(token);
    // A bare 1-2 digit number is usually prose ("2 years", "3 tickets") rather
    // than a claimed metric; requiring an exact-or-near match on those produces
    // noise, so only figures with real precision are checked strictly.
    if (value < 10 && !token.includes('.')) return false;
    return !haystackNumbers.some(h => Math.abs(h - value) < 0.5);
  });

  return [...new Set(ungrounded)];
}

// Loads a thread so the chat can be restored instead of restarting empty every
// time the component unmounts.
app.get('/api/accounts/:id/conversation', requireAuth, async (req, res) => {
  try {
    const conversation = await prisma.conversation.findUnique({
      where: { userId_accountId: { userId: (req as any).userId as string, accountId: req.params.id } },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    res.json({
      messages: (conversation?.messages ?? []).map(m => ({
        id: m.id,
        sender: m.sender,
        text: m.text,
        timestamp: m.createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        toolCalls: m.toolCalls ?? undefined,
        actionCard: m.actionCard ?? undefined,
        ungroundedFigures: m.ungroundedFigures,
      })),
    });
  } catch (error: any) {
    console.error('Error in GET /api/accounts/:id/conversation:', error);
    res.status(500).json({ error: 'Could not load the conversation.' });
  }
});

app.post('/api/gemini/advisor-chat', requireAuth, advisorRateLimit, async (req, res) => {
  try {
    const { userMessage, contextAccount, messageHistory } = req.body;
    const ai = getGenAI();

    const toolLogs: any[] = [];
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const accountName = contextAccount?.name || 'Selected Account';
    const sentiment = contextAccount?.sentimentClassification || 'unknown';

    // Read from our records, not from contextAccount — the advisor's recommendation
    // depends on it, and the client's copy is whatever the browser happens to hold.
    // Stating the state (and its dates) also stops the agent describing an approved
    // discount as though the customer were already paying less.
    const existingOffer = contextAccount?.id ? await loadDiscountState(contextAccount.id) : null;
    const existingOfferLine = existingOffer && existingOffer.status.state !== 'none'
      ? ` Existing offer: ${describeDiscountStatus(existingOffer.pct, existingOffer.months, existingOffer.status)}.`
      : '';

    // Whether this account can be offered anything at all. Without it the advisor will
    // happily recommend a percentage for an account the server would refuse, which reads
    // to the Manager as the assistant and the app disagreeing.
    const daysToRenewal = existingOffer?.renewalDate ? daysUntil(existingOffer.renewalDate) : null;
    const offerWindowLine = daysToRenewal !== null && daysToRenewal > OFFER_WINDOW_DAYS
      ? ` RETENTION OFFERS ARE NOT OPEN for this account: it renews in ${daysToRenewal} days, and ` +
        `DISCOUNTS open ${OFFER_WINDOW_DAYS} days before renewal. Do not recommend a discount ` +
        `percentage. A PRODUCT WALKTHROUGH is still available and costs nothing — recommend ` +
        `that instead where it fits, and say when the discount window opens.`
      : '';

    // One thread per (user, account). Created on first question.
    const accountId: string | undefined = contextAccount?.id;
    if (!accountId) return res.status(400).json({ error: 'No account selected.' });

    const conversation = await prisma.conversation.upsert({
      where: { userId_accountId: { userId: (req as any).userId as string, accountId } },
      create: { userId: (req as any).userId as string, accountId },
      update: {},
    });

    // No API key means no agent. Saying so is better than the previous
    // fallback, which replied with invented figures ("85% risk profile",
    // "60% drop in login frequency", "88% probability of securing a renewal")
    // that were never computed from anything.
    if (!ai) {
      return res.json({
        text: 'The AI Retention Advisor is not configured - GEMINI_API_KEY is missing, so I cannot analyse this account right now.',
        toolCalls: [],
        actionCard: null,
      });
    }

    // Set by the propose_retention_offer tool when the agent decides an offer
    // is worth surfacing. Intent used to be guessed with regex over the user's
    // message - any number between 11 and 100 was read as a discount request,
    // so "we have 50 seats" asked for 50% off. The agent decides now.
    let actionCard: any = null;
    let textResponse = '';

    // Real LangGraph agent: seven independent tools, Gemini decides which (if
    // any) are actually relevant per question via real function-calling - not a
    // fixed list run on every message. Three of them (risk / SHAP / uplift) call
    // the real trained models through the Python bridge (model_service/app.py).
      const riskAnalysisTool = tool(
        async () => {
          const features = await loadModelFeatures(accountId);
          if (!features) return 'This account has no usage snapshot or subscription on record, so the churn model cannot be run for it.';
          try {
            const r = await fetch(`${MODEL_SERVICE_URL}/predict/churn`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(features)
            });
            if (!r.ok) throw new Error(`bridge status ${r.status}`);
            const data = await r.json();
            return `Real trained-model prediction: churn probability ${(data.churn_proba * 100).toFixed(1)}% (${data.risk_band}), decision threshold ${data.threshold}.`;
          } catch {
            // Say the tool failed. Substituting a cached number here would be
            // reported by the agent as a live model reading.
            return 'The churn model service is unreachable, so no live risk score is available for this account.';
          }
        },
        {
          name: 'get_risk_analysis',
          description: "Get this account's live churn risk score from the trained churn prediction model.",
          schema: z.object({}),
        }
      );

      const shapTool = tool(
        async () => {
          const features = await loadModelFeatures(accountId);
          if (!features) return 'This account has no usage snapshot or subscription on record, so SHAP cannot be computed for it.';
          try {
            const r = await fetch(`${MODEL_SERVICE_URL}/explain/churn`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(features)
            });
            if (!r.ok) throw new Error(`bridge status ${r.status}`);
            const data = await r.json();
            // /explain/churn returns every scored feature (strongest first);
            // only the headline few are useful as chat context — the tail is
            // near-zero noise that would just dilute the prompt.
            const top = data.factors.slice(0, 5).map((f: any) => `${f.feature} (${f.direction === 'risk_increase' ? '+' : ''}${f.impact})`).join(', ');
            return `Real SHAP explanation (TreeExplainer) — top risk drivers: ${top}.`;
          } catch {
            return 'The SHAP explainer is unreachable, so no feature breakdown is available for this account.';
          }
        },
        {
          name: 'get_shap_explanation',
          description: "Explain WHY this account's risk score is what it is, feature by feature, using real SHAP values from the trained model.",
          schema: z.object({}),
        }
      );

      const historicalCaseTool = tool(
        async ({ query }: { query: string }) => {
          const [match] = await searchHistoricalCases(ai, query, 1);
          if (!match) return 'No closely matching historical case found by semantic search.';
          return `Most similar case by description: ${match.companyName} (${match.industry}) — issue: "${match.primaryIssue}", action: "${match.actionTaken}", outcome: ${match.outcome}. Learning: ${match.learnings}`;
        },
        {
          name: 'search_historical_cases',
          description: 'Semantically search past retention cases for one whose description sounds similar to a described situation or question.',
          schema: z.object({ query: z.string().describe('A description of the churn issue or question to search for') }),
        }
      );

      const knowledgeGraphTool = tool(
        async () => {
          const profile = await loadGraphProfile(accountId);
          if (!profile) return 'This account is not on record, so no structural comparison can be made.';
          const matches = await findSimilarCases(ai, profile, 1);
          if (matches.length === 0) return 'No structurally similar historical case found (no shared industry or risk factors with this account).';
          const m = matches[0];
          const shared = [...m.sharedConcepts, ...(m.industryMatch ? ['industry'] : [])];
          return `Most similar case by shared attributes [${shared.join(', ')}]: ${m.case.companyName} (${m.case.industry}) — action: "${m.case.actionTaken}", outcome: ${m.case.outcome}. Learning: ${m.case.learnings}`;
        },
        {
          name: 'search_knowledge_graph',
          description: "Find a historical case that shares real structure with THIS account (same industry, same underlying risk factors) even if it's worded completely differently — more reliable than semantic search for finding a genuinely comparable precedent for this specific account.",
          schema: z.object({}),
        }
      );

      const documentsTool = tool(
        async ({ query }: { query: string }) => {
          const docs = await searchDocuments(ai, query, 2);
          if (docs.length === 0) return 'No matching policy or FAQ document found.';
          return docs.map(d => `[${d.source} — ${d.heading}]: ${d.text.replace(/\n+/g, ' ')}`).join('\n');
        },
        {
          name: 'search_documents',
          description: 'Search RetainIO policy documents and product FAQ for retention rules, discount policy, or product/technical guidance.',
          schema: z.object({ query: z.string() }),
        }
      );

      // The uplift model was the one trained model the chatbot could not reach,
      // so it recommended a flat 10% no matter what the model said.
      const upliftTool = tool(
        async () => {
          if (!contextAccount?.id) return 'No account is selected, so the uplift model cannot be run.';
          try {
            const u = await computeUpliftForAccount(contextAccount.id);
            // Only the strongest few options — the full 12-cell grid in a tool result
            // is more noise than the agent can use, and it has to fit in the answer.
            const top = [...u.grid]
              .sort((a: any, b: any) => b.cate - a.cate)
              .slice(0, 4)
              .map((g: any) => `${g.discount_pct}% for ${g.discount_months} months: ${(g.cate * 100).toFixed(1)}pp`)
              .join('; ');
            const termValue = discountedTermValue(u.mrr, u.best_pct, u.best_months);
            // The term value and giveback are stated here so the grounding check has a
            // source for any figure the agent repeats — findUngroundedFigures compares
            // the answer against tool output, and would otherwise flag correct numbers.
            return `Real uplift model for ${u.account_name}: baseline retention with no discount ${(u.baseline_retention * 100).toFixed(1)}%. Best offer is ${u.best_pct}% for ${u.best_months} months, worth +${(u.best_cate * 100).toFixed(1)}pp. Next best - ${top}. That offer gives away ${formatMoney(givebackValue(u.mrr, u.best_pct, u.best_months))} of a ${formatMoney(annualContractValue(u.mrr))} annual contract, leaving a term value of ${formatMoney(termValue)}. An Account Manager may approve up to ${formatMoney(selfApprovalCap(u.mrr))} of give-away on this account. The review reads as a ${u.review_category} issue.`;
          } catch (err: any) {
            return `The uplift model could not be run for this account: ${err.message}`;
          }
        },
        {
          name: 'get_uplift_recommendation',
          description: "Ask the trained uplift model which discount offer - both a percentage (5, 10, 15 or 20%) AND a duration (3, 6 or 12 months) - would most improve this account's chance of renewing, and by how much. Use this before naming any specific discount.",
          schema: z.object({}),
        }
      );

      // Surfacing the card is an explicit agent decision now, and it carries
      // whatever percentage the agent asks for rather than a hardcoded 10.
      const proposeOfferTool = tool(
        async ({ discountPct }: { discountPct: number }) => {
          const pct = Math.round(discountPct);
          actionCard = {
            type: 'recommendation',
            discountPct: pct,
            accountId: contextAccount?.id ?? null,
            accountName,
            status: 'pending',
          };
          return `A retention offer card for ${pct}% is now shown to the Account Manager. It links to the Retention Offer tab and applies nothing by itself.`;
        },
        {
          name: 'propose_retention_offer',
          description: 'Show the Account Manager a card linking to the Retention Offer tab for a specific discount percentage. Call this once you have recommended a concrete percentage. Prefer the tier get_uplift_recommendation returned.',
          schema: z.object({ discountPct: z.number().describe('The discount percentage to propose, for example 10') }),
        }
      );

      const llm = new ChatGoogleGenerativeAI({ model: 'gemini-3.6-flash', apiKey: process.env.GEMINI_API_KEY });
      const agent = createReactAgent({
        llm,
        tools: [riskAnalysisTool, shapTool, upliftTool, historicalCaseTool, knowledgeGraphTool, documentsTool, proposeOfferTool],
      });

      const systemPrompt = `You are RetainIO's AI Retention Advisor, an agent built with LangGraph that reasons over specialist retention-analytics tools. You decide which tools (if any) are actually relevant to the Account Manager's question — do not call a tool just because it exists; a plain greeting needs no tools at all.

Current Account: ${accountName} (Sentiment: ${sentiment}).${existingOfferLine}${offerWindowLine} Assume the question is about this account unless stated otherwise.

SCOPE:
You only help with customer retention: churn risk and what drives it, account health, discounts and walkthroughs, past retention cases, and RetainIO's retention policy. Greetings and short pleasantries are fine to answer normally.
Anything else - general knowledge, current events, coding, cooking, personal advice - is outside what you do. Say so in one short sentence and offer what you can help with instead. Do not answer the question anyway, even if you know the answer and even if it seems harmless.

DISCOUNT POLICY:
You cannot apply, approve or action a discount yourself. The only thing you can do is recommend one and surface a card that links the Account Manager to the Retention Offer tab, where the real approval flow lives.
- Before naming any specific percentage, call get_uplift_recommendation and use the tier it returns rather than guessing a number.
- Every discount has a duration as well as a percentage - always state both, e.g. "10% for 5 months". A discount takes effect at the account's NEXT RENEWAL, not immediately, and runs for its months from there. Do not describe an approved discount as already reducing what the customer pays unless the account line above says it is active.
- If the account already has a discount scheduled or active, a second one cannot be stacked on top. Say so instead of recommending another.
- Retention offers only open in the final ${OFFER_WINDOW_DAYS} days before a renewal. If the account line above says the window is not open, do not name a percentage — say when it opens and offer what you can help with in the meantime.
- Approval depends on what an offer gives away, not its percentage: an Account Manager may approve up to 10% of annual contract value (monthly rate x percentage x months). Larger offers need Account Director sign-off. You may still recommend one, but say plainly it has to go through the Director via the Retention Offer tab.
- Once you have recommended a concrete percentage, call propose_retention_offer with it so the card appears.

Answer succinctly (2-4 sentences). When you use a tool's result, ground your answer in it concretely (cite the actual number, case, or policy line) rather than speaking generically.

Do not state any figure a tool has not given you. If you do not have a number, describe the situation in words instead of estimating one. Never invent counts, probabilities, durations or percentages to make an answer sound more concrete.`;

      // Rebuilt from our own records rather than trusting the client's
      // messageHistory. That payload was whatever the browser happened to hold,
      // which included a synthetic welcome message the agent was told it had
      // written, and grew without bound - the whole transcript was resent every
      // turn. Capped here now that the server owns it.
      const priorMessages = await prisma.conversationMessage.findMany({
        where: { conversationId: conversation.id, sender: { in: ['user', 'advisor'] } },
        orderBy: { createdAt: 'desc' },
        take: HISTORY_TURN_LIMIT * 2,
      });
      const historyMessages = priorMessages
        .reverse()
        .map(m => (m.sender === 'user' ? new HumanMessage(m.text) : new AIMessage(m.text)));

      // Streamed rather than awaited as a single blob. The agent can run
      // several tools per question, each a round trip to Gemini plus a model or
      // database call, and the whole run used to sit behind one static
      // "Analyzing telemetry..." spinner. Emitting each tool as it completes
      // shows the agent actually choosing and running tools, which is both
      // better feedback and the honest picture of what is happening.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const send = (event: string, payload: unknown) => {
        res.write(`event: ${event}
data: ${JSON.stringify(payload)}

`);
      };

      // Tool names live on the AI message that requested them; outputs arrive
      // later on a separate ToolMessage. The index carries names across chunks
      // so a result can be attributed when it lands.
      const toolCallIndex: Record<string, { name: string; args: any; startedAt: number }> = {};
      let lastText = '';

      const stream = await agent.stream(
        { messages: [new SystemMessage(systemPrompt), ...historyMessages, new HumanMessage(userMessage)] },
        { streamMode: 'updates' },
      );

      for await (const chunk of stream) {
        for (const nodeUpdate of Object.values(chunk as Record<string, any>)) {
          for (const m of nodeUpdate?.messages ?? []) {
            if (m.tool_calls?.length) {
              for (const c of m.tool_calls) {
                toolCallIndex[c.id] = { name: c.name, args: c.args, startedAt: Date.now() };
                send('tool_start', { toolName: TOOL_DISPLAY_NAMES[c.name] || c.name });
              }
            }

            if (m.constructor?.name === 'ToolMessage') {
              const callInfo = toolCallIndex[m.tool_call_id];
              const log = {
                toolName: TOOL_DISPLAY_NAMES[callInfo?.name] || callInfo?.name || 'Unknown Tool',
                args: callInfo?.args || {},
                output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
                timestamp,
                durationMs: callInfo ? Date.now() - callInfo.startedAt : undefined,
              };
              toolLogs.push(log);
              send('tool_end', log);
            } else if (typeof m.content === 'string' && m.content.trim()) {
              lastText = m.content;
            }
          }
        }
      }

      textResponse = lastText || 'I could not produce an answer for that - please try rephrasing the question.';

    // The system prompt counts as ground truth alongside the tool outputs: it
    // carries the 10% approval threshold, so an answer correctly quoting policy
    // must not be reported as an unverified figure.
    const ungroundedFigures = findUngroundedFigures(textResponse, [...toolLogs.map(t => t.output), systemPrompt]);
    if (ungroundedFigures.length) {
      console.warn(`Advisor answer quoted figures no tool produced: ${ungroundedFigures.join(', ')}`);
    }

    // Persisted after the run so a failed question doesn't leave a dangling
    // user turn the agent would later read back as context.
    await prisma.conversationMessage.createMany({
      data: [
        { conversationId: conversation.id, sender: 'user', text: userMessage },
        { conversationId: conversation.id, sender: 'advisor', text: textResponse, toolCalls: toolLogs, actionCard: actionCard ?? undefined, ungroundedFigures },
      ],
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });

    send('done', { text: textResponse, toolCalls: toolLogs, actionCard, ungroundedFigures });
    res.end();
  } catch (error: any) {
    console.error('Error in /api/gemini/advisor-chat:', error);
    // Previously this replied with a fabricated recommendation AND a fake tool
    // trace ("Risk Analysis Engine ... Fusion Risk Score: 85%") for a run that
    // never happened, so a failure was indistinguishable from real analysis.
    const message = 'Something went wrong while analysing this account, so I have no answer for you. Please try again.';

    // Once the stream has started the status line is already on the wire, so a
    // failure has to arrive as an event the client can act on rather than a
    // 500 body. Without this the connection would just close mid-run and the
    // UI would sit on the thinking state forever.
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ text: message })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ text: message, toolCalls: [], actionCard: null });
    }
  }
});

// -------------------------------------------------------------
// 3. Retention Email Generator (Gemini Powered)
// -------------------------------------------------------------

// -------------------------------------------------------------
// 3b. Retention Email Polisher (Gemini Powered) — rewrites an already-drafted email
// -------------------------------------------------------------
// Rewrites the wording of a retention offer email. The draft itself is built
// client-side from the account's real subscription, renewal date and the
// selected discount (DiscountEmailModal), and it stays that way deliberately:
// this email commits the company to a price in front of a customer, so its
// figures come from the database, not from a model. Gemini only improves prose.
app.post('/api/gemini/polish-email', requireAuth, async (req, res) => {
  const { subject, body, accountName, discountPct } = req.body;
  try {
    const ai = getGenAI();

    if (!ai) {
      return res.status(503).json({ error: 'AI polishing is not configured (GEMINI_API_KEY is missing). Your draft is unchanged.' });
    }

    const prompt = `Rewrite this B2B customer retention offer email to sound more polished, warm, and persuasive, for client "${accountName}" with a ${discountPct}% retention discount. Keep every factual detail (discount percentage, dollar figures, dates) unchanged. Keep it a similar length.

Current Subject: ${subject}
Current Body:
${body}

Return raw JSON with structure:
{
  "subject": "Polished subject line",
  "body": "Polished email body"
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json'
      }
    });

    const parsed = JSON.parse(response.text || '{}');
    const polishedSubject = parsed.subject || subject;
    const polishedBody = parsed.body || body;

    // The prompt tells the model to leave every figure alone, but an
    // instruction is not enforcement - the same gap the advisor's grounding
    // check exists to cover, and the stakes are higher here because this text
    // goes to the customer as a priced offer. Any figure in the polished draft
    // that was not in the original is a rewrite of a commercial term, so the
    // polish is rejected rather than quietly shipped.
    const altered = findUngroundedFigures(`${polishedSubject} ${polishedBody}`, [`${subject} ${body}`]);
    if (altered.length) {
      console.warn(`Rejected email polish - it changed figures: ${altered.join(', ')}`);
      return res.status(422).json({
        error: `The AI rewrite changed figures in the email (${altered.join(', ')}), so it was discarded. Your draft is unchanged.`,
      });
    }

    res.json({ subject: polishedSubject, body: polishedBody });
  } catch (error: any) {
    console.error('Error in /api/gemini/polish-email:', error);
    // Was a 200 carrying the unchanged draft, so a failure looked identical to
    // a polish that had simply chosen to change nothing.
    res.status(502).json({ error: 'Could not reach the AI to polish this email. Your draft is unchanged.' });
  }
});

// -------------------------------------------------------------
// 4. Face Verification Biometric Security Check (>10% Discount)
// -------------------------------------------------------------
// Real biometric check — embeds the captured frame via model_service's
// /face/embed (FaceNet) and compares it against this user's own enrolled
// vectors from face_samples by cosine distance.
// This is a security gate, not an informational lookup like the other
// model_service-backed endpoints in this file: if the real service is
// unreachable, it must fail CLOSED (verified: false) rather than falling
// back to a plausible-looking success — the whole point of this check is
// that it can't be bypassed by the bridge being down.
app.post('/api/face-verify', requireAuth, async (req, res) => {
  try {
    const { imageBase64, discountPct, accountName } = req.body;
    // The approver is taken from the session, never from the request body —
    // a client-supplied role would let the caller name their own authority.
    const approver = (req as any).user;
    const timestamp = formatTimestamp(new Date());

    if (!imageBase64) {
      return res.json({ success: true, verified: false, error: 'No image received.' });
    }

    // Only ever compared against THIS user's own enrolled faces. That makes
    // the identity check structural rather than an afterthought: there is no
    // code path where someone else's enrolled face could pass, because no
    // other user's vectors are ever loaded. Checked before calling the model
    // so an unenrolled approver fails fast, and so the stored samples — not
    // the users.face_enrolled_at flag — are the single source of truth.
    const samples = await prisma.faceSample.findMany({ where: { userId: approver.id } });
    if (samples.length === 0) {
      return res.json({
        success: true,
        verified: false,
        error: `${approver.name} has no enrolled face on file. Enrol before approving discounts.`,
      });
    }

    const scan = await embedFace(imageBase64);
    if (scan.status === 'bridge-down') {
      return res.status(502).json({
        success: false,
        verified: false,
        error: 'Biometric verification service is offline — cannot approve without it. Start model_service and try again.',
      });
    }
    if (scan.status === 'rejected') {
      return res.json({ success: true, verified: false, error: scan.error });
    }

    let bestDistance = Infinity;
    for (const sample of samples) {
      const distance = cosineDistance(scan.embedding, sample.embedding);
      if (distance < bestDistance) bestDistance = distance;
    }
    const distance = Math.round(bestDistance * 1000) / 1000;

    if (bestDistance > FACE_MATCH_THRESHOLD) {
      console.warn(`Face verify rejected for ${approver.name}: distance ${distance} > ${FACE_MATCH_THRESHOLD}`);
      return res.json({
        success: true,
        verified: false,
        error: `This face doesn't match the signed-in approver (distance ${distance} vs. threshold ${FACE_MATCH_THRESHOLD}).`,
      });
    }

    // Cosine distance rescaled to an intuitive 0-100%: 0 distance -> 100%,
    // right at the match threshold -> 0%.
    const confidenceScore = Math.round(Math.max(0, Math.min(1, 1 - bestDistance / FACE_MATCH_THRESHOLD)) * 1000) / 10;

    res.json({
      success: true,
      verified: true,
      confidenceScore,
      matchProfile: {
        name: approver.name,
        role: roleLabel(approver.role),
        authorizedThreshold: `Up to ${approver.maxSelfApprovalLimit}% Retention Discount`,
      },
      auditRecord: {
        timestamp,
        discountApplied: discountPct,
        accountName,
        verificationStatus: 'Face Verified (Biometric Pass)',
        details: `Facial verification confirmed identity of ${approver.name} (distance ${distance}, threshold ${FACE_MATCH_THRESHOLD}). Approved ${discountPct}% retention discount.`
      }
    });
  } catch (error: any) {
    console.error('Error in /api/face-verify:', error);
    res.status(500).json({ success: false, verified: false, error: 'Face verification failed.' });
  }
});

// -------------------------------------------------------------
// 7. Phase 1 database — users, accounts, subscriptions, usage snapshots,
//    customer reviews, discount requests, audit logs, all real and
//    persisted in Supabase (see prisma/schema.prisma), alongside the ML
//    prediction tables. Nothing is merged in from a mock file any more:
//    mapAccount returns database reads only, so a value on screen either
//    came from a table or from a trained model.
// -------------------------------------------------------------

function formatTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

function roleLabel(role: string): 'Account Manager' | 'Account Director' | 'System' {
  if (role === 'account_director') return 'Account Director';
  // Without this the automatic actor would be labelled "Account Manager" in the audit
  // ledger — which is the exact misattribution the system role exists to avoid.
  if (role === 'system') return 'System';
  return 'Account Manager';
}

// Every audit action string comes from here, so a discount reads the same way
// wherever it appears. Now carries the duration: "10% Retention Discount" said
// nothing about whether it ran for one month or the whole term.
// "Executed" is right for a discount — an approval was carried out, money is committed.
// It is wrong for a walkthrough on its own: nothing was executed, a session was OFFERED to
// the customer, and whether it ever happens is not something this app knows. Same
// correction as discounts that used to call themselves "Active" before they had started.
function buildActionVerb(discountPct: number, includesWalkthrough?: boolean): string {
  return discountPct > 0 ? 'Executed' : includesWalkthrough ? 'Offered' : 'Recorded';
}

function buildActionLabel(discountPct: number, includesWalkthrough?: boolean, discountMonths?: number): string {
  const parts: string[] = [];
  if (discountPct > 0) {
    parts.push(discountMonths
      ? `${discountPct}% Retention Discount for ${discountMonths} ${discountMonths === 1 ? 'month' : 'months'}`
      : `${discountPct}% Retention Discount`);
  }
  if (includesWalkthrough) parts.push('Product Walkthrough');
  return parts.join(' + ') || 'Retention Action';
}

function mapUser(u: any) {
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    email: u.email,
    title: u.title,
    department: u.department,
    employeeId: u.employeeId,
    // "Biometric Verified" now means a face is actually on file, not merely
    // that the role calls for one — a Director who skipped enrolment can't
    // approve anything, so labelling them verified would be misleading.
    biometricStatus: u.faceEnrolledAt ? 'Biometric Verified' : 'Standard Credentials',
    maxSelfApprovalLimit: u.maxSelfApprovalLimit,
    faceEnrolled: Boolean(u.faceEnrolledAt),
    avatarInitials: u.avatarInitials,
    // Which Director this Manager reports to — drives the admin's assignment
    // UI and is what a Director's visibility is derived from.
    directorId: u.directorId ?? undefined,
    directorName: u.director?.name ?? undefined,
    isActive: u.isActive,
  };
}

const RISK_BAND_LABEL: Record<string, 'High Risk' | 'Medium Risk' | 'Low Risk'> = {
  High_Risk: 'High Risk',
  Medium_Risk: 'Medium Risk',
  Low_Risk: 'Low Risk',
};

function mapAccount(a: any) {
  const sub = a.subscriptions[0];
  const usage = a.usageSnapshots[0];
  const review = a.customerReviews[0];

  // The most recent walkthrough offer. There is deliberately no limit on how often one can
  // be offered — a walkthrough costs nothing, so there is no spend to control, and a
  // cooling-off rule would just block a legitimate second session. What the Manager needs
  // is the fact, not a rule: they know the customer and can judge.
  const lastWalkthrough = [...a.auditLogs]
    .filter((l: any) => l.includesWalkthrough)
    .sort((x: any, y: any) => y.createdAt.getTime() - x.createdAt.getTime())[0];

  const lastAppliedLog = [...a.auditLogs]
    .filter((l: any) => l.discountApplied > 0)
    .sort((x: any, y: any) => y.createdAt.getTime() - x.createdAt.getTime())[0];
  const currentDiscountApproved = lastAppliedLog?.discountApplied ?? 0;
  // The same audit row carries how long the discount runs, so the account's current
  // offer can be stated in full rather than as a bare percentage.
  const currentDiscountMonths = lastAppliedLog?.discountMonths ?? 0;

  // Where that discount is in its life. A discount is approved now but covers the first
  // months of the UPCOMING term, so until the renewal arrives nothing has happened yet
  // and the account is still paying list price. `mrr` therefore stays the list rate —
  // every offer is priced off it, and pricing a discount against an already-discounted
  // rate would compound it — while effectiveMrr is what the account actually bills at.
  const listMrr = sub ? Number(sub.mrr) : 0;
  const rawDiscount = discountStatus(
    listMrr, currentDiscountApproved, currentDiscountMonths, lastAppliedLog?.discountStartsAt,
  );

  // A churned account is not a customer any more, and this needed saying only once
  // renewals could actually set that status — before Part 2 nothing ever did, so the case
  // could not arise. Two things would otherwise be false on screen:
  //
  //   1. Its discount would read as "active", because discountStatus only knows about
  //      dates: the window opened at the renewal, and the renewal is in the past. But the
  //      account left AT that renewal, so the discount never took effect at all.
  //   2. It would keep contributing to portfolio ARR and ARR At Risk, since every revenue
  //      total sums effectiveMrr. Revenue from a customer who has gone is not revenue.
  //
  // Zeroing effectiveMrr fixes every money figure at once, because they all read it.
  // `mrr` still reports the list rate the contract was on, so history stays legible.
  const hasChurned = sub?.status === 'churned';
  const discount = hasChurned
    ? { ...rawDiscount, state: 'ended' as const, effectiveMrr: 0 }
    : rawDiscount;

  // Derived purely from the database — there is deliberately no mockData
  // fallback here. mockData.ts hardcodes 'Pending Director Approval' for
  // three accounts, so any fallback path resurrects phantom approvals that
  // nobody requested: first when a request was rejected, and then for EVERY
  // account once the seeded requests were deleted and the length check that
  // was guarding it stopped matching. An account with no requests and no
  // applied discount has had no action taken on it, and should say so.
  const hasPendingRequest = a.discountRequests.some((r: any) => r.status === 'pending');
  // An ENDED discount is not a live action: its months have elapsed, the account is back
  // at list price and it may receive a new offer. Reading `currentDiscountApproved > 0`
  // here marked an account "Discount Approved" permanently after a single discount.
  const actionStatus = hasPendingRequest
    ? 'Pending Director Approval'
    : blocksNewOffer(discount.state)
      ? 'Discount Approved'
      : 'No Action';

  // The headline "current" score/category/SHAP factors stay exactly what
  // they've always been: the single most recent real daily FusionScore row
  // (accountInclude fetches just fusionScores: take 1 now — one real number
  // computed today, not an average). Only the trend LINE below uses monthly
  // averages; the two are deliberately different numbers now.
  const latestFusion = a.fusionScores?.[0];
  const mlOverrides: Record<string, any> = {};

  if (latestFusion) {
    mlOverrides.fusionRiskScore = Math.round(latestFusion.fusionScore);
    mlOverrides.riskCategory = RISK_BAND_LABEL[latestFusion.riskCategory];
    // When these numbers were last computed. Without it nothing on screen distinguishes a
    // score produced this morning from one produced a week ago, so a daily job that quietly
    // stopped would leave every account looking exactly as trustworthy as before.
    mlOverrides.scoredAt = latestFusion.snapshotDate.toISOString().substring(0, 10);

    const churnPrediction = latestFusion.churnPrediction;
    if (churnPrediction) {
      mlOverrides.churnModelScore = Math.round(churnPrediction.churnProba * 100);
      if (churnPrediction.shapExplanations?.length) {
        mlOverrides.shapFactors = churnPrediction.shapExplanations.map((s: any) => ({
          feature: s.featureName,
          impact: s.impact,
          description: s.description,
          direction: s.direction,
        }));
      }
    }
  }

  // The trend line: real monthly averages (fusion_monthly_summaries), one
  // row per calendar month by construction (unique constraint), so no
  // dedup step is needed here the way the old raw-row version required.
  const monthlySummaries = a.fusionMonthlySummaries ?? [];
  if (monthlySummaries.length > 0) {
    mlOverrides.riskHistory = [...monthlySummaries].reverse().map((s: any) => Math.round(s.avgFusionScore));

    if (monthlySummaries.length >= 2) {
      const delta = monthlySummaries[0].avgFusionScore - monthlySummaries[1].avgFusionScore;
      mlOverrides.riskTrend = delta > 1 ? 'increasing' : delta < -1 ? 'decreasing' : 'stable';
    }
  }

  const latestExplanation = a.aiExplanations?.[0];
  if (latestExplanation) mlOverrides.geminiExplanationSummary = latestExplanation.summary;

  // Real sentiment classification (Frustrated/Neutral/Satisfied — the actual
  // trained model's 3-class vocabulary) replaces mockData.ts's invented
  // 5-class sentimentScore/sentimentClassification once a review has one.
  //
  // A person's correction takes precedence over the model here. sentiment_predictions
  // stays a record of what the MODEL said — never overwritten — and the effective reading
  // is "corrected ?? model", exposed alongside `modelSentiment` so the UI can show both.
  // Leaving the model's reading as the headline after someone has overruled it would mean
  // presenting a value the business has established is wrong.
  const latestSentiment = review?.sentimentPredictions?.[0];
  if (latestSentiment) {
    mlOverrides.modelSentiment = latestSentiment.classification;
    mlOverrides.sentimentClassification = review?.correctedSentiment ?? latestSentiment.classification;
    // Only a DISAGREEMENT replaces the weight. Confirming the label leaves the model's
    // own probability in place, so an account nobody disagrees with is still scored by
    // the model rather than by whoever last clicked through it.
    const disagrees = review?.correctedSentiment && review.correctedSentiment !== latestSentiment.classification;
    mlOverrides.sentimentRiskWeight = disagrees
      ? SENTIMENT_RISK_WEIGHT[review!.correctedSentiment as SentimentClassValue]
      : latestSentiment.riskWeight ?? undefined;
  }

  // Every field is a database read. There is deliberately no mockData spread
  // here any more: it used to supply a dozen fields with no column behind
  // them, which meant invented numbers reached the UI indistinguishable from
  // measured ones — and a hardcoded actionStatus resurrected discount
  // approvals nobody had made.
  return {
    id: a.id,
    name: a.name,
    logo: a.logoInitials,
    industry: a.industry,
    accountManager: a.accountManager.name,
    mrr: listMrr,
    subscriptionType: sub?.planTier ?? 'Basic',
    contractRenewalDate: sub ? sub.termEnd.toISOString().substring(0, 10) : undefined,
    contractDurationMonths: sub?.durationMonths,
    accountAgeDays: usage?.accountAgeDays,
    dailyUsageMinutes: usage?.dailyUsageMins,
    supportTicketCount: usage?.supportTickets90Days,
    // When the readings above were taken, which is not the same question as when the score
    // was computed: a re-score today over a usage row from three days ago produces a score
    // dated today from stale inputs. Both dates are exposed so the UI can say which it means.
    usageCapturedAt: usage?.capturedAt?.toISOString().substring(0, 10),
    // The churn model's own two remaining inputs, previously only available
    // as invented raw numbers (apiUsageRate / apiBenchmark, a logins-per-month
    // count) rather than the real values the model is actually given.
    loginFrequencyBucket: usage?.loginFrequencyBucket,
    apiUtilizationRate: usage?.apiUtilizationRate,
    reviewText: review?.reviewText,
    reviewId: review?.id,
    // A person's correction of the sentiment model. sentimentClassification above is the
    // EFFECTIVE reading (corrected when one exists); modelSentiment is what the model
    // itself said, so the UI can show the disagreement rather than hiding either side.
    correctedSentiment: review?.correctedSentiment ?? undefined,
    correctedSentimentBy: review?.correctedBy?.name ?? undefined,
    currentDiscountApproved,
    currentDiscountMonths,
    // The discount's lifecycle, derived in pricing.ts so the client cannot word or date
    // it differently from the totals computed here.
    effectiveMrr: discount.effectiveMrr,
    discountState: discount.state,
    discountStartsAt: discount.startsAt?.toISOString(),
    discountEndsAt: discount.endsAt?.toISOString(),
    discountLabel: hasChurned && currentDiscountApproved > 0
      // "ended <date>" would imply the discount ran and finished. It never started: the
      // account left at the renewal the discount was waiting for.
      ? `${describeDiscount(currentDiscountApproved, currentDiscountMonths)} — never took effect, account churned`
      : describeDiscountStatus(currentDiscountApproved, currentDiscountMonths, discount),
    // Exposed so the UI can mark a departed account rather than showing it as ordinary.
    subscriptionStatus: sub?.status ?? 'active',
    lastWalkthroughAt: lastWalkthrough?.createdAt.toISOString(),
    lastWalkthroughBy: lastWalkthrough?.approver?.name,
    actionStatus,
    // Always an array, even when the latest prediction has no SHAP rows behind it.
    // mlOverrides sets this only when explanations exist, so without a default the key
    // was absent entirely — and Account.shapFactors is typed as a non-optional array, so
    // nothing warned. The account page reads `.length` on it directly and the whole app
    // white-screened when it came back undefined.
    shapFactors: [],
    ...mlOverrides,
  };
}

function mapRenewalRecord(r: any) {
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.account.name,
    renewalDate: r.renewalDate.toISOString().substring(0, 10),
    outcome: r.outcome,
    retained: r.retained,
    // Surfaced deliberately: a row nobody confirmed is a weaker fact than one somebody
    // did, and the UI has to be able to say which it is looking at.
    autoRecorded: r.autoRecorded,
    recordedBy: r.recordedBy?.name ?? null,
    recordedAt: r.recordedAt.toISOString(),
    predictedRisk: r.predictedRisk,
    // The band that risk fell into, computed HERE with fusionRiskCategory — the single
    // canonical definition (>70 High, >30 Medium). The UI needs it to say whether the
    // model called this account correctly, and re-deriving the thresholds client-side is
    // exactly how the Director dashboard's bands drifted out of step once already.
    predictedBand: r.predictedRisk === null ? null : fusionRiskCategory(r.predictedRisk).replace('_', ' '),
    discountPct: r.discountPct,
    discountMonths: r.discountMonths,
    planTierBefore: r.planTierBefore,
    planTierAfter: r.planTierAfter,
  };
}

function mapRenewalIntent(i: any) {
  return {
    id: i.id,
    accountId: i.accountId,
    accountName: i.account.name,
    kind: i.kind,
    targetTier: i.targetTier,
    effectiveFor: i.effectiveFor.toISOString(),
    source: i.source,
    recordedBy: i.recordedBy?.name ?? null,
    recordedAt: i.recordedAt.toISOString(),
  };
}

function mapDiscountRequest(r: any) {
  const sub = r.account.subscriptions[0];
  return {
    id: r.id,
    accountId: r.accountId,
    accountName: r.account.name,
    mrr: sub ? Number(sub.mrr) : 0,
    requestedDiscountPct: r.requestedPct,
    requestedDurationMonths: r.durationMonths,
    requestedBy: `${r.requestedBy.name} (${roleLabel(r.requestedBy.role)})`,
    requestedAt: r.requestedAt.toISOString(),
    status: r.status,
    managerNote: r.managerNote,
    directorNote: r.directorNote ?? undefined,
    includesWalkthrough: r.includesWalkthrough,
    riskScore: r.riskScore,
    facialVerificationRequired: r.facialVerificationRequired,
    approvedAt: r.approvedAt?.toISOString(),
    approvedBy: r.approvedBy?.name,
  };
}

function mapAuditLog(l: any) {
  return {
    id: l.id,
    accountId: l.accountId,
    accountName: l.account.name,
    timestamp: formatTimestamp(l.createdAt),
    action: l.action,
    discountApplied: l.discountApplied,
    approver: `${l.approver.name} (${roleLabel(l.approver.role)})`,
    approverRole: roleLabel(l.approver.role),
    verificationStatus: l.verificationStatus,
    details: l.details,
  };
}

const accountInclude = {
  accountManager: true,
  subscriptions: { orderBy: { termStart: 'desc' as const }, take: 1 },
  usageSnapshots: { orderBy: { capturedAt: 'desc' as const }, take: 1 },
  customerReviews: {
    orderBy: { submittedAt: 'desc' as const },
    take: 1,
    include: {
      sentimentPredictions: { orderBy: { predictedAt: 'desc' as const }, take: 1 },
      correctedBy: true,
    },
  },
  auditLogs: { include: { approver: true } },
  discountRequests: true,
  fusionScores: {
    orderBy: { snapshotDate: 'desc' as const },
    take: 1, // just today's/latest real daily row — headline score, unchanged from before
    include: { churnPrediction: { include: { shapExplanations: true } } },
  },
  fusionMonthlySummaries: {
    orderBy: { monthStart: 'desc' as const },
    take: 6, // the trend line
  },
  aiExplanations: { orderBy: { generatedAt: 'desc' as const }, take: 1 },
};

const discountRequestInclude = {
  account: { include: { subscriptions: { orderBy: { termStart: 'desc' as const }, take: 1 } } },
  requestedBy: true,
  approvedBy: true,
};

const auditLogInclude = { account: true, approver: true };

// Portfolio-wide monthly trend — replaces PortfolioTrajectoryCharts.tsx's
// hardcoded monthlyData array (Feb-Jul, invented numbers). Reads
// fusion_monthly_summaries directly: each row already IS one company's own
// monthly average (computed once, at rollup time, by fusionSnapshot.ts), so
// this is now genuinely "average of each company's average, divided by the
// number of companies" — not a pool of every raw daily row across accounts.
// managerIds scopes the trend to a specific set of managers' books — one id
// for an Account Manager's own accounts, their whole team for a Director.
// Omitted (admins) means every account.
async function computePortfolioTrend(managerIds?: string[]) {
  const rows = await prisma.fusionMonthlySummary.findMany({
    where: managerIds ? { account: { accountManagerId: { in: managerIds } } } : {},
    include: { account: { include: { subscriptions: { orderBy: { termStart: 'desc' }, take: 1 } } } },
    orderBy: { monthStart: 'asc' },
  });

  const byMonth = new Map<string, { scores: number[]; atRiskMrr: number; year: number }>();
  for (const row of rows) {
    const monthKey = row.monthStart.toISOString().substring(0, 7); // "2026-03"
    if (!byMonth.has(monthKey)) {
      byMonth.set(monthKey, { scores: [], atRiskMrr: 0, year: row.monthStart.getUTCFullYear() });
    }
    const bucket = byMonth.get(monthKey)!;
    bucket.scores.push(row.avgFusionScore); // already this one company's own monthly average
    if (row.avgFusionScore > 70) bucket.atRiskMrr += Number(row.account.subscriptions[0]?.mrr ?? 0);
  }

  return [...byMonth.keys()].sort().map((monthKey) => {
    const bucket = byMonth.get(monthKey)!;
    const avgRiskPct = Math.round(bucket.scores.reduce((a, b) => a + b, 0) / bucket.scores.length); // avg of company-averages
    const mrrRiskK = Math.round(bucket.atRiskMrr / 1000);
    const month = new Date(`${monthKey}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    return { month, year: bucket.year, mrrRiskK, avgRiskPct };
  });
}

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  try {
    // Scoped on the server, not in the browser: sending every account to every
    // user and hiding the rest client-side would still ship the data.
    //
    //   admin    — runs the org; sees every account so it can be assigned.
    //   director — sees the accounts owned by the Managers assigned to them by
    //              an admin. Nobody assigned means nothing to see, which is a
    //              real state, not an error.
    //   manager  — sees only the accounts they own.
    const user = (req as any).user;
    const isAdmin = user.role === 'admin';
    const isDirector = user.role === 'account_director';

    // The set of managers whose work this user can see. For a Director that's
    // their assigned team; for a Manager it's themselves.
    const teamManagerIds = isDirector
      ? (await prisma.user.findMany({ where: { directorId: user.id }, select: { id: true } })).map(u => u.id)
      : [user.id];

    const ownedAccounts = isAdmin ? {} : { accountManagerId: { in: teamManagerIds } };
    const viaOwnedAccount = isAdmin ? {} : { account: { accountManagerId: { in: teamManagerIds } } };

    // The audit trail is scoped by WHO ACTED, not by who owns the account —
    // a manager's ledger is a record of their own actions. Seeing another
    // manager's approval just because the account later moved to them would
    // misattribute it. A manager therefore sees their own entries plus any
    // Director decision on one of their accounts (the approve/reject that
    // closes out a request they raised); a Director sees their team's.
    const auditScope = isAdmin ? {} : isDirector
      ? { OR: [{ approverId: user.id }, { account: { accountManagerId: { in: teamManagerIds } } }] }
      : {
          OR: [
            { approverId: user.id },
            { approver: { role: 'account_director' as const }, account: { accountManagerId: user.id } },
          ],
        };

    const [users, accounts, discountRequests, auditLogs, portfolioTrend, renewalRecords, renewalIntents] =
      await Promise.all([
        // The system actor is not a person: it must never appear in the admin's user
        // table, in an "assign to manager" list, or as a selectable Director.
        prisma.user.findMany({ where: { role: { not: 'system' } }, include: { director: true }, orderBy: { name: 'asc' } }),
        prisma.account.findMany({ where: ownedAccounts, include: accountInclude }),
        prisma.discountRequest.findMany({ where: viaOwnedAccount, include: discountRequestInclude, orderBy: { requestedAt: 'desc' } }),
        prisma.auditLog.findMany({ where: auditScope, include: auditLogInclude, orderBy: { createdAt: 'desc' } }),
        computePortfolioTrend(isAdmin ? undefined : teamManagerIds),
        // Scoped by account ownership like the accounts themselves — a renewal outcome
        // is a fact about an account, not about who happened to record it.
        prisma.renewalRecord.findMany({
          where: viaOwnedAccount,
          include: { account: true, recordedBy: true },
          orderBy: { renewalDate: 'desc' },
        }),
        prisma.renewalIntent.findMany({
          where: { ...viaOwnedAccount, cancelledAt: null, appliedAt: null },
          include: { account: true, recordedBy: true },
          orderBy: { effectiveFor: 'asc' },
        }),
      ]);

    res.json({
      users: users.map(mapUser),
      accounts: accounts.map(mapAccount),
      discountRequests: discountRequests.map(mapDiscountRequest),
      auditLogs: auditLogs.map(mapAuditLog),
      portfolioTrend,
      renewalRecords: renewalRecords.map(mapRenewalRecord),
      renewalIntents: renewalIntents.map(mapRenewalIntent),
    });
  } catch (error: any) {
    console.error('Error in /api/bootstrap:', error);
    res.status(500).json({ error: 'Failed to load data from the database.' });
  }
});

// AM requests a discount above their self-approval limit — mirrors the
// >10% branch of the old client-only handleApplyDiscount exactly, just
// persisted: creates a pending discount_requests row plus the matching
// "Request Submitted" audit_logs entry, in one transaction.
app.post('/api/discount-requests', requireAuth, async (req, res) => {
  try {
    const requestedById = (req as any).userId as string;
    const { accountId, discountPct, discountMonths, managerNote, riskScore, includesWalkthrough } = req.body;

    const check = await validateOffer(accountId, discountPct, discountMonths);
    if ('error' in check) return res.status(check.status ?? 400).json({ error: check.error });

    const label = buildActionLabel(discountPct, includesWalkthrough, discountMonths);
    // A request only exists because it exceeds what a Manager may approve alone, so
    // the Director is being asked to authorise spending on the strength of this note.
    // It used to be substituted with boilerplate when left blank - and the client
    // substituted something worse, a specific claim about "urgent customer activation
    // issues" that the Manager never made. Words attributed to a named person, shown
    // to their Director, justifying money. Rejected rather than filled in.
    const finalNote = typeof managerNote === 'string' ? managerNote.trim() : '';
    if (!finalNote) {
      return res.status(400).json({
        error: 'A justification is required: the Account Director approves this on the strength of your note.',
      });
    }

    const [request] = await prisma.$transaction([
      prisma.discountRequest.create({
        data: {
          accountId,
          requestedById,
          requestedPct: discountPct,
          durationMonths: discountMonths,
          // Pinned now, not read back at approval time — see the field's comment.
          appliesToRenewal: check.renewalDate,
          managerNote: finalNote,
          includesWalkthrough: Boolean(includesWalkthrough),
          status: 'pending',
          riskScore: riskScore ?? 0,
          facialVerificationRequired: true,
        },
      }),
      prisma.auditLog.create({
        data: {
          accountId,
          action: `${label} Request Submitted`,
          discountApplied: 0,
          includesWalkthrough: Boolean(includesWalkthrough),
          approverId: requestedById,
          verificationStatus: 'Pending Director Approval',
          details: `Requested ${label}, giving away ${formatMoney(check.giveback)} of ${check.account.name}'s annual contract value (Manager limit ${formatMoney(check.cap)}); term value ${formatMoney(check.termValue)}. Escalated to Account Director for facial verification approval. Manager note: "${finalNote}"`,
        },
      }),
    ]);

    res.json({ ok: true, requestId: request.id });
  } catch (error: any) {
    console.error('Error in POST /api/discount-requests:', error);
    res.status(500).json({ error: 'Failed to submit discount request.' });
  }
});

// Director approves a pending request after biometric verification — mirrors
// handleApproveDiscountRequest -> handleApplyDiscount('Face Verified...').
app.post('/api/discount-requests/:id/approve', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const approvedById = (req as any).userId as string;
    const approver = (req as any).user;
    const { matchedName } = req.body;
    const request = await prisma.discountRequest.findUnique({ where: { id }, include: { account: true } });
    if (!request) return res.status(404).json({ error: 'Request not found' });

    // Read off the stored request, not the client's body — the approval must
    // record what was actually asked for, not what the approving browser says.
    const label = buildActionLabel(request.requestedPct, request.includesWalkthrough, request.durationMonths);
    const verificationStatus = 'Face Verified (Biometric Pass)';

    // The biometric scan confirms whoever's face_app-enrolled identity
    // matched — a second, independent signal from the logged-in session
    // itself. They should normally agree; a mismatch here (someone logged
    // in as one person but a different enrolled face was scanned) is worth
    // recording explicitly rather than silently trusting the session alone.
    const identityNote = matchedName
      ? matchedName === approver.name
        ? ` Biometric match confirmed: ${matchedName}.`
        : ` NOTE: biometric match was "${matchedName}", which does not match the logged-in approver "${approver.name}".`
      : '';

    await prisma.$transaction([
      prisma.discountRequest.update({
        where: { id },
        data: { status: 'approved', approvedById, approvedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          accountId: request.accountId,
          action: `${label} ${buildActionVerb(request.requestedPct, request.includesWalkthrough)}`,
          discountApplied: request.requestedPct,
          discountMonths: request.durationMonths,
          includesWalkthrough: request.includesWalkthrough,
          // Carried from the request rather than re-read from the subscription: the
          // renewal this was built for is the one it must apply to, even if the term
          // has since rolled while the request sat pending.
          discountStartsAt: request.appliesToRenewal,
          approverId: approvedById,
          verificationStatus,
          details: `${label} granted to ${request.account.name} by ${approver.name}. Verification mode: ${verificationStatus}.${identityNote}`,
        },
      }),
    ]);

    if (request.requestedPct > 0) {
      try {
        await captureIndexSnapshot(request.accountId, 'offer_approved');
      } catch (err: any) {
        console.warn('Index snapshot failed after Director approval:', err.message || err);
      }
    }

    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error in POST /api/discount-requests/:id/approve:', error);
    res.status(500).json({ error: 'Failed to approve discount request.' });
  }
});

// Director rejects a pending request — mirrors handleRejectDiscountRequest exactly.
app.post('/api/discount-requests/:id/reject', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const rejectedById = (req as any).userId as string;
    const { directorNote } = req.body;
    const request = await prisma.discountRequest.findUnique({ where: { id }, include: { account: true } });
    if (!request) return res.status(404).json({ error: 'Request not found' });

    // Built by the same helper every other audit action uses. This used to be
    // a hand-rolled `${pct}% Discount`, which read differently from every other
    // row in the ledger ("Retention Discount").
    //
    const rejectedLabel = buildActionLabel(request.requestedPct, request.includesWalkthrough, request.durationMonths);
    const note = directorNote || 'Discount request rejected by Account Director.';

    await prisma.$transaction([
      prisma.discountRequest.update({ where: { id }, data: { status: 'rejected', directorNote: note } }),
      prisma.auditLog.create({
        data: {
          accountId: request.accountId,
          action: `${rejectedLabel} Request Rejected`,
          discountApplied: 0,
          approverId: rejectedById,
          verificationStatus: 'Rejected',
          details: `Account Director rejected ${rejectedLabel} request for ${request.account.name}. Director Remark: "${note}"`,
        },
      }),
    ]);

    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error in POST /api/discount-requests/:id/reject:', error);
    res.status(500).json({ error: 'Failed to reject discount request.' });
  }
});

// Direct apply, no request needed — an AM applying <=10% themselves, or the
// director's own quick-approve path. Just an audit_logs entry; discount
// requests only exist for the >10% escalation path.
// Validates a proposed offer against the account's own contract value.
//
// Neither write endpoint checked anything before this: both took the percentage
// straight from req.body, so the browser was the only thing preventing a 50%
// self-approval. A value-based rule enforced only on the client would have been no
// better than the percentage rule it replaced.
async function validateOffer(accountId: string, pct: number, months: number) {
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
    return { error: 'Discount percentage must be a whole number between 0 and 100.' };
  }
  if (!Number.isInteger(months) || months < 1 || months > MONTHS_PER_TERM) {
    return { error: `Discount duration must be a whole number of months between 1 and ${MONTHS_PER_TERM}.` };
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      subscriptions: { orderBy: { termStart: 'desc' }, take: 1 },
      // The account's current offer, for the no-stacking rule below.
      auditLogs: { where: { discountApplied: { gt: 0 } }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  if (!account) return { error: 'Account not found', status: 404 };

  const sub = account.subscriptions[0];
  if (!sub) return { error: `${account.name} has no subscription, so an offer cannot be priced.`, status: 422 };
  // Only reachable since renewals started writing this status. A retention offer to a
  // customer who has already gone would be recorded, audited and counted as a giveaway
  // against a contract that no longer exists.
  if (sub.status === 'churned') {
    return { error: `${account.name} has churned, so a retention offer cannot be made.`, status: 409 };
  }

  // Offers are only allowed inside the renewal window.
  //
  // A business rule first — discounting six months before you know whether an account is
  // even at risk gives money away early. But it is also what makes the training data
  // valid: because no discount can exist before this point, the account's state when the
  // window opens is guaranteed pre-treatment for EVERY account, which is the fixed
  // reference the uplift model's untreated control group is measured at.
  // ONLY money is window-gated. A product walkthrough costs nothing and can be offered at
  // any point in the contract — blocking a free intervention because a renewal is far away
  // would be pure harm. Both of the window's reasons are about discounts specifically:
  // paying early for a wobble that may pass, and keeping the pre-treatment measurement
  // aligned. A walkthrough is not one of the uplift model's treatment arms (they are all
  // percentage/duration pairs), so it neither spends money nor disturbs the measurement.
  const daysOut = daysUntil(sub.termEnd);
  if (pct > 0 && daysOut > OFFER_WINDOW_DAYS) {
    return {
      error: `${account.name} renews on ${formatTermDate(sub.termEnd)}, ${daysOut} days away. ` +
             `Discounts open ${OFFER_WINDOW_DAYS} days before renewal — ` +
             `${formatTermDate(new Date(sub.termEnd.getTime() - OFFER_WINDOW_DAYS * 86400000))}. ` +
             `A product walkthrough can be offered now.`,
      status: 409,
    };
  }

  const mrr = Number(sub.mrr);

  // No-stacking, enforced HERE rather than only in the UI. Both write paths took the
  // client's word for it, so a second discount could be applied on top of a running one
  // by calling the endpoint directly — the same shape of hole as the two endpoints that
  // used to read the discount percentage straight from req.body.
  //
  // An ENDED discount no longer blocks: its months have elapsed and the account is back
  // at list price, so refusing a fresh offer would lock the account out permanently
  // after a single discount years earlier.
  const existing = account.auditLogs[0];
  if (existing) {
    const status = discountStatus(
      mrr, existing.discountApplied, existing.discountMonths, existing.discountStartsAt,
    );
    if (blocksNewOffer(status.state)) {
      return {
        error: `${account.name} already has ${describeDiscountStatus(existing.discountApplied, existing.discountMonths, status)}. A second discount cannot be stacked on top of it.`,
        status: 409,
      };
    }
  }

  return {
    account,
    mrr,
    // The renewal this offer takes effect at. Pinned by the caller at submission so a
    // request that sits pending across a renewal is not later stamped with the next
    // year's date (see DiscountRequest.appliesToRenewal).
    renewalDate: sub.termEnd,
    giveback: givebackValue(mrr, pct, months),
    cap: selfApprovalCap(mrr),
    termValue: discountedTermValue(mrr, pct, months),
    needsDirector: needsDirectorApproval(mrr, pct, months),
  };
}

app.post('/api/accounts/:id/apply-discount', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const approverId = (req as any).userId as string;
    const approver = (req as any).user;
    const { discountPct, discountMonths, includesWalkthrough } = req.body;

    const check = await validateOffer(id, discountPct, discountMonths);
    if ('error' in check) return res.status(check.status ?? 400).json({ error: check.error });

    // The whole point of the value gate: this is what stops a self-approval that
    // costs more than the policy allows, however it is structured.
    if (check.needsDirector) {
      return res.status(403).json({
        error: `${describeDiscount(discountPct, discountMonths)} gives away ${formatMoney(check.giveback)} of ${check.account.name}'s annual contract value, above the ${formatMoney(check.cap)} an Account Manager may approve. Submit it for Director approval instead.`,
      });
    }

    const label = buildActionLabel(discountPct, includesWalkthrough, discountMonths);
    const verificationStatus = 'Direct Approval (Within Manager Limit)';

    await prisma.auditLog.create({
      data: {
        accountId: id,
        action: `${label} ${buildActionVerb(discountPct, includesWalkthrough)}`,
        discountApplied: discountPct,
        discountMonths,
        includesWalkthrough: Boolean(includesWalkthrough),
        // Self-approval is immediate, so the renewal read here is the one it applies to.
        discountStartsAt: check.renewalDate,
        approverId,
        verificationStatus,
        details: `${label} granted to ${check.account.name} by ${approver.name}. Gives away ${formatMoney(check.giveback)} of ${formatMoney(check.cap / 0.10)} annual contract value; term value ${formatMoney(check.termValue)}. Verification mode: ${verificationStatus}.`,
      },
    });

    // The decision moment: freeze what this offer was decided on, before it takes effect.
    //
    // Only for an actual discount. A walkthrough-only offer is not one of the uplift
    // model's treatment arms, so freezing on one would move the account's measurement
    // without any treatment to attribute it to — and could do so outside the window,
    // breaking the alignment the index exists to guarantee.
    //
    // Non-fatal: the discount is already recorded, and losing the training snapshot must
    // not fail an approval the Manager legitimately made.
    if (discountPct > 0) {
      try {
        await captureIndexSnapshot(id, 'offer_approved');
      } catch (err: any) {
        console.warn('Index snapshot failed after self-approval:', err.message || err);
      }
    }

    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error in POST /api/accounts/:id/apply-discount:', error);
    res.status(500).json({ error: 'Failed to apply discount.' });
  }
});

// On-demand real recompute of an account's fusion score, using the same
// chain as computeRealFusion above.
app.get('/api/accounts/:id/fusion', requireAuth, async (req, res) => {
  try {
    const { churnData, sentData, fusionData } = await computeRealFusion(req.params.id);
    res.json({
      churnProba: churnData.churn_proba,
      churnRiskBand: churnData.risk_band,
      sentimentClassification: sentData.classification,
      sentimentScore: sentData.score,
      fusionProba: fusionData.fusion_proba,
      fusionScore: Math.round(fusionData.fusion_proba * 100),
    });
  } catch (error: any) {
    console.error('Error in GET /api/accounts/:id/fusion:', error);
    res.status(502).json({ error: error.message || 'Failed to compute a real fusion score.' });
  }
});

// Manual trigger for the daily fusion snapshot job (see fusionSnapshot.ts) —
// idempotent, safe to call more than once the same day. Useful for testing
// without waiting for the startup/interval check in startServer() below, and
// for getting the first real sample into a new month immediately after this
// feature ships. Requires being logged in; there's no separate admin role in
// this app, so any authenticated session can trigger it.
app.post('/api/admin/run-daily-snapshot', requireAuth, async (_req, res) => {
  try {
    const summary = await runDailySnapshotForToday();
    res.json(summary);
  } catch (error: any) {
    console.error('Error in POST /api/admin/run-daily-snapshot:', error);
    res.status(500).json({ error: error.message || 'Daily snapshot run failed.' });
  }
});

// Correct the sentiment model's read of a review.
//
// The only feedback signal that can retrain the sentiment model. Renewal outcomes cannot:
// a furious customer can renew and a quiet one can leave, so training sentiment on
// outcomes would collapse it into a second churn predictor and leave the fusion model
// blending a number with a copy of itself.
//
// This records the disagreement; it does NOT overwrite the prediction or recompute the
// fusion score. Everything the app displays as model output stays model output — the
// correction sits beside it and feeds the next training run.
app.post('/api/reviews/:id/sentiment-correction', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { sentiment } = req.body;

    const VALID = ['Frustrated', 'Neutral', 'Satisfied'];
    if (sentiment !== null && !VALID.includes(sentiment)) {
      return res.status(400).json({ error: `sentiment must be null or one of ${VALID.join(', ')}.` });
    }

    const review = await prisma.customerReview.findUnique({
      where: { id: req.params.id },
      include: {
        account: true,
        sentimentPredictions: { orderBy: { predictedAt: 'desc' }, take: 1 },
      },
    });
    if (!review) return res.status(404).json({ error: 'Review not found' });

    // Captured before the rescore so the audit row can state what actually moved.
    const scoreBefore = await prisma.fusionScore.findFirst({
      where: { accountId: review.accountId },
      orderBy: { snapshotDate: 'desc' },
      include: { sentimentPrediction: true },
    });
    const modelSaid = review.sentimentPredictions[0]?.classification ?? null;
    const readingBefore = review.correctedSentiment ?? modelSaid;
    const weightBefore = review.correctedSentiment
      ? SENTIMENT_RISK_WEIGHT[review.correctedSentiment as SentimentClassValue]
      : scoreBefore?.sentimentPrediction?.riskWeight ?? null;

    // Passing null clears a correction — someone who decides the model had it right after
    // all should be able to withdraw their label rather than leave a wrong one in training.
    await prisma.customerReview.update({
      where: { id: review.id },
      data: sentiment === null
        ? { correctedSentiment: null, correctedById: null, correctedAt: null }
        : { correctedSentiment: sentiment, correctedById: userId, correctedAt: new Date() },
    });

    // Rescore immediately. The account's fused risk was built partly on the reading just
    // overturned, and the uplift model reads sentiment_score when recommending a discount
    // — so leaving the old score would keep a money decision resting on it. Clearing a
    // correction rescores too, handing the account back to the model.
    //
    // Non-fatal: the correction is stored either way, and the nightly run will pick it up.
    // Losing the model service must not lose the person's judgement.
    // Only rescore when something can actually change. Confirming the model's own label
    // leaves every number where it was, so recomputing would write a duplicate set of
    // prediction rows to reach an identical answer.
    const changesTheScore = sentiment !== modelSaid;
    let rescored: any = null;
    if (changesTheScore) {
      try {
        rescored = await rescoreAccountToday(review.accountId);
      } catch (err: any) {
        console.warn('Rescore after sentiment correction failed (correction still saved):', err.message || err);
      }
    }

    // Audited like every other state change a person makes. This one moves an account's
    // displayed risk and is attributable to a named person, so leaving it out would put a
    // gap in the trail exactly where someone later asks "why did this score change?".
    //
    // discountApplied is 0, and must stay 0: mapAccount derives an account's current
    // discount from the most recent audit row with a non-zero percentage, so any other
    // value here would make this row masquerade as a live offer.
    const actor = (req as any).user;
    const weightAfter = sentiment === null
      ? rescored?.riskWeight ?? null
      : SENTIMENT_RISK_WEIGHT[sentiment as SentimentClassValue];
    // Only what MOVED. The reading itself is already named in the sentence below, so
    // repeating it as "Reading Neutral -> Satisfied" said the same thing twice.
    const movement = [
      weightBefore != null && weightAfter != null && weightBefore !== weightAfter
        ? `Sentiment risk weight ${weightBefore.toFixed(2)} -> ${weightAfter.toFixed(2)}.` : '',
      scoreBefore && rescored && scoreBefore.fusionScore !== rescored.fusionScore
        ? `Fusion risk ${scoreBefore.fusionScore} -> ${rescored.fusionScore}.` : '',
    ].filter(Boolean).join(' ');
    const movementNote = movement ? ` ${movement}` : '';

    await prisma.auditLog.create({
      data: {
        accountId: review.accountId,
        // Agreeing with the model is a confirmation, not a correction — and the ledger
        // should not claim someone overruled a reading they endorsed.
        action: sentiment === null
          ? 'Sentiment Correction Withdrawn'
          : sentiment === modelSaid ? 'Sentiment Confirmed' : 'Sentiment Corrected',
        discountApplied: 0,
        discountMonths: 0,
        approverId: userId,
        verificationStatus: 'Human Label (Model Feedback)',
        details: sentiment === null
          ? `${actor.name} withdrew the sentiment correction on ${review.account.name}'s review, ` +
            `handing the reading back to the model (${modelSaid}).${movementNote} ` +
            `The training example has been removed.`
          : sentiment === modelSaid
            ? `${actor.name} confirmed ${review.account.name}'s review sentiment as ${sentiment}, ` +
              `agreeing with the model. Scores are unchanged — a confirmation verifies the label, ` +
              `not the model's confidence. Saved as a sentiment training example.`
            : `${actor.name} corrected ${review.account.name}'s review sentiment to ${sentiment}; ` +
              `the model had read it as ${modelSaid}.${movementNote} ` +
              `Saved as a sentiment training example.`,
      },
    });

    res.json({
      ok: true,
      modelSaid: review.sentimentPredictions[0]?.classification ?? null,
      corrected: sentiment,
      rescored: rescored ? { fusionScore: rescored.fusionScore, riskWeight: rescored.riskWeight } : null,
    });
  } catch (error: any) {
    console.error('Error in POST /api/reviews/:id/sentiment-correction:', error);
    res.status(500).json({ error: 'Failed to record the sentiment correction.' });
  }
});

// Manual trigger for the renewal pass, so a renewal can be resolved without waiting for
// the 6-hourly interval. Idempotent for the same reasons the job is.
app.post('/api/admin/run-renewals', requireAuth, async (_req, res) => {
  try {
    res.json(await runRenewalsForToday());
  } catch (error: any) {
    console.error('Error in POST /api/admin/run-renewals:', error);
    res.status(500).json({ error: error.message || 'Renewal run failed.' });
  }
});

// Record what an account is expected to do at its next renewal.
//
// This changes NOTHING about the account now. It is held until the renewal date and
// resolved by the daily job there — which is what makes it safe to accept without a
// second person confirming it: while pending it is visible and can be cancelled.
// ── Email ingestion ─────────────────────────────────────────────────────────
//
// Shared by the route below and the poll in startServer, so a manual check and a scheduled
// one cannot behave differently. The in-flight guard is module-level rather than per-request
// because the cost being avoided is two simultaneous IMAP connections to the same mailbox,
// which Gmail will refuse.
let ingestInFlight = false;

async function runIngestOnce(log = false) {
  if (ingestInFlight) return { busy: true as const };
  ingestInFlight = true;
  try {
    const summary = await ingestInbox(log);

    // Once per ACCOUNT, not once per email. rescoreAccountToday creates a fresh churn and
    // sentiment prediction row on every call, so three emails about one customer would
    // otherwise leave three sets of rows behind to arrive at a single answer.
    const rescored: string[] = [];
    for (const accountId of summary.accountIds) {
      try {
        await rescoreAccountToday(accountId);
        rescored.push(accountId);
      } catch (err: any) {
        // Non-fatal by design: the review is already committed, and the daily pass will
        // score it. Losing the model service must not lose the customer's feedback.
        console.warn('Re-score after ingest failed (review still saved):', err.message || err);
      }
    }
    return { busy: false as const, summary, rescored };
  } finally {
    ingestInFlight = false;
  }
}

// The "Check inbox now" button. Exists so a demo does not have to wait out the poll interval.
app.post('/api/inbox/check', requireAuth, async (req, res) => {
  try {
    if (!mailIngestConfigured()) {
      return res.status(503).json({
        error: 'Email ingestion is not configured. Set INGEST_IMAP_HOST, INGEST_IMAP_USER and INGEST_IMAP_PASSWORD.',
      });
    }
    const result = await runIngestOnce();
    if (result.busy) return res.status(409).json({ error: 'A mailbox check is already running.' });
    res.json({ ...result.summary, rescored: result.rescored.length });
  } catch (error: any) {
    console.error('Error in POST /api/inbox/check:', error);
    res.status(502).json({ error: error.message || 'Could not reach the mailbox.' });
  }
});

// What the ingester has seen. Without this an email that named an account that does not
// exist would vanish: no review, nothing on screen, and no way to find out why.
app.get('/api/inbox', requireAuth, async (req, res) => {
  try {
    const rows = await prisma.ingestedEmail.findMany({
      orderBy: { processedAt: 'desc' },
      take: 20,
      include: { account: { select: { name: true } } },
    });
    res.json({
      configured: mailIngestConfigured(),
      mailbox: process.env.INGEST_IMAP_USER ?? null,
      subjectPrefix: process.env.INGEST_SUBJECT_PREFIX || 'RetainIO Feedback:',
      emails: rows.map(r => ({
        id: r.id,
        subject: r.subject,
        from: r.fromAddress,
        receivedAt: r.receivedAt.toISOString(),
        status: r.status,
        note: r.note,
        accountName: r.account?.name ?? null,
      })),
    });
  } catch (error: any) {
    console.error('Error in GET /api/inbox:', error);
    res.status(500).json({ error: 'Could not load the ingestion log.' });
  }
});

// Re-run the models for one account, on demand.
//
// The nightly pass already does this for everyone; this exists for the cases where waiting
// until 00:15 UTC is wrong — a review was just added or edited, a plan tier changed, or the
// model service was unreachable when the scheduled run happened and today has no score.
//
// It re-scores TODAY from the account's current usage row. It deliberately does NOT
// generate missing days: filling a gap invents telemetry, and that stays the scheduled
// job's business rather than something any Account Manager can trigger by clicking.
const RESCORE_COOLDOWN_MS = 30_000;
const lastRescoreAt = new Map<string, number>();

app.post('/api/accounts/:id/rescore', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // rescoreAccountToday upserts the fusion score but CREATES a churn and a sentiment
    // prediction row every call, so an impatient double-click leaves orphaned prediction
    // rows for the same day. The button is disabled while in flight; this is the guard for
    // everything that does not go through the button.
    const since = Date.now() - (lastRescoreAt.get(id) ?? 0);
    if (since < RESCORE_COOLDOWN_MS) {
      return res.status(429).json({
        error: `Just re-scored. Try again in ${Math.ceil((RESCORE_COOLDOWN_MS - since) / 1000)}s.`,
      });
    }

    const account = await prisma.account.findUnique({
      where: { id },
      include: { usageSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1 } },
    });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const usage = account.usageSnapshots[0];
    if (!usage) {
      return res.status(422).json({ error: `${account.name} has no usage reading to score.` });
    }

    lastRescoreAt.set(id, Date.now());
    const result = await rescoreAccountToday(id);

    // The date of the readings actually used, not just the date of the score. Re-scoring
    // over a three-day-old usage row produces a score dated today, and reporting only that
    // would tell someone their stale data had been refreshed when it had not.
    const usageDate = dateOnlyUTC(usage.capturedAt);
    const staleDays = daysAgo(usage.capturedAt);

    res.json({
      ...result,
      scoredAt: dateOnlyUTC().toISOString().substring(0, 10),
      usageCapturedAt: usageDate.toISOString().substring(0, 10),
      usageStaleDays: staleDays,
    });
  } catch (error: any) {
    console.error('Error in POST /api/accounts/:id/rescore:', error);
    res.status(502).json({ error: error.message || 'Could not re-score — the model service may be unavailable.' });
  }
});

app.post('/api/accounts/:id/renewal-intent', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = (req as any).userId as string;
    const { kind, targetTier } = req.body;

    // No `renewing`: contracts auto-renew, so renewing as-is is simply what happens when
    // nothing is recorded.
    const VALID_KINDS = ['upgrading', 'downgrading', 'churning'];
    if (!VALID_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of ${VALID_KINDS.join(', ')}.` });
    }

    const account = await prisma.account.findUnique({
      where: { id },
      include: { subscriptions: { orderBy: { termStart: 'desc' }, take: 1 } },
    });
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const sub = account.subscriptions[0];
    if (!sub) return res.status(422).json({ error: `${account.name} has no subscription to renew.` });
    if (sub.status === 'churned') {
      return res.status(409).json({ error: `${account.name} has already churned.` });
    }

    // A tier change has to say which tier, or the boundary has nothing to reprice to.
    const needsTier = kind === 'upgrading' || kind === 'downgrading';
    if (needsTier && !TIER_MONTHLY_RATE[targetTier as keyof typeof TIER_MONTHLY_RATE]) {
      return res.status(400).json({ error: 'A target plan tier is required for an upgrade or downgrade.' });
    }
    // And it has to go the way it says. Checking only that the tier differed let an
    // Enterprise account record an "upgrade" to Basic, which would then have resolved as
    // `upgraded` while repricing the account down.
    if (needsTier) {
      const direction = kind === 'upgrading' ? 'upgrade' : 'downgrade';
      const { upgrades, downgrades } = tierMoves(sub.planTier);
      const allowed = kind === 'upgrading' ? upgrades : downgrades;
      if (!allowed.includes(targetTier)) {
        return res.status(400).json({
          error: allowed.length
            ? `${account.name} is on ${sub.planTier} — it can ${direction} to ${allowed.join(' or ')}.`
            : `${account.name} is on ${sub.planTier}, so there is no plan to ${direction} to.`,
        });
      }
    }

    // One live intent per renewal: a later one supersedes rather than stacking, so the
    // job never has to guess which of two contradictory intents to believe.
    await prisma.renewalIntent.updateMany({
      where: { accountId: id, effectiveFor: sub.termEnd, cancelledAt: null, appliedAt: null },
      data: { cancelledAt: new Date() },
    });

    const intent = await prisma.renewalIntent.create({
      data: {
        accountId: id,
        kind,
        targetTier: needsTier ? targetTier : null,
        effectiveFor: sub.termEnd,
        source: 'manual',
        recordedById: userId,
      },
    });

    // Recording an intent is the moment the outcome became known. Freeze the account now
    // rather than waiting for the offer window: an account that gave notice at day 250 would
    // otherwise go unmeasured until day 180, seventy days into acting on its decision, and
    // its training row would describe that rather than the account as it stood.
    //
    // Always attempted, for all three kinds; the precedence rule in captureIndexSnapshot
    // decides whether it applies, so an account already frozen keeps its earlier snapshot.
    // Non-fatal, like the two approval paths: the intent is already saved, and losing the
    // training snapshot must not fail it.
    try {
      await captureIndexSnapshot(id, 'intent_recorded');
    } catch (err: any) {
      console.warn('Index snapshot failed after recording intent:', err.message || err);
    }

    res.json({ ok: true, intentId: intent.id, effectiveFor: intent.effectiveFor.toISOString() });
  } catch (error: any) {
    console.error('Error in POST /api/accounts/:id/renewal-intent:', error);
    res.status(500).json({ error: 'Failed to record the renewal intent.' });
  }
});

// Cancel a pending intent. The override the hold window exists to provide.
app.post('/api/renewal-intents/:id/cancel', requireAuth, async (req, res) => {
  try {
    const intent = await prisma.renewalIntent.findUnique({ where: { id: req.params.id } });
    if (!intent) return res.status(404).json({ error: 'Intent not found' });
    if (intent.appliedAt) {
      return res.status(409).json({
        error: 'This intent has already been applied at a renewal. Correct the renewal outcome instead.',
      });
    }
    await prisma.renewalIntent.update({ where: { id: intent.id }, data: { cancelledAt: new Date() } });
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error in POST /api/renewal-intents/:id/cancel:', error);
    res.status(500).json({ error: 'Failed to cancel the intent.' });
  }
});

// Correct a recorded outcome.
//
// Not optional. The cost of "silence means renewed" is that an unlogged departure is
// recorded as a renewal and trains as a positive label, so there has to be a way back:
// this reverses the term roll, so the subscription, its tier and its price all return to
// what they were before the renewal was resolved.
//
// Open to any signed-in Account Manager, not gated to Directors. The Manager is the one
// who actually knows what the customer did, and a correction that has to wait for a
// Director is a correction that does not get made — leaving a wrong label in the training
// data, which is the thing this endpoint exists to prevent. The edit is attributed
// (recordedById) and clears the autoRecorded flag, so who changed what stays visible.
// Contrast the discount endpoints, which ARE gated: those give away money, this fixes a
// record of something that already happened.
app.post('/api/renewals/:id/correct', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).userId as string;
    const { outcome } = req.body;

    const VALID = ['renewed', 'upgraded', 'downgraded', 'left'];
    if (!VALID.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of ${VALID.join(', ')}.` });
    }

    const record = await prisma.renewalRecord.findUnique({
      where: { id: req.params.id },
      include: { account: { include: { subscriptions: { orderBy: { termStart: 'desc' }, take: 1 } } } },
    });
    if (!record) return res.status(404).json({ error: 'Renewal record not found' });
    if (record.outcome === outcome) return res.json({ ok: true, unchanged: true });

    const sub = record.account.subscriptions[0];
    if (!sub) return res.status(422).json({ error: 'That account has no subscription to correct.' });

    const wasRetained = isRetained(record.outcome);
    const nowRetained = isRetained(outcome as any);

    const data: any = {};
    if (wasRetained && !nowRetained) {
      // Renewed -> left. Undo the roll: the term goes back to ending at the renewal, the
      // tier and price return to what they were before it, and the account is churned.
      // The discount stamped for that renewal reverts to `offered` on its own, because
      // its start date is once again in the future.
      data.termStart = addMonths(record.renewalDate, -MONTHS_PER_TERM);
      data.termEnd = record.renewalDate;
      data.planTier = record.planTierBefore;
      data.mrr = TIER_MONTHLY_RATE[record.planTierBefore as keyof typeof TIER_MONTHLY_RATE];
      data.status = 'churned';
    } else if (!wasRetained && nowRetained) {
      // Left -> renewed. Roll the term forward after all and reinstate the subscription.
      data.termStart = record.renewalDate;
      data.termEnd = addMonths(record.renewalDate, MONTHS_PER_TERM);
      data.planTier = record.planTierAfter;
      data.mrr = TIER_MONTHLY_RATE[record.planTierAfter as keyof typeof TIER_MONTHLY_RATE];
      data.status = 'active';
    }

    await prisma.$transaction([
      prisma.renewalRecord.update({
        where: { id: record.id },
        data: {
          outcome: outcome as any,
          retained: nowRetained,
          // No longer an unreviewed default: a person has now looked at this row.
          autoRecorded: false,
          recordedById: userId,
        },
      }),
      ...(Object.keys(data).length ? [prisma.subscription.update({ where: { id: sub.id }, data })] : []),
    ]);

    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error in POST /api/renewals/:id/correct:', error);
    res.status(500).json({ error: 'Failed to correct the renewal outcome.' });
  }
});

// Real causal uplift prediction — replaces the frontend's old hand-typed
// computeSimulatedCate() formula. Assembles the uplift model's 12 real
// features from this account's actual subscription/usage/churn/sentiment/
// fusion rows and calls model_service's /predict/uplift (the real trained
// X-learner over 13 arms, models/uplift_pooled_t_duration.pkl). Returns 422 rather than
// fabricating a number if the account doesn't have real data for all 12
// features yet (e.g. no sentiment_prediction on its latest review).
// What the review is actually about, read by Gemini from the text.
//
// This was a keyword substring match in the browser (AccountAnalysisPage's old
// classifyReviewLocal), which tied on anything like "the API is too expensive"
// and silently fell through to "technical". The prompt below is the one from
// scratch_decision_matrix.py, which prototyped exactly this and was never
// wired in.
//
// Cached on the review row: the text never changes, so re-classifying on every
// page load would be a paid call for a guaranteed-identical answer. Falls back
// to 'general' rather than throwing — the category only steers which lever is
// recommended, and losing it must not take down the whole uplift panel.

// Runs the uplift model for one account and returns its prediction plus the
// Gemini review category. Shared by the analysis page's endpoint below and the
// advisor chatbot's get_uplift_recommendation tool, so both see identical
// numbers rather than two drifting implementations.
//
// Throws UpliftError with an http status the endpoint can pass straight
// through; the chat tool catches it and degrades to a sentence instead.
class UpliftError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

async function computeUpliftForAccount(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      subscriptions: { orderBy: { termStart: 'desc' }, take: 1 },
      usageSnapshots: { orderBy: { capturedAt: 'desc' }, take: 1 },
      customerReviews: {
        orderBy: { submittedAt: 'desc' },
        take: 1,
        include: { sentimentPredictions: { orderBy: { predictedAt: 'desc' }, take: 1 } },
      },
      fusionScores: {
        orderBy: { computedAt: 'desc' },
        take: 1,
        include: { churnPrediction: { include: { shapExplanations: true } } },
      },
    },
  });
  if (!account) throw new UpliftError('Account not found', 404);

  const sub = account.subscriptions[0];
  const usage = account.usageSnapshots[0];
  const sentiment = account.customerReviews[0]?.sentimentPredictions[0];
  const fusion = account.fusionScores[0];
  const churn = fusion?.churnPrediction;

  if (!sub || !usage || !sentiment || sentiment.riskWeight == null || !fusion || !churn) {
    throw new UpliftError(
      `${account.name} doesn't have enough real data yet for the uplift model — needs a subscription, usage snapshot, sentiment prediction with a risk weight, and a churn/fusion score.`,
      422,
    );
  }

  const riskBandShort = RISK_BAND_LABEL[churn.riskBand].replace(' Risk', '');

  // Why this account is at risk, in the two categories the uplift model was trained
  // on. It decides the SHAPE of the best offer - a price-led account wants a short
  // sharp discount, technical friction wants a longer sustained one - so without it
  // the model cannot rank durations at all.
  //
  // Read from the Gemini review classification already stored on the review, falling
  // back to the strongest SHAP driver when a review has not been classified yet.
  // Shared with renewals.ts, which freezes the same value onto a training row — two
  // copies of this rule would let a stored row and a live prediction disagree.
  const dominantDriver = deriveDominantDriver(
    account.customerReviews[0]?.reviewCategory,
    churn.shapExplanations,
  );

  const features = {
    Account_Age_Days: usage.accountAgeDays,
    Daily_Usage_Mins: usage.dailyUsageMins,
    Support_Tickets_90Days: usage.supportTickets90Days,
    API_Utilization_Rate: usage.apiUtilizationRate,
    churn_proba: churn.churnProba,
    // uplift_model.ipynb's training data has sentiment_score on a 0..1 scale
    // where HIGHER = more frustrated/risky (High-risk accounts average 0.82,
    // Low-risk average 0.02 — see Datasets/uplift_observational.csv). That's
    // riskWeight's exact scale and direction, not the old -1..1 `score`
    // (which pointed the opposite way — higher meant more satisfied).
    sentiment_score: sentiment.riskWeight,
    fused_proba: fusion.fusionScore / 100,
    Login_Frequency: usage.loginFrequencyBucket,
    Plan_Tier: sub.planTier,
    risk_band: riskBandShort,
    // MRR and Days_To_Renewal were dropped when the model was retrained: under
    // standardised tier pricing MRR is a one-to-one relabelling of Plan_Tier, and
    // Days_To_Renewal is a calendar position rather than an account attribute.
    Dominant_SHAP_Driver: dominantDriver,
  };

  let r: Response;
  try {
    r = await fetch(`${MODEL_SERVICE_URL}/predict/uplift`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(features),
    });
  } catch (bridgeErr: any) {
    // Genuinely couldn't reach model_service (not running, wrong port,
    // network). This is the one case where "service unavailable" is the
    // honest message — unlike a catch-all, which would report every failure
    // this way and so hide real bugs behind a fake outage.
    console.error('Uplift bridge unreachable:', bridgeErr);
    throw new UpliftError(`Could not reach the uplift model service at ${MODEL_SERVICE_URL}. Is model_service running?`, 502);
  }
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    console.error(`Uplift bridge returned ${r.status}:`, detail);
    throw new UpliftError(`The uplift model returned an error (${r.status}).`, 502);
  }

  const data = await r.json();
  const reviewCategory = await classifyReviewCategory(account.customerReviews[0]);
  return { ...data, review_category: reviewCategory, account_name: account.name, mrr: Number(sub.mrr) };
}

app.get('/api/accounts/:id/uplift', requireAuth, async (req, res) => {
  try {
    res.json(await computeUpliftForAccount(req.params.id));
  } catch (error: any) {
    if (error instanceof UpliftError) return res.status(error.status).json({ error: error.message });
    console.error('Error in GET /api/accounts/:id/uplift:', error);
    res.status(500).json({ error: error.message || 'Failed to compute an uplift prediction.' });
  }
});

// Start Express Server with Vite Middleware
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`RetainIO Server running on http://0.0.0.0:${PORT}`);
  });

  // Real daily fusion snapshot — idempotent (a no-op if today's row already
  // exists), so this is safe to run on every boot. Once this is hosted
  // somewhere continuously alive (Render or similar), this interval is what
  // actually gives every account a real score every day; run locally, it
  // just captures "today" whenever the dev server happens to be open, and
  // any day it wasn't open is left as a genuine gap rather than guessed at.
  const runSnapshotSafely = async () => {
    // Simulated telemetry, OFF unless explicitly switched on. A background job that
    // quietly invents usage readings — which everything downstream would then treat as
    // measured — should never be the default; it runs because someone chose it.
    // Imported dynamically so the simulator is not loaded at all when unused.
    if (process.env.SIMULATE_USAGE === 'true') {
      try {
        const { fillUsageGaps } = await import('./prisma/simulate-usage');
        // Fills every day since the last reading, not just today. This machine is a laptop
        // that gets shut; advancing a single day would leave every day it was closed
        // permanently blank, because the next run sees the account as already current and
        // never goes back for them.
        const r = await fillUsageGaps();
        if (r.skipped) console.warn(`Simulated usage skipped — ${r.skipped}.`);
        // Calendar days first, readings second. Reporting only the row count made nine
        // accounts that were two days behind read as "18 day(s) filled".
        else if (r.days) console.log(`Simulated usage: ${r.days} day(s) filled, ${r.accountDays} readings, ${r.scored} scored (SIMULATE_USAGE=true).`);
      } catch (err: any) {
        console.warn('Usage simulation skipped:', err.message || err);
      }
    }

    try {
      const summary = await runDailySnapshotForToday();
      console.log(`Daily fusion snapshot (${summary.date}): ${summary.succeeded} computed, ${summary.skipped} already done, ${summary.errors.length} failed.`);
      if (summary.errors.length) console.warn('Daily snapshot errors:', summary.errors);
    } catch (err: any) {
      console.warn('Daily fusion snapshot skipped — model service or database unavailable:', err.message || err);
    }

    // Renewals are resolved in the same pass, but in their own try: the fusion snapshot
    // needs the Python model service, and renewals need nothing but the database. A
    // model service that happens to be down must not stop contracts from renewing.
    // Freeze the pre-treatment state of any account that has just entered its offer
    // window. Runs BEFORE the renewal pass: an account reaching its renewal today should
    // already have been frozen months ago, and this ordering makes that explicit.
    try {
      const frozen = await captureDueIndexSnapshots();
      if (frozen.length) console.log(`Index snapshots: froze ${frozen.length} account(s) entering the offer window.`);
    } catch (err: any) {
      console.warn('Index snapshot pass skipped:', err.message || err);
    }

    try {
      const r = await runRenewalsForToday();
      if (r.processed.length || r.errors.length) {
        console.log(
          `Renewals: ${r.processed.length} resolved, ${r.skipped} already recorded, ${r.errors.length} failed.` +
          r.processed.map(p => `\n  ${p.account} ${p.renewalDate} -> ${p.outcome}${p.autoRecorded ? ' (auto)' : ''}`).join('')
        );
      }
      if (r.errors.length) console.warn('Renewal errors:', r.errors);
    } catch (err: any) {
      console.warn('Renewal pass skipped — database unavailable:', err.message || err);
    }
  };
  // Runs at a FIXED time each day rather than on an interval counted from boot.
  //
  // It used to be setInterval(6h), which fires six hours after whenever the process last
  // started — so the time of day drifted with every restart and every deploy, and there was
  // no hour you could point at and say "that is when accounts update". 00:15 UTC is just
  // after the date rolls over, and snapshotDate is keyed on UTC, so each day is captured at
  // the start of the day it belongs to.
  const DAILY_RUN_UTC = { hour: 0, minute: 15 };

  function msUntilNextDailyRun(now = new Date()): number {
    const next = new Date(now);
    next.setUTCHours(DAILY_RUN_UTC.hour, DAILY_RUN_UTC.minute, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime() - now.getTime();
  }

  // setTimeout re-armed after each run, never setInterval(24h): a 24-hour interval drifts
  // against the wall clock and never re-aligns, so recomputing the next 00:15 each time is
  // what keeps it pinned to the hour.
  function scheduleDailyRun() {
    const wait = msUntilNextDailyRun();
    console.log(`Next daily update at 00:15 UTC — in ${Math.round(wait / 60000)} minute(s).`);
    setTimeout(async () => {
      await runSnapshotSafely();
      scheduleDailyRun();
    }, wait);
  }

  // On boot as well: every deploy restarts this process, and a deploy at 09:00 would
  // otherwise skip that day entirely. Safe to repeat — fillUsageGaps only fills days that
  // are missing and the fusion snapshot skips accounts already scored today.
  runSnapshotSafely();
  scheduleDailyRun();

  // Safety net, and cheap: if the timer above is ever missed, this repairs the day without
  // waiting for a restart. When the day is already done it costs one indexed lookup per
  // account and stops, so it does no work on the three passes that find nothing to do.
  setInterval(runSnapshotSafely, 6 * 60 * 60 * 1000);

  // Expired sessions are already refused by requireAuth, but nothing deleted
  // them — the table only ever grew. Swept on boot and hourly thereafter.
  const pruneSessionsSafely = async () => {
    try {
      const removed = await pruneExpiredSessions();
      if (removed > 0) console.log(`Pruned ${removed} expired session(s).`);
    } catch (err: any) {
      console.warn('Session prune skipped — database unavailable:', err.message || err);
    }
  };
  pruneSessionsSafely();
  setInterval(pruneSessionsSafely, 60 * 60 * 1000);

  // Mail ingestion, off entirely unless a mailbox is configured. A feature that reaches into
  // someone's inbox should run because they set it up, not because the server started.
  //
  // Its own timer rather than a phase of runSnapshotSafely: that runs every six hours, which
  // for "did a customer just email us" is the wrong cadence by two orders of magnitude.
  if (mailIngestConfigured()) {
    const pollInbox = async () => {
      try {
        const result = await runIngestOnce();
        if (result.busy) return;
        const s = result.summary;
        if (s.ingested || s.unmatched || s.failed) {
          console.log(`Inbox: ${s.ingested} review(s) ingested, ${s.unmatched} unmatched, ` +
                      `${s.failed} failed, ${result.rescored.length} account(s) re-scored.`);
          for (const note of s.notes) console.log(`  ${note}`);
        }
      } catch (err: any) {
        console.warn('Inbox check skipped:', err.message || err);
      }
    };
    console.log(`Watching ${process.env.INGEST_IMAP_USER} for "${process.env.INGEST_SUBJECT_PREFIX || 'RetainIO Feedback:'}" every 2 minutes.`);
    pollInbox();
    setInterval(pollInbox, 2 * 60 * 1000);
  }
}

startServer();
