import type { DiscountState, PlanTierName } from '../pricing';
export type { DiscountState, PlanTierName };

// Deliberately excludes the database's `system` role. That row is not a person and is
// filtered out of every user list the server sends, so a UserProfile should never carry
// it — it exists only to be named as the actor on automatic audit entries.
export type UserRole = 'account_manager' | 'account_director' | 'admin';

export interface UserProfile {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  title: string;
  department: string;
  employeeId: string;
  biometricStatus: string;
  maxSelfApprovalLimit: number;
  // Whether this user has actually enrolled a face (Directors do so at signup).
  faceEnrolled?: boolean;
  avatarInitials: string;
  // Account Managers only: which Director they report to, set by an admin.
  directorId?: string;
  directorName?: string;
  // False once an admin revokes access. The login stops working immediately,
  // but the user's history stays intact and still names them.
  isActive?: boolean;
}

export type RenewalOutcome = 'renewed' | 'upgraded' | 'downgraded' | 'left';
// No `renewing`: contracts auto-renew, so renewing as-is needs no intent at all.
export type IntentKind = 'upgrading' | 'downgrading' | 'churning';

// What an account is expected to do at its next renewal, recorded ahead of time.
// Recording one changes NOTHING about the account: it is held until the renewal date and
// resolved there by the daily job, which is why it can be cancelled right up to it.
export interface RenewalIntent {
  id: string;
  accountId: string;
  accountName: string;
  kind: IntentKind;
  targetTier?: PlanTierName;   // set for upgrading/downgrading
  effectiveFor: string;        // ISO; the renewal it resolves at
  source: 'manual' | 'email';
  recordedBy: string | null;   // null when a machine recorded it
  recordedAt: string;
}

// What actually happened at a renewal — the labelled row the models train on.
export interface RenewalRecord {
  id: string;
  accountId: string;
  accountName: string;
  renewalDate: string;         // YYYY-MM-DD
  outcome: RenewalOutcome;
  retained: boolean;
  // True when the job defaulted to `renewed` because no intent existed and nobody
  // confirmed. Shown in the UI rather than hidden: an assumed outcome is a weaker fact
  // than a recorded one, and the training export carries the same flag for the same reason.
  autoRecorded: boolean;
  recordedBy: string | null;
  recordedAt: string;
  predictedRisk: number | null;  // what the model said before the outcome was known
  // The band that risk fell into, from the server's canonical fusionRiskCategory rather
  // than re-derived here — the UI must not own a second copy of the thresholds.
  predictedBand: 'High Risk' | 'Medium Risk' | 'Low Risk' | null;
  discountPct: number;
  discountMonths: number;
  planTierBefore: PlanTierName;
  planTierAfter: PlanTierName;
}

export interface DiscountRequest {
  id: string;
  accountId: string;
  accountName: string;
  mrr: number;
  requestedDiscountPct: number;
  // How many months of the upcoming term the requested discount covers.
  requestedDurationMonths: number;
  requestedBy: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  // The Account Manager's justification — always present, since a request row
  // only exists for a >10% escalation that a Director has to judge.
  managerNote: string;
  directorNote?: string;
  riskScore: number;
  facialVerificationRequired: boolean;
  approvedAt?: string;
  approvedBy?: string;
  includesWalkthrough?: boolean;
}

export type RiskCategory = 'High Risk' | 'Medium Risk' | 'Low Risk';

// The real trained sentiment model (models/sentiment_naive_bayes.pkl) only
// ever outputs these 3 classes — confirmed against sentiment_tickets.csv and
// all three train/test/validation splits.
export type SentimentType = 'Frustrated' | 'Neutral' | 'Satisfied';

export interface ShapFactor {
  feature: string;
  impact: number; // e.g. +18% risk or -12% risk
  description: string;
  direction: 'risk_increase' | 'risk_decrease';
}

export interface Account {
  id: string;
  name: string;
  logo: string;
  industry: string;
  // The LIST rate — what the plan tier costs before any discount. Every offer is
  // priced off this (giveback, the Manager's cap, the Director threshold), so it must
  // stay the undiscounted figure or a second discount would compound against the first.
  mrr: number; // e.g. 10000
  // What the account actually bills at right now: the list rate unless a discount is
  // currently running, and ZERO once it has churned. Revenue reporting reads this, so
  // zeroing it is what keeps a departed customer out of every portfolio and at-risk
  // total; offer pricing reads `mrr`, which stays the list rate.
  effectiveMrr: number;
  // 'churned' once a renewal recorded the account as having left. Nothing set this before
  // renewals were captured, so every account was permanently 'active'.
  subscriptionStatus: 'active' | 'renewed' | 'churned' | 'cancelled';
  subscriptionType: PlanTierName;
  contractRenewalDate?: string;
  contractDurationMonths?: number;
  accountManager: string;
  
  // 1. Churn Prediction Model Inputs & Score
  // These are the model's actual six features, read from usage_snapshots and
  // subscriptions. The previous loginFrequency / loginBenchmark /
  // apiUsageRate / apiBenchmark / featureAdoptionRate / activeUsers /
  // totalSeats / recentNegativeTickets / *ChangePct fields had no column
  // behind them — they came from mockData.ts and were invented.
  accountAgeDays?: number;        // Account_Age_Days
  dailyUsageMinutes?: number;     // Daily_Usage_Mins
  supportTicketCount?: number;    // Support_Tickets_90Days
  loginFrequencyBucket?: 'Daily' | 'Weekly' | 'Rarely'; // Login_Frequency
  apiUtilizationRate?: number;    // API_Utilization_Rate, 0..1
  churnModelScore: number; // 0 - 100%

  // 2. Sentiment Analysis Model
  sentimentRiskWeight?: number; // 0.0 to 1.0, the real value the fusion model consumes
  sentimentClassification: SentimentType;
  // What the customer actually wrote - the text the sentiment model classified.
  reviewText?: string;
  reviewId?: string;
  // A person's judgement of the review's true sentiment, recorded when they disagree with
  // the model. It WINS: sentimentClassification, sentimentRiskWeight and the fusion score
  // are all recomputed from it, because the account's risk — and the uplift model's
  // discount recommendation, which reads sentiment_score — would otherwise stay built on
  // a reading somebody has established is wrong. Nothing is hidden by that: modelSentiment
  // keeps the model's own answer on screen beside it.
  //
  // Also the only signal that can retrain the sentiment model. Renewal outcomes cannot: a
  // furious customer can still renew, and the fusion model needs sentiment to stay
  // independent of churn risk rather than becoming a second churn predictor.
  correctedSentiment?: SentimentType;
  correctedSentimentBy?: string;
  // What the MODEL read, kept separate from sentimentClassification (which is the
  // effective reading — the correction when one exists). Both are shown so an override is
  // visible as an override rather than silently replacing the prediction.
  modelSentiment?: SentimentType;

  // 3. Fusion Model
  fusionRiskScore: number; // 0 - 100%
  riskCategory: RiskCategory;
  riskTrend: 'increasing' | 'stable' | 'decreasing';
  riskHistory?: number[]; // e.g. [45, 52, 60, 70, 78, 85] over 6 time points

  // 4. Explainable AI
  shapFactors: ShapFactor[];
  geminiExplanationSummary?: string;

  // Freshness. Both optional and both YYYY-MM-DD:
  //   scoredAt        when these predictions were computed
  //   usageCapturedAt when the readings they were computed FROM were taken
  // They differ when an account is re-scored over an older usage row, and the UI has to be
  // able to say which one it is talking about.
  //
  // Optional deliberately: an account with no prediction has neither, and typing a
  // sometimes-absent field as always-present is what took the whole app down when
  // shapFactors above came back undefined.
  scoredAt?: string;
  usageCapturedAt?: string;

  // Retention / Discount State
  currentDiscountApproved: number; // e.g. 0 or 10
  // Months of the term that discount covers. 0 when no discount is applied.
  currentDiscountMonths: number;
  // Where the discount is in its life. A discount is approved before the renewal it
  // applies to, runs for its months into the new term, then ends — states the UI used
  // to collapse into "Active" from the moment of approval. Derived server-side by
  // discountStatus() in pricing.ts; `discountLabel` is the one wording for all of them.
  discountState: DiscountState;
  discountStartsAt?: string;  // ISO; the renewal it takes effect at
  discountEndsAt?: string;    // ISO; startsAt + currentDiscountMonths, never stored
  discountLabel: string;
  actionStatus: 'No Action' | 'Discount Recommended' | 'Pending Director Approval' | 'Discount Approved' | 'Retention Email Sent' | 'Escalated';
  // When a walkthrough was last offered to this account, and by whom.
  //
  // There is NO limit on how often one can be offered and no cooling-off period: a
  // walkthrough costs nothing, so there is no spend to control, and an arbitrary block
  // would refuse a legitimate second session. The Manager gets the fact and makes the call.
  lastWalkthroughAt?: string;
  lastWalkthroughBy?: string;
}

export interface AuditLog {
  id: string;
  accountId: string;
  accountName: string;
  timestamp: string;
  action: string;
  discountApplied: number;
  approver: string;
  // 'System' appears on rows written automatically — a renewal resolved at its term
  // boundary. Those genuinely have no human approver, and naming the system actor is
  // how the ledger says so without borrowing a real person's name.
  approverRole: 'Account Manager' | 'Account Director' | 'System';
  // Free text on the server; the '(≤10%)' variant was replaced when approval moved
  // from a percentage rule to a share of annual contract value.
  verificationStatus: string;
  details: string;
}

export interface ToolCallLog {
  // Display name from server.ts's TOOL_DISPLAY_NAMES. Was a closed union that
  // had already drifted from what the server sends ('Historical Case RAG (Chroma)'
  // vs 'Historical Case RAG') and could not admit new tools.
  toolName: string;
  args: Record<string, any>;
  output: string;
  timestamp: string;
}

// What the advisor can put in front of an Account Manager: a recommendation
// and a link into the real Retention Offer flow. Nothing here executes.
//
// Previously this also declared 'direct_action', 'email_preview' with an
// emailDraft body, and statuses 'approved' | 'modified' | 'sent' - none of
// which anything ever produced. They were left over from an in-chat email
// drafting flow that no longer exists, and made the card look capable of
// actions it has no code path for.
export interface ActionCardData {
  type: 'recommendation';
  discountPct: number;
  accountId?: string;
  accountName?: string;
  status?: 'pending';
}

export interface AdvisorMessage {
  id: string;
  sender: 'user' | 'advisor' | 'system';
  text: string;
  timestamp: string;
  toolCalls?: ToolCallLog[];
  actionCard?: ActionCardData;
  // Figures the answer stated that no tool in that turn produced. Empty or
  // absent means every number traced back to a tool output.
  ungroundedFigures?: string[];
}

export interface HistoricalCase {
  id: string;
  companyName: string;
  industry: string;
  initialRisk: number;
  primaryIssue: string;
  actionTaken: string;
  outcome: 'Retained (Renewed Full Term)' | 'Retained (Upsold)' | 'Churned';
  learnings: string;
}
