import React, { useState, useEffect } from 'react';
import {
  MONTHS_PER_TERM, givebackValue, selfApprovalCap, discountedTermValue,
  needsDirectorApproval, describeDiscount, formatMoney, blocksNewOffer, formatTermDate, addMonths,
  OFFER_WINDOW_DAYS, daysUntil, daysAgo, OFFER_PCTS, OFFER_MONTHS, discountsOpen,
} from '../../pricing';
import { Account, UserProfile, DiscountRequest, RenewalIntent, OfferResult } from '../types';
import { FaceVerificationModal } from './FaceVerificationModal';
import { DiscountEmailModal } from './DiscountEmailModal';
import { isChurned } from '../accountStatus';
import { RiskSparkline } from './RiskSparkline';
import { useToast } from './Toast';
import { 
  ArrowLeft, 
  TrendingUp, 
  TrendingDown, 
  Sparkles, 
  ExternalLink, 
  ShieldCheck, 
  CheckCircle2, 
  Search, 
  Zap, 
  Bot, 
  User, 
  AlertTriangle,
  FileText,
  Activity,
  Layers,
  Globe,
  DollarSign,
  Clock,
  ChevronRight,
  ShieldAlert,
  Building2,
  Mail,
  Send,
  MessageSquare,
  XCircle,
  Wrench,
  Percent,
  Flag,
  Gauge,
  RefreshCw
} from 'lucide-react';

// ── Discount Uplift Advisor ────────────────────────────────────────────────
// The CATE (causal uplift) number and the recommended offer come from the real
// trained model (models/uplift_pooled_t_duration.pkl) via GET /api/accounts/:id/uplift.
// It scores 12 (percentage x duration) combinations plus a no-discount control from
// 11 account features; the recommendation is whichever has the greatest lift over
// doing nothing. The learner type and depth are re-selected on validation Qini every
// time uplift_model.ipynb runs, so this is currently a depth-4 X-learner but the
// service reads either shape.
//
// That model never sees the review text, only structured numbers. The category
// below is Gemini's read of what the customer actually wrote, classified
// server-side and cached on the review row - it replaces a keyword substring
// match that ran here in the browser and tied on phrases like "the API is too
// expensive".

type ReviewCategory = 'technical' | 'price' | 'general';

interface UpliftPrediction {
  review_category: ReviewCategory;
  baseline_retention: number;
  // Every (percentage, duration) combination the model scored — 12 of them. The
  // model does not predict a discount; it predicts retention under each option, and
  // the recommendation is whichever has the greatest lift over doing nothing.
  grid: { discount_pct: number; discount_months: number; predicted_retention: number; cate: number }[];
  best_pct: number;
  best_months: number;
  best_cate: number;
}

interface UpliftDecision {
  category: ReviewCategory;
  helps: boolean;
  action: 'Discount + Walkthrough' | 'Discount Only' | 'Walkthrough Only' | 'Flag for Human Review' | 'Do Nothing';
}

// The recommendation is the uplift model's own output and nothing else: it
// predicts retention under each (percentage, duration) combination; best_pct and
// best_months are the pairing with the largest lift over no discount, and best_cate
// is that lift. A positive lift
// means the model expects the discount to improve retention.
//
// No cost rule is applied on top. Worth knowing what that implies: the model
// is trained on retention, not profit, so it has no way to know a 20% discount
// costs 20% of revenue. Mean lift rises with every tier (+0.12 at 5% up to
// +0.28 at 20%), so it reaches for the largest lever - it picks 20% for 57% of
// accounts, and predicts some discount helps for about 99% of the accounts
// that reach this panel. That is the model answering the question it was
// trained on, not a bug.
//
// A previous version gated this on CATE > d*p0/(1-d) - whether the retention
// bought beats the revenue given away - which is the standard cost layer for
// an uplift policy. Removed deliberately to keep the recommendation purely
// model-driven. The principled way to fold cost back in is to retrain on a
// profit target, retention * (1-d) * MRR, rather than to re-add a rule here.
function decideUpliftAction(category: ReviewCategory, bestCate: number): UpliftDecision {
  const helps = bestCate > 0;

  let action: UpliftDecision['action'];
  if (category === 'technical') action = helps ? 'Discount + Walkthrough' : 'Walkthrough Only';
  else if (category === 'price') action = helps ? 'Discount Only' : 'Flag for Human Review';
  else action = helps ? 'Discount Only' : 'Do Nothing';

  return { category, helps, action };
}




interface AccountAnalysisPageProps {
  account: Account;
  currentUser?: UserProfile;
  discountRequests?: DiscountRequest[];
  initialTab?: 'fusion' | 'shap' | 'uplift' | 'discount';
  onBack: () => void;
  onDiscussWithAdvisor: (account: Account) => void;
  // Records a person's disagreement with the sentiment model. Passing null withdraws a
  // correction rather than leaving a label somebody no longer stands behind in training.
  onCorrectSentiment: (reviewId: string, sentiment: 'Frustrated' | 'Neutral' | 'Satisfied' | null) => void | Promise<void>;
  onApplyDiscount: (
    account: Account,
    discountPct: number,
    verificationStatus: 'Direct Approval (Within Manager Limit)' | 'Face Verified (Biometric Pass)',
    snapshot?: string,
    managerNote?: string,
    includeWalkthrough?: boolean,
      discountMonths?: number
    ) => Promise<OfferResult>;
    // Resolves with the offer row the approval wrote, which the offer email then names.
    onApproveDiscountRequest?: (requestId: string, matchedName?: string) => Promise<OfferResult>;
  onRejectDiscountRequest?: (requestId: string, reason: string) => void;
  // Reload after an on-demand re-score, so the panel shows the numbers that were just
  // written rather than the ones it was rendered with.
  onRescored?: () => void;
  // Live intents only — /api/bootstrap filters out cancelled and applied ones already.
  renewalIntents?: RenewalIntent[];
  onIntentCancelled?: () => void;
  // Reload after a scheduled discount or a pending request is withdrawn, so the form unlocks.
  onDiscountWithdrawn?: () => void;
}

export const AccountAnalysisPage: React.FC<AccountAnalysisPageProps> = ({
  account,
  currentUser,
  discountRequests = [],
  initialTab,
  onBack,
  onDiscussWithAdvisor,
  onCorrectSentiment,
  onApplyDiscount,
  onApproveDiscountRequest,
  onRejectDiscountRequest,
  onRescored,
  renewalIntents = [],
  onIntentCancelled,
  onDiscountWithdrawn
}) => {
  const [activeTab, setActiveTab] = useState<'fusion' | 'shap' | 'uplift' | 'discount'>(initialTab || 'fusion');
  // How many SHAP factors the user wants visible. The API returns every
  // feature the model scored (strongest first), so this is purely a display
  // slice — no refetch needed when it changes.
  const [shapVisibleCount, setShapVisibleCount] = useState<number>(5);
  const [selectedDiscount, setSelectedDiscount] = useState<number>(10);
  // How many months of the upcoming term the discount covers. A discount without a
  // duration cannot be costed, which is why approval used to gate on the percentage.
  const [selectedMonths, setSelectedMonths] = useState<number>(MONTHS_PER_TERM);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [includeWalkthrough, setIncludeWalkthrough] = useState<boolean>(false);
  const [showFaceModal, setShowFaceModal] = useState<boolean>(false);
  const [showDirectorPrompt, setShowDirectorPrompt] = useState<boolean>(false);


  // Notes & Director Request State
  const [managerNote, setManagerNote] = useState<string>('');
  const [directorNote, setDirectorNote] = useState<string>('');
  const [pendingDirectorRequest, setPendingDirectorRequest] = useState<{
    discountPct: number;
    discountMonths?: number;
    managerNote: string;
    requestedAt: string;
    status: 'pending' | 'approved' | 'rejected';
    directorNote?: string;
    includesWalkthrough?: boolean;
  } | null>(null);

  // Email Offer Review Modal State
  const [showEmailModal, setShowEmailModal] = useState<boolean>(false);
  const [emailVerificationStatus, setEmailVerificationStatus] = useState<'Direct Approval (Within Manager Limit)' | 'Face Verified (Biometric Pass)'>('Direct Approval (Within Manager Limit)');
  const [isRequestBannerDismissed, setIsRequestBannerDismissed] = useState<boolean>(false);
  const [isRescoring, setIsRescoring] = useState<boolean>(false);

  const { showToast } = useToast();
  const isDirector = currentUser?.role === 'account_director';

  // How stale the displayed numbers are, in whole days.
  //
  // daysAgo, not daysUntil: scoredAt is a date-only value, and comparing it against the
  // current instant made a score written this morning read as a day old by the afternoon,
  // which would have turned the badge amber a full day early. Shared with the server so the
  // two cannot disagree — this codebase has already had two competing "days to renewal"
  // implementations drift apart.
  const scoreAgeDays = account.scoredAt ? daysAgo(account.scoredAt) : null;
  const isScoreStale = scoreAgeDays !== null && scoreAgeDays >= 2;

  // Re-runs the models for this account only, against its CURRENT usage reading. It does
  // not generate missing days — that stays with the scheduled job, because filling a gap
  // means inventing telemetry.
  const handleRescore = async () => {
    if (isRescoring) return;
    setIsRescoring(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}/rescore`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Could not re-score this account.', 'error');
        return;
      }
      // Says which readings were used, not just that something ran. Re-scoring over an old
      // usage row produces a score dated today, and reporting only that would tell someone
      // their stale data was refreshed when the underlying readings had not moved at all.
      showToast(
        data.usageStaleDays > 0
          ? `Re-scored, but using readings from ${formatTermDate(data.usageCapturedAt)} — ${data.usageStaleDays} day(s) of telemetry are missing.`
          : `Re-scored against today's readings. Fusion risk ${data.fusionScore}/100.`,
        data.usageStaleDays > 0 ? 'info' : 'success',
      );
      // The parent owns reloading, and its refreshData re-points the open panel at the
      // refreshed account — the fix that stopped every action leaving a stale panel behind.
      onRescored?.();
    } catch {
      showToast('Could not reach the server to re-score.', 'error');
    } finally {
      setIsRescoring(false);
    }
  };

  // The intent for THIS renewal, not merely for this account: one filed against a later
  // renewal cycle must not surface against the term being discounted. Bootstrap sends live
  // intents only, so there is no cancelled/applied state to filter here.
  const liveIntent = renewalIntents.find(
    i => i.accountId === account.id && i.effectiveFor.substring(0, 10) === account.contractRenewalDate,
  ) ?? null;
  const [isCancellingIntent, setIsCancellingIntent] = useState<boolean>(false);

  // The same call RenewalsView makes, so there is one way to cancel an intent rather than two.
  const handleCancelIntent = async () => {
    if (!liveIntent || isCancellingIntent) return;
    setIsCancellingIntent(true);
    try {
      const res = await fetch(`/api/renewal-intents/${liveIntent.id}/cancel`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || 'Could not cancel the intent.', 'error'); return; }
      showToast(`Intent cancelled. ${account.name} will renew as-is unless a new one is recorded.`, 'success');
      onIntentCancelled?.();
    } catch {
      showToast('Could not reach the server to cancel the intent.', 'error');
    } finally {
      setIsCancellingIntent(false);
    }
  };

  // Check for active or previous discount request for this account
  // The request the banner and the Approve / Withdraw buttons act on: the one still waiting, if
  // there is one, otherwise the most recent. Asked for explicitly rather than taking the first of
  // the account's requests: that was only right because the server happens to send them newest
  // first, and a change of order would have put an old, decided request here without any error.
  const accountRequests = discountRequests
    .filter(r => r.accountId === account.id)
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  const globalReq = accountRequests.find(r => r.status === 'pending') ?? accountRequests[0];
  const activeDirectorRequest = pendingDirectorRequest || (globalReq ? {
    discountPct: globalReq.requestedDiscountPct,
    managerNote: globalReq.managerNote,
    requestedAt: globalReq.requestedAt.includes('T') ? globalReq.requestedAt.split('T')[0] : globalReq.requestedAt,
    status: globalReq.status,
    directorNote: globalReq.directorNote,
    includesWalkthrough: globalReq.includesWalkthrough
  } : null);

  // Lock the offer form while a request is awaiting the Account Director's decision
  const isAwaitingDirectorDecision = activeDirectorRequest?.status === 'pending';

  // One sentiment change at a time. The buttons stay on screen until the refresh lands (the account
  // is rescored first), and every extra click used to reach the server as another change.
  const [isCorrectingSentiment, setIsCorrectingSentiment] = useState(false);
  const correctSentiment = async (sentiment: 'Frustrated' | 'Neutral' | 'Satisfied' | null) => {
    if (!account.reviewId || isCorrectingSentiment) return;
    setIsCorrectingSentiment(true);
    try {
      await onCorrectSentiment(account.reviewId, sentiment);
    } finally {
      setIsCorrectingSentiment(false);
    }
  };

  // Withdrawing a scheduled discount, or this Manager's own pending request. A confirmation is
  // enough, except for an offer an Account Director approved: taking back their decision needs a
  // reason, which the server shows in the Audit Log.
  const [withdrawMode, setWithdrawMode] = useState<null | 'discount' | 'request'>(null);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const withdrawNeedsReason = withdrawMode === 'discount' && Boolean(account.discountApprovedByDirector);
  const handleWithdraw = async () => {
    if (!withdrawMode || isWithdrawing) return;
    const reason = withdrawReason.trim();
    if (withdrawNeedsReason && !reason) { showToast('Give a reason - the Account Director approved this offer.', 'error'); return; }
    const url = withdrawMode === 'discount'
      ? `/api/accounts/${account.id}/withdraw-discount`
      : `/api/discount-requests/${globalReq?.id}/withdraw`;
    setIsWithdrawing(true);
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withdrawNeedsReason ? { reason } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { showToast(data.error || 'Could not withdraw it.', 'error'); return; }
      showToast(withdrawMode === 'discount'
        ? 'Offer withdrawn. You can make a new one now.'
        : 'Request withdrawn. You can make a new one now.', 'success');
      setWithdrawMode(null);
      setWithdrawReason('');
      // The banner reads this local copy before the refreshed data arrives.
      setPendingDirectorRequest(null);
      onDiscountWithdrawn?.();
    } catch {
      showToast('Could not reach the server to withdraw it.', 'error');
    } finally {
      setIsWithdrawing(false);
    }
  };

  // Lock the offer form while a discount is scheduled or running — prevents stacking a
  // second discount on top of it. An ENDED discount does not lock: its months have
  // elapsed and the account is back at list price, so refusing a fresh offer would shut
  // the account out permanently over a discount that finished a year ago. The server
  // enforces the same rule in validateOffer; this is only the form's own guard.
  const hasActiveDiscount = blocksNewOffer(account.discountState);

  // Offers only open in the final stretch before a renewal. The server enforces this in
  // validateOffer; without the same check here a Manager could pick a percentage, watch the
  // cost box calculate, write a justification and only be refused on submit — having done
  // all the work for an offer that was never allowed.
  const daysToRenewal = account.contractRenewalDate ? daysUntil(account.contractRenewalDate) : null;
  const isBeforeOfferWindow = daysToRenewal !== null && daysToRenewal > OFFER_WINDOW_DAYS;
  const offerWindowOpens = account.contractRenewalDate
    ? new Date(new Date(account.contractRenewalDate).getTime() - OFFER_WINDOW_DAYS * 86400000)
    : null;
  // ...except for a customer who has said they are leaving, which opens discounts straight away.
  // The same rule as the server's (discountsOpen in pricing.ts), so the form can neither offer what
  // the server refuses nor hide what it allows.
  const areDiscountsOpen = !account.contractRenewalDate || discountsOpen(account.contractRenewalDate, liveIntent?.kind);
  const isDiscountWindowShut = !areDiscountsOpen;
  const offersOpenedEarly = isBeforeOfferWindow && areDiscountsOpen;

  // Two locks, because the two offers are not the same kind of thing.
  //
  // A DISCOUNT spends money, so it is gated by the renewal window as well as by the
  // stacking and pending-request rules. A WALKTHROUGH costs nothing, is not one of the
  // uplift model's treatment arms, and is exactly what a manager should be able to reach
  // for when an account is struggling ten months from its renewal. Locking the whole form
  // on the window would have removed the only lever available at that point.
  const isDiscountLocked = isAwaitingDirectorDecision || hasActiveDiscount || isDiscountWindowShut;
  const isWalkthroughLocked = isAwaitingDirectorDecision || hasActiveDiscount;
  // Kept for the parts of the form that apply to any offer (the note, the submit button).
  const isOfferFormLocked = isDiscountLocked && isWalkthroughLocked;

  // With the discount window shut, the only offer available is a walkthrough — so the
  // percentage is forced to zero rather than left at its default. Without this the form
  // would keep quoting a cost, and the submit button would keep offering to execute a
  // discount, for something the server will refuse.
  useEffect(() => {
    if (isDiscountWindowShut && selectedDiscount !== 0) setSelectedDiscount(0);
  }, [isDiscountWindowShut, selectedDiscount]);

  // What this offer costs, recomputed as either input changes. Shown to the Manager
  // so the approval rule is legible before they submit, rather than a refusal after.
  const offerGiveback = givebackValue(account.mrr, selectedDiscount, selectedMonths);
  const managerCap = selfApprovalCap(account.mrr);
  const offerTermValue = discountedTermValue(account.mrr, selectedDiscount, selectedMonths);
  const requiresDirector = needsDirectorApproval(account.mrr, selectedDiscount, selectedMonths);

  // Discount Approval handler
  const handleDiscountSubmit = () => {
    // Routed on what the offer gives away rather than its headline percentage, so
    // "20% for 3 months" (cheap) is no longer escalated while "10% for 12 months"
    // (twice the cost) sails through. The server enforces the same rule.
    if (!requiresDirector) {
      setShowDirectorPrompt(false);
      setEmailVerificationStatus('Direct Approval (Within Manager Limit)');
      setShowEmailModal(true);
    } else {
      // Discounts > 10% require Account Director approval
      // Never substituted. This previously filled in "urgent customer activation
      // issues and churn risk" when the Manager left the box empty - a specific claim
      // they never made, shown to the Director as their own words.
      const noteToSubmit = managerNote.trim();
      if (!noteToSubmit) {
        setNoteError('Add a justification — the Account Director approves this based on your note.');
        return;
      }
      setNoteError(null);
      setIsRequestBannerDismissed(false);
      setPendingDirectorRequest({
        discountPct: selectedDiscount,
        discountMonths: selectedMonths,
        managerNote: noteToSubmit,
        requestedAt: 'Just now',
        status: 'pending',
        includesWalkthrough: includeWalkthrough
      });

      onApplyDiscount(
        account,
        selectedDiscount,
        'Face Verified (Biometric Pass)',
        undefined,
        noteToSubmit,
        includeWalkthrough,
        selectedMonths
      );

      if (!isDirector) {
        setShowDirectorPrompt(true);
      } else {
        setShowDirectorPrompt(false);
        setShowFaceModal(true);
      }
    }
  };

  const handleDirectorApprove = () => {
    setShowFaceModal(true);
  };

  const handleDirectorReject = () => {
    const dNote = directorNote.trim() || 'Discount request rejected by Account Director.';
    if (globalReq && onRejectDiscountRequest) {
      onRejectDiscountRequest(globalReq.id, dNote);
    }
    setPendingDirectorRequest(prev => prev ? {
      ...prev,
      status: 'rejected',
      directorNote: dNote
    } : {
      discountPct: selectedDiscount,
      managerNote: managerNote || 'Submitted for Director review',
      requestedAt: 'Just now',
      status: 'rejected',
      directorNote: dNote,
      includesWalkthrough: includeWalkthrough
    });
  };

  // The captured frame is only used to perform the match inside
  // FaceVerificationModal; nothing downstream keeps it, so the approval
  // records who was verified rather than a photograph of them.
  //
  // The match only STAGES the approval. It is made when the Director confirms the offer email, as on
  // the Director's dashboard. Approving here and then applying again from the email window tried to
  // grant the same offer twice - the second attempt refused, next to a toast saying it had worked.
  const [stagedMatchedName, setStagedMatchedName] = useState<string | undefined>(undefined);
  const handleFaceVerified = (_snapshot: string, matchedName?: string) => {
    setShowFaceModal(false);
    setEmailVerificationStatus('Face Verified (Biometric Pass)');
    setStagedMatchedName(matchedName);
    setShowEmailModal(true);
  };

  // A Director confirming the email is approving the Manager's request, so the email must describe
  // that request - not the offer form, which a Director never fills in.
  const isApprovingRequest = emailVerificationStatus === 'Face Verified (Biometric Pass)';
  const emailPct = isApprovingRequest && globalReq ? globalReq.requestedDiscountPct : selectedDiscount;
  const emailMonths = isApprovingRequest && globalReq ? globalReq.requestedDurationMonths : selectedMonths;
  const emailWalkthrough = isApprovingRequest && globalReq ? Boolean(globalReq.includesWalkthrough) : includeWalkthrough;

  // What the email window's button does before the email goes out: approve the request (a Director,
  // after the face check) or apply the offer (a Manager within their limit). Resolves with the id of
  // the offer row written, so the email names exactly the offer that was granted.
  const confirmOffer = async (): Promise<OfferResult> => {
    if (!isApprovingRequest) {
      return onApplyDiscount(account, selectedDiscount, emailVerificationStatus, undefined, undefined, includeWalkthrough, selectedMonths);
    }
    if (!globalReq || !onApproveDiscountRequest) return { ok: false };
    const result = await onApproveDiscountRequest(globalReq.id, stagedMatchedName);
    if (result.ok) {
      setPendingDirectorRequest(prev => prev ? {
        ...prev,
        status: 'approved',
        directorNote: directorNote.trim() || 'Approved by Account Director via facial verification.'
      } : {
        discountPct: emailPct,
        managerNote: managerNote || 'Submitted for Director review',
        requestedAt: 'Just now',
        status: 'approved',
        directorNote: directorNote.trim() || 'Approved by Account Director via facial verification.',
        includesWalkthrough: emailWalkthrough
      });
    }
    return result;
  };

  const isHighRisk = account.riskCategory === 'High Risk';
  const isMedRisk = account.riskCategory === 'Medium Risk';


  // A retention discount is a tool for accounts actually at risk of churning.
  // Running the advisor on a Low Risk account produces a technically-valid but
  // commercially wrong answer (it will still name a "best" tier, because some
  // tier always scores highest), so the advisor is scoped to High/Medium Risk
  // — the same > 70 / > 30 bands fusionRiskCategory assigns in the backend.
  // A customer who has left: the page stays readable - the score it left at, its history - but
  // nothing that acts on the account is offered: no re-score, no offer, no uplift estimate.
  const hasChurned = isChurned(account);
  const isUpliftApplicable = account.riskCategory !== 'Low Risk' && !hasChurned;

  // Real model call — fetched when the Uplift tab is actually opened rather
  // than on every render.
  const [upliftPrediction, setUpliftPrediction] = useState<UpliftPrediction | null>(null);
  const [isLoadingUplift, setIsLoadingUplift] = useState<boolean>(false);
  const [upliftError, setUpliftError] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== 'uplift' || !isUpliftApplicable) return;
    let cancelled = false;
    setIsLoadingUplift(true);
    setUpliftError(null);
    fetch(`/api/accounts/${account.id}/uplift`)
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Request failed (${res.status})`);
        }
        return res.json();
      })
      .then((data: UpliftPrediction) => { if (!cancelled) setUpliftPrediction(data); })
      .catch((err) => { if (!cancelled) setUpliftError(err.message || 'Could not reach the uplift model.'); })
      .finally(() => { if (!cancelled) setIsLoadingUplift(false); });
    return () => { cancelled = true; };
  }, [activeTab, account.id, isUpliftApplicable]);

  const reviewCategory = upliftPrediction?.review_category ?? null;
  const upliftDecision = upliftPrediction ? decideUpliftAction(upliftPrediction.review_category, upliftPrediction.best_cate) : null;

  return (
    <div className="space-y-6 animate-fadeIn pb-12">

      {/* Top Header & Breadcrumbs Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 sm:p-5 rounded-2xl border border-slate-200 shadow-xs">
        <div className="flex items-center space-x-3">
          <button
            onClick={onBack}
            className="flex items-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 transition cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-4 h-4 text-slate-700" />
            <span>Back to Dashboard</span>
          </button>

          <div className="h-6 w-[1px] bg-slate-200 hidden sm:block" />

          {/* Breadcrumb path */}
          <div className="flex items-center space-x-1.5 text-xs text-slate-500 overflow-hidden font-medium">
            <span className="hidden md:inline">Dashboard</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 hidden md:inline" />
            <span>Accounts</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-bold text-slate-900 truncate">{account.name} Analysis</span>
          </div>
        </div>

        {/* Action Header Controls */}
        <div className="flex items-center space-x-2">
          {!isDirector && (
            <button
              onClick={() => onDiscussWithAdvisor(account)}
              className="flex items-center space-x-2 px-4 py-2 text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 rounded-xl transition shadow-xs cursor-pointer"
            >
              <Bot className="w-4 h-4" />
              <span>Discuss with AI Advisor</span>
            </button>
          )}

          <span className={`px-3 py-1.5 text-xs font-extrabold rounded-xl uppercase tracking-wider ${
            isHighRisk
              ? 'bg-red-50 text-red-700 border border-red-200'
              : isMedRisk
              ? 'bg-amber-50 text-amber-700 border border-amber-200'
              : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          }`}>
            {account.riskCategory} ({account.fusionRiskScore}%)
          </span>
        </div>
      </div>

      {/* Hero Banner Section for Account */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white p-6 sm:p-8 rounded-2xl shadow-md border border-slate-800 relative overflow-hidden">
        <div className="relative z-10 flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
          
          <div className="flex items-start space-x-4 sm:space-x-5">
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-white/10 backdrop-blur-md flex items-center justify-center text-white font-black text-3xl sm:text-4xl shadow-md border border-white/20 shrink-0">
              {account.logo}
            </div>

            <div className="space-y-2">
              <div className="flex items-center space-x-3">
                <h1 className="text-2xl sm:text-3xl font-black text-white tracking-tight">{account.name}</h1>
                <span className="px-2.5 py-0.5 rounded text-[10px] font-bold bg-white/10 text-slate-200 border border-white/15 uppercase">
                  {account.subscriptionType}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-300 font-medium">
                <span className="flex items-center space-x-1">
                  <Building2 className="w-3.5 h-3.5 text-slate-400" />
                  <span>{account.industry}</span>
                </span>
                <span>•</span>
                <span className="flex items-center space-x-1">
                  <DollarSign className="w-3.5 h-3.5 text-amber-400" />
                  <span>
                    MRR: <strong>${account.effectiveMrr.toLocaleString()}</strong>
                    {account.discountState === 'active' && (
                      <span className="text-slate-400 font-normal"> (list ${account.mrr.toLocaleString()})</span>
                    )}
                  </span>
                </span>
                <span>•</span>
                <span className="flex items-center space-x-1">
                  <User className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Manager: {account.accountManager}</span>
                </span>
                <span>•</span>
                <span className="flex items-center space-x-1">
                  <Clock className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Renewal: {account.contractRenewalDate}</span>
                </span>
              </div>

              {/* Says which of the three states the discount is in, and dates it. This
                  read "Active Retention Discount" from the moment of approval — with the
                  renewal potentially months away and the customer still paying list
                  price — and never stopped saying it once the months had elapsed. */}
              {account.discountState !== 'none' && (
                <div
                  className={`inline-flex items-center space-x-1.5 px-3 py-1 rounded-lg border text-xs font-bold mt-1 ${
                    account.discountState === 'active'
                      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
                      : account.discountState === 'offered'
                        ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
                        : 'bg-slate-500/20 text-slate-300 border-slate-500/40'
                  }`}
                >
                  {account.discountState === 'active'
                    ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    : <Clock className="w-4 h-4 opacity-70" />}
                  <span>{account.discountLabel}</span>
                </div>
              )}

              {/* A request sitting with the Account Director — no discount is
                  in force yet, so this is deliberately amber, not green. */}
              {isAwaitingDirectorDecision && activeDirectorRequest && (
                <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-amber-500/20 text-amber-200 border border-amber-500/40 text-xs font-bold mt-1">
                  <Clock className="w-4 h-4 text-amber-300" />
                  <span>Retention Discount: {activeDirectorRequest.discountPct}% Pending Director Approval</span>
                </div>
              )}

              {/* Said at the top, before anything else on the page: this customer has gone. */}
              {hasChurned && (
                <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-lg bg-slate-500/25 text-slate-100 border border-slate-400/50 text-xs font-bold mt-1">
                  <span>
                    Churned{account.contractRenewalDate ? `: left at its renewal on ${formatTermDate(account.contractRenewalDate)}` : ''}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Quick Risk Score Metric Block */}
          <div className="bg-slate-900/80 p-4 rounded-xl border border-slate-700/80 backdrop-blur-md w-full lg:w-72 space-y-2 shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Fusion Churn Risk</span>
              <span className={`text-xl font-black font-mono ${
                isHighRisk ? 'text-red-400' : isMedRisk ? 'text-amber-400' : 'text-emerald-400'
              }`}>
                {account.fusionRiskScore}/100
              </span>
            </div>

            <div className="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden border border-slate-700">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  isHighRisk ? 'bg-red-500' : isMedRisk ? 'bg-amber-500' : 'bg-emerald-500'
                }`}
                style={{ width: `${account.fusionRiskScore}%` }}
              />
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-400 pt-1">
              <span>Usage Model: <strong className="text-white">{account.churnModelScore}%</strong></span>
              <span>NLP Sentiment: <strong className="text-white">{account.sentimentClassification}</strong></span>
            </div>

            {/* When these numbers were computed, and a way to recompute them.
                Without this line nothing on screen separates a score produced this morning
                from one produced last week, so a scheduled job that quietly stopped would
                leave every account looking exactly as current as before. The amber state is
                the point of it. */}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-700/70">
              {/* For a churned account the score is deliberately frozen, not stale: it is the risk it left at. */}
              <span className={`text-[11px] ${isScoreStale && !hasChurned ? 'text-amber-400 font-semibold' : 'text-slate-500'}`}>
                {account.scoredAt
                  ? hasChurned
                    ? `Final score, ${formatTermDate(account.scoredAt)}`
                    : isScoreStale
                      ? `Scored ${formatTermDate(account.scoredAt)} · ${scoreAgeDays} days ago`
                      : `Scored ${formatTermDate(account.scoredAt)}`
                  : 'Not yet scored'}
              </span>
              {!hasChurned && (
                <button
                  onClick={handleRescore}
                  disabled={isRescoring}
                  title="Re-run the churn, sentiment and fusion models for this account using its current usage reading"
                  className="flex items-center space-x-1 text-[11px] font-semibold text-slate-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  <RefreshCw className={`w-3 h-3 ${isRescoring ? 'animate-spin' : ''}`} />
                  <span>{isRescoring ? 'Re-scoring…' : 'Re-score'}</span>
                </button>
              )}
            </div>
          </div>

        </div>
      </div>

      {/* Main Analysis Navigation Tabs */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
        
        <div className="flex border-b border-slate-200 bg-slate-50/80 px-4 pt-3 overflow-x-auto space-x-2">
          
          <button
            onClick={() => setActiveTab('fusion')}
            className={`px-4 py-3 text-xs font-bold rounded-t-xl transition flex items-center space-x-2 border-b-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'fusion'
                ? 'bg-white border-slate-900 text-slate-900 shadow-xs'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100/60'
            }`}
          >
            <Activity className="w-4 h-4 text-slate-700" />
            <span>1. Risk Overview</span>
          </button>

          <button
            onClick={() => setActiveTab('shap')}
            className={`px-4 py-3 text-xs font-bold rounded-t-xl transition flex items-center space-x-2 border-b-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'shap'
                ? 'bg-white border-slate-900 text-slate-900 shadow-xs'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100/60'
            }`}
          >
            <Zap className="w-4 h-4 text-amber-600" />
            <span>2. Why This Score</span>
          </button>

          <button
            onClick={() => setActiveTab('uplift')}
            className={`px-4 py-3 text-xs font-bold rounded-t-xl transition flex items-center space-x-2 border-b-2 cursor-pointer whitespace-nowrap ${
              activeTab === 'uplift'
                ? 'bg-white border-slate-900 text-slate-900 shadow-xs'
                : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100/60'
            }`}
          >
            <Gauge className="w-4 h-4 text-violet-600" />
            <span>3. Discount Uplift Advisor</span>
          </button>

          {!isDirector && (
            <button
              onClick={() => setActiveTab('discount')}
              className={`px-4 py-3 text-xs font-bold rounded-t-xl transition flex items-center space-x-2 border-b-2 cursor-pointer whitespace-nowrap ${
                activeTab === 'discount'
                  ? 'bg-white border-slate-900 text-slate-900 shadow-xs'
                  : 'border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100/60'
              }`}
            >
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>4. Retention Offer</span>
            </button>
          )}

        </div>

        {/* TAB 1: RAG FUSION DIAGNOSIS */}
        {activeTab === 'fusion' && (
          <div className="p-6 sm:p-8 space-y-6">
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              
              {/* Left Column: Behavioral Churn Model */}
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center space-x-2">
                  <Activity className="w-4 h-4 text-slate-700" />
                  <span>Behavioral Churn Model</span>
                </h3>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-500 font-medium">Churn Risk Model Score (before fusion):</span>
                    <span className="font-bold font-mono text-slate-900">{account.churnModelScore}/100</span>
                  </div>
                  <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                    <div className="bg-slate-800 h-full rounded-full" style={{ width: `${account.churnModelScore}%` }} />
                  </div>
                </div>

                {/* Historical Sparkline */}
                <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2">
                  <span className="text-xs font-bold text-slate-700 block">6-Month Churn Trajectory History (Fusion)</span>
                  <RiskSparkline
                    history={account.riskHistory}
                    trend={account.riskTrend}
                    riskCategory={account.riskCategory}
                    currentScore={account.fusionRiskScore}
                  />
                </div>
              </div>

              {/* Right Column: Latest Customer Review & Sentiment Risk Model */}
              <div className="space-y-4">
                <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center space-x-2">
                  <FileText className="w-4 h-4 text-slate-700" />
                  <span>Latest Customer Review</span>
                </h3>

                <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4 space-y-2 text-xs text-amber-900">
                  <p className="leading-relaxed italic text-slate-800 font-medium">
                    "{account.reviewText || "I'm a brand new customer and the account activation email never arrived at all."}"
                  </p>
                </div>

                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3 text-xs">
                  <span className="font-bold text-slate-900 block uppercase tracking-wider text-[11px]">
                    Sentiment Risk Model
                  </span>
                  
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-slate-500 font-medium">Review Sentiment:</span>
                    <span className={`font-bold text-xs ${
                      account.sentimentClassification === 'Frustrated'
                        ? 'text-red-600'
                        : account.sentimentClassification === 'Neutral' 
                        ? 'text-amber-600' 
                        : 'text-emerald-600'
                    }`}>
                      {account.sentimentClassification || 'Frustrated'}
                    </span>
                  </div>

                  <div className="flex items-center justify-between pt-1 border-t border-slate-200">
                    <span className="text-slate-500 font-medium">Sentiment Risk Weight:</span>
                    <span className="font-bold font-mono text-slate-900">
                      {typeof account.sentimentRiskWeight === 'number' ? account.sentimentRiskWeight.toFixed(2) : '—'}
                    </span>
                  </div>

                  {/* Disagreeing with the model.
                      This is the ONLY feedback that can retrain the sentiment model —
                      renewal outcomes can't, since a furious customer can still renew.
                      The correction is stored beside the prediction, never over it: the
                      figures above stay the model's own output whatever is chosen here. */}
                  {account.reviewId && (
                    <div className="pt-3 border-t border-slate-200 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-500 font-medium">Is that right?</span>
                        {account.correctedSentiment && (
                          <button
                            onClick={() => correctSentiment(null)}
                            disabled={isCorrectingSentiment}
                            className="text-[10px] font-semibold text-slate-500 hover:text-slate-800 underline cursor-pointer disabled:opacity-50 disabled:cursor-wait"
                          >
                            clear
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-1.5">
                        {(['Frustrated', 'Neutral', 'Satisfied'] as const).map(s => {
                          const chosen = account.correctedSentiment === s;
                          return (
                            <button
                              key={s}
                              onClick={() => correctSentiment(chosen ? null : s)}
                              disabled={isCorrectingSentiment}
                              className={`text-[11px] font-bold py-1.5 rounded-lg border transition cursor-pointer disabled:opacity-50 disabled:cursor-wait ${
                                chosen
                                  ? 'bg-slate-900 text-white border-slate-900'
                                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              {s}
                            </button>
                          );
                        })}
                      </div>
                      {/* Deliberately short. Who corrected it, when, and what the scores
                          moved from and to is audit-trail content and lives in the Audit
                          Log with every other state change. All this needs to say is that
                          the figures above are a person's reading rather than the model's
                          — without that the panel would be quietly misleading. */}
                      {/* Agreeing with the model and overruling it are different acts and must
                          read differently.
                          A confirmation verifies the LABEL and stops there: it says nothing
                          about how confident to be, and the model's own probability remains
                          the better estimate of that. If agreeing also forced the weight to a
                          certainty, a manager working through every account would replace the
                          model's judgement everywhere and the sentiment model would stop
                          reaching the fusion score at all. */}
                      {account.correctedSentiment ? (
                        account.correctedSentiment === account.modelSentiment ? (
                          <p className="text-[11px] text-emerald-900 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5">
                            Confirmed{account.correctedSentimentBy ? ` by ${account.correctedSentimentBy}` : ''} —
                            you agreed with the model, so the scores are unchanged. Recorded as a
                            verified training example.
                          </p>
                        ) : (
                          <p className="text-[11px] text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg px-2.5 py-1.5">
                            Corrected reading{account.correctedSentimentBy ? ` (${account.correctedSentimentBy})` : ''} —
                            the model read this as <strong>{account.modelSentiment ?? '—'}</strong>.
                          </p>
                        )
                      ) : (
                        <p className="text-[11px] text-slate-500">
                          Confirming or correcting this reading rescores the account and trains the
                          sentiment model.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>

            </div>

            {/* Company & Customer Telemetry Details Section */}
            {(() => {
              // The six values the churn model is actually given, read from
              // usage_snapshots and subscriptions. This panel previously showed
              // a hardcoded contact ("Alyssa Clark"), a fixed account age of
              // 269 days and 43 daily minutes for every account — invented
              // numbers displayed under the model's own feature names.
              const accountAgeDays = account.accountAgeDays ?? '—';
              const loginFrequency = account.loginFrequencyBucket ?? '—';
              const dailyUsageMins = account.dailyUsageMinutes ?? '—';
              const planTier = account.subscriptionType || 'Basic';
              const supportTickets90Days = account.supportTicketCount ?? '—';
              const apiUtilizationRate = account.apiUtilizationRate != null
                ? account.apiUtilizationRate.toFixed(3)
                : '—';

              // The churn model's one engineered feature, and the only input it uses
              // that is not stored anywhere: model_service computes it inside the
              // pipeline as tickets / (usage + 1). Shown because the SHAP tab lists
              // Support_Ticket_Friction among the risk drivers, and without it here
              // there was no way to see what the value actually was.
              //
              // Same formula as model_service/app.py's build_row - if that changes,
              // this must change with it.
              const supportTicketFriction =
                account.supportTicketCount != null && account.dailyUsageMinutes != null
                  ? (account.supportTicketCount / (account.dailyUsageMinutes + 1)).toFixed(3)
                  : '—';

              return (
                <div className="pt-6 border-t border-slate-200 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center space-x-2">
                      <Building2 className="w-4 h-4 text-slate-700" />
                      <span>Company Telemetry & Account Record</span>
                    </h3>
                    <span className="text-[11px] font-mono font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded border border-slate-200">
                      Account ID: {account.id}
                    </span>
                  </div>

                  {/* Structured Key-Value Cards */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Account_Age_Days</p>
                      <p className="text-xs font-mono font-bold text-slate-900">{accountAgeDays}</p>
                    </div>

                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Login_Frequency</p>
                      <p className="text-xs font-bold text-slate-900">{loginFrequency}</p>
                    </div>

                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Daily_Usage_Mins</p>
                      <p className="text-xs font-mono font-bold text-slate-900">{dailyUsageMins}</p>
                    </div>

                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Plan_Tier</p>
                      <p className="text-xs font-bold text-slate-900">{planTier}</p>
                    </div>

                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Support_Tickets_90Days</p>
                      <p className="text-xs font-mono font-bold text-slate-900">{supportTickets90Days}</p>
                    </div>

                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">API_Utilization_Rate</p>
                      <p className="text-xs font-mono font-bold text-slate-900">{apiUtilizationRate}</p>
                    </div>

                    <div className="bg-slate-50 border border-dashed border-slate-300 rounded-lg p-3 space-y-1">
                      <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                        Support_Ticket_Friction
                        <span className="text-[9px] font-bold text-violet-700 bg-violet-50 border border-violet-200 rounded px-1 py-px normal-case tracking-normal">
                          derived
                        </span>
                      </p>
                      <p className="text-xs font-mono font-bold text-slate-900">{supportTicketFriction}</p>
                      <p className="text-[9px] text-slate-400 font-mono">tickets / (usage + 1)</p>
                    </div>
                  </div>
                </div>
              );
            })()}

          </div>
        )}

        {/* TAB 2: SHAP FEATURE ATTRIBUTION */}
        {activeTab === 'shap' && (
          <div className="p-6 sm:p-8 space-y-6">
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
              <div className="space-y-0.5">
                <h3 className="text-sm font-bold text-slate-900 flex items-center space-x-2">
                  <Zap className="w-4 h-4 text-amber-600" />
                  <span>Explainable AI (XAI) SHAP Factor Attribution</span>
                </h3>
                <p className="text-xs text-slate-500">
                  Mathematical breakdown showing exact contribution of individual account variables to overall churn score.
                </p>
              </div>

              {account.shapFactors.length > 0 && (
                <div className="flex items-center space-x-2 shrink-0">
                  <label htmlFor="shap-count" className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                    Show
                  </label>
                  <select
                    id="shap-count"
                    value={shapVisibleCount}
                    onChange={(e) => setShapVisibleCount(Number(e.target.value))}
                    className="text-xs font-semibold text-slate-900 bg-white border border-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-hidden focus:ring-2 focus:ring-amber-500"
                  >
                    {[3, 5, 8].filter((n) => n < account.shapFactors.length).map((n) => (
                      <option key={n} value={n}>Top {n}</option>
                    ))}
                    <option value={account.shapFactors.length}>
                      All {account.shapFactors.length}
                    </option>
                  </select>
                </div>
              )}
            </div>

            {/* SHAP Factor Bars */}
            <div className="space-y-3">
              {account.shapFactors.slice(0, shapVisibleCount).map((factor, idx) => {
                const isIncrease = factor.direction === 'risk_increase';
                return (
                  <div key={idx} className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 shadow-2xs">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-900">{factor.feature}</span>
                      <span className={`font-mono font-bold ${isIncrease ? 'text-red-600' : 'text-emerald-600'}`}>
                        {isIncrease ? `+${factor.impact} pts (Increases Risk)` : `${factor.impact} pts (Protects Account)`}
                      </span>
                    </div>

                    <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isIncrease ? 'bg-red-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(100, Math.abs(factor.impact) * 3)}%` }}
                      />
                    </div>

                    <p className="text-[11px] text-slate-500">{factor.description}</p>
                  </div>
                );
              })}
            </div>

            {account.shapFactors.length > 0 && (
              <p className="text-[11px] text-slate-400 text-center">
                Showing {Math.min(shapVisibleCount, account.shapFactors.length)} of {account.shapFactors.length} scored
                features — impact is each feature's share of this prediction's total SHAP magnitude.
              </p>
            )}

            {/* Gemini SHAP Explanation Output */}
            {account.geminiExplanationSummary && (
              <div className="bg-slate-900 text-white rounded-xl p-5 space-y-2 border border-slate-800 shadow-md">
                <div className="flex items-center space-x-2 text-xs font-bold text-amber-400">
                  <Sparkles className="w-4 h-4" />
                  <span>Gemini 3.6 Flash SHAP Executive Diagnosis</span>
                </div>
                <p className="text-xs text-slate-200 leading-relaxed font-sans">
                  {account.geminiExplanationSummary}
                </p>
              </div>
            )}

          </div>
        )}

        {/* TAB 3: DISCOUNT UPLIFT ADVISOR — the trained uplift model, fetched from GET /api/accounts/:id/uplift */}
        {activeTab === 'uplift' && (
          <div className="p-6 sm:p-8 space-y-6">

            <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-0.5">
              <h3 className="text-sm font-bold text-slate-900 flex items-center space-x-2">
                <Gauge className="w-4 h-4 text-violet-600" />
                <span>Discount Uplift Advisor</span>
              </h3>
              <p className="text-xs text-slate-500">
                Runs this account's real usage, churn, sentiment, and fusion numbers through the trained
                causal uplift model to estimate whether a discount would actually change the retention
                outcome here — not just whether the account is at risk.
              </p>
            </div>

            {hasChurned ? (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-2 text-xs text-slate-700">
                <p className="font-extrabold uppercase tracking-wider text-slate-900">Not run — the customer has left</p>
                <p>
                  {account.name} left at its renewal{account.contractRenewalDate ? ` on ${formatTermDate(account.contractRenewalDate)}` : ''}.
                  The advisor estimates whether a discount would change a renewal, and this account has no renewal left.
                </p>
              </div>
            ) : !isUpliftApplicable ? (
              /* Low Risk — the advisor is deliberately not run. A retention
                 discount is a tool for saving accounts that might leave, and
                 the model will always name a "best" tier even when no discount
                 is warranted, so showing one here would invite giving money
                 away to a customer who was renewing regardless. */
              <div className="bg-sky-50 border border-sky-200 rounded-xl p-5 space-y-3">
                <div className="flex items-center space-x-2">
                  <ShieldCheck className="w-4 h-4 text-sky-600" />
                  <span className="text-xs font-extrabold uppercase tracking-wider text-slate-900">
                    Not applicable — account is low risk
                  </span>
                </div>
                <p className="text-xs text-slate-700 leading-relaxed">
                  {account.name} is at <strong>{account.fusionRiskScore}/100</strong> fusion churn risk
                  (<strong>{account.riskCategory}</strong>). The Discount Uplift Advisor only runs for accounts
                  in the <strong>Medium Risk</strong> (above 30) and <strong>High Risk</strong> (above 70) bands.{' '}
                  {liveIntent?.kind === 'churning'
                    ? <>The customer has given notice that they are leaving, but the models cannot see that notice, so
                      on this score the advisor's estimate would not reflect it. Any discount is your own judgement,
                      made on the Retention Offer tab, which the notice has opened.</>
                    : <>A retention discount is a tool for keeping accounts that might otherwise leave, and this one
                      shows no sign of churning.</>}
                </p>
                <p className="text-[11px] text-slate-500 leading-relaxed">
                  If this account's risk rises above 30, the advisor will run automatically and recommend a
                  discount tier here.
                </p>
              </div>
            ) : (
              <>
            {/* Review text being analyzed */}
            <div className="bg-amber-50/60 border border-amber-200 rounded-xl p-4 space-y-2 text-xs text-amber-900">
              <span className="font-bold uppercase tracking-wider text-[11px] block text-amber-800">Analyzed Review</span>
              <p className="leading-relaxed italic text-slate-800 font-medium">
                "{account.reviewText || "I'm a brand new customer and the account activation email never arrived at all."}"
              </p>
            </div>

            {isLoadingUplift && (
              <div className="flex items-center space-x-2 text-xs text-slate-600 p-4 bg-slate-50 rounded-xl border border-slate-200">
                <Gauge className="w-4 h-4 animate-pulse" />
                <span>Running the trained uplift model against this account's real data...</span>
              </div>
            )}

            {upliftError && !isLoadingUplift && (
              <div className="flex items-start space-x-2 text-xs text-red-800 p-4 bg-red-50 rounded-xl border border-red-200">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold">Uplift model unavailable</p>
                  <p className="mt-0.5">{upliftError}</p>
                </div>
              </div>
            )}

            {upliftPrediction && upliftDecision && !isLoadingUplift && (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                  {/* Category classification */}
                  <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                    <span className="text-xs font-bold text-slate-700 uppercase tracking-wider block">Review Category</span>
                    <div className={`inline-flex items-center space-x-2 px-3 py-2 rounded-lg text-xs font-bold border ${
                      upliftDecision.category === 'technical'
                        ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                        : upliftDecision.category === 'price'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : 'bg-slate-100 text-slate-700 border-slate-200'
                    }`}>
                      {upliftDecision.category === 'technical' && <Wrench className="w-4 h-4" />}
                      {upliftDecision.category === 'price' && <DollarSign className="w-4 h-4" />}
                      {upliftDecision.category === 'general' && <MessageSquare className="w-4 h-4" />}
                      <span className="capitalize">Reads as {upliftDecision.category}</span>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Gemini's read of the ticket text, cached on the ticket — the uplift model itself only
                      sees structured account numbers, not what the customer wrote.
                    </p>
                  </div>

                  {/* Predicted uplift (CATE) — real model output */}
                  <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700 uppercase tracking-wider">Best Offer (Real Model)</span>
                      <span className="font-mono font-bold text-sm text-slate-900">{describeDiscount(upliftPrediction.best_pct, upliftPrediction.best_months)}</span>
                    </div>
                    <div className="w-full bg-slate-100 h-2.5 rounded-full overflow-hidden relative">
                      <div
                        className={`h-full rounded-full ${upliftDecision.helps ? 'bg-emerald-500' : 'bg-slate-400'}`}
                        style={{ width: `${Math.max(4, Math.min(100, ((upliftPrediction.best_cate + 0.1) / 0.2) * 100))}%` }}
                      />
                      <div className="absolute top-0 bottom-0 w-0.5 bg-red-500" style={{ left: `${(0.1 / 0.2) * 100}%` }} title="Zero uplift" />
                    </div>
                    <p className="text-[11px] text-slate-500">
                      Predicted retention lift at {describeDiscount(upliftPrediction.best_pct, upliftPrediction.best_months)} vs. no discount:{' '}
                      <span className="font-mono font-bold text-slate-800">{upliftPrediction.best_cate >= 0 ? '+' : ''}{(upliftPrediction.best_cate * 100).toFixed(1)}pp</span>
                      {' '}(baseline retention {(upliftPrediction.baseline_retention * 100).toFixed(1)}%). A discount{' '}
                      {upliftDecision.helps ? <strong className="text-emerald-700">is predicted to genuinely help</strong> : <strong className="text-slate-600">is not predicted to help</strong>} here.
                    </p>
                  </div>
                </div>

                {/* Recommended action */}
                <div className={`p-5 rounded-xl border space-y-2 ${
                  upliftDecision.action === 'Flag for Human Review'
                    ? 'bg-red-50 border-red-300'
                    : upliftDecision.action === 'Discount + Walkthrough'
                    ? 'bg-indigo-50 border-indigo-300'
                    : upliftDecision.action === 'Discount Only'
                    ? 'bg-emerald-50 border-emerald-300'
                    : upliftDecision.action === 'Walkthrough Only'
                    ? 'bg-amber-50 border-amber-300'
                    : 'bg-slate-50 border-slate-300'
                }`}>
                  <div className="flex items-center space-x-2">
                    {upliftDecision.action === 'Flag for Human Review' && <Flag className="w-4 h-4 text-red-600" />}
                    {upliftDecision.action === 'Discount + Walkthrough' && <Wrench className="w-4 h-4 text-indigo-600" />}
                    {upliftDecision.action === 'Discount Only' && <Percent className="w-4 h-4 text-emerald-600" />}
                    {upliftDecision.action === 'Walkthrough Only' && <Wrench className="w-4 h-4 text-amber-600" />}
                    {upliftDecision.action === 'Do Nothing' && <CheckCircle2 className="w-4 h-4 text-slate-500" />}
                    <span className="text-xs font-extrabold uppercase tracking-wider text-slate-900">
                      Recommended: {upliftDecision.action}
                      {upliftDecision.helps && upliftDecision.action !== 'Walkthrough Only' && ` (${describeDiscount(upliftPrediction.best_pct, upliftPrediction.best_months)})`}
                    </span>
                  </div>
                  <p className="text-xs text-slate-700 leading-relaxed">
                    {upliftDecision.action === 'Flag for Human Review' &&
                      "Signals disagree — the review reads as a price complaint, but the model predicts no discount tier meaningfully improves retention. Worth a person looking at this one before deciding."}
                    {upliftDecision.action === 'Discount + Walkthrough' &&
                      "Signals disagree — the review reads as a technical/product issue, but the model still predicts a real discount benefit. Worth doing both: fix the underlying friction and offer the discount."}
                    {upliftDecision.action === 'Discount Only' &&
                      "Both signals agree a discount is the right lever here."}
                    {upliftDecision.action === 'Walkthrough Only' &&
                      "Both signals agree — this is a technical/product problem, and the model predicts no discount tier would move the needle. Route to support instead of offering money off."}
                    {upliftDecision.action === 'Do Nothing' &&
                      "No clear technical or price signal in the review, and the model doesn't predict meaningful uplift from any discount tier here."}
                  </p>

                  {/* This used to branch on account.walkthroughScheduled, which the server
                      never set — so the "already scheduled" message could never appear.
                      The button is rightly Manager-only, but the FACT of a previous
                      walkthrough is not: it now lives in the account header, visible on
                      every tab and to every role, rather than being hidden whenever this
                      button happens not to render. */}
                  {!isDirector && (upliftDecision.action === 'Discount + Walkthrough' || upliftDecision.action === 'Walkthrough Only') && (
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => {
                          setIncludeWalkthrough(true);
                          if (upliftDecision.action === 'Walkthrough Only') setSelectedDiscount(0);
                          else { setSelectedDiscount(upliftPrediction.best_pct); setSelectedMonths(upliftPrediction.best_months); }
                          setActiveTab('discount');
                        }}
                        className="flex items-center space-x-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition shadow-md cursor-pointer"
                      >
                        <Wrench className="w-4 h-4" />
                        <span>Schedule Walkthrough on Retention Offer Tab</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
              </>
            )}

          </div>
        )}

        {/* A customer who has left: no offer can be made (the server refuses one too), so the form, the
            withdraw buttons and the email window are not offered at all. */}
        {!isDirector && activeTab === 'discount' && hasChurned && (
          <div className="p-6 sm:p-8">
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-2 text-xs text-slate-700">
              <p className="font-bold uppercase tracking-wider text-[11px] text-slate-900">No offer can be made</p>
              <p>
                {account.name} left at its renewal{account.contractRenewalDate ? ` on ${formatTermDate(account.contractRenewalDate)}` : ''},
                so there is no renewal left to offer a discount or a walkthrough against. If it was recorded as churned
                by mistake, correct the outcome on the Renewals page and the account comes back.
              </p>
            </div>
          </div>
        )}

        {/* TAB 5: RETENTION DISCOUNT & BIOMETRIC EXECUTION (Account Manager only — Directors review requests from their own dashboard) */}
        {!isDirector && activeTab === 'discount' && !hasChurned && (
          <div className="p-6 sm:p-8 space-y-6">

            {/* Window closed. Shown before anything else in the tab, because it is the reason
                every control below is disabled — and it says WHEN it opens rather than just
                refusing, so the Manager knows what to do with the information. */}
            {isDiscountWindowShut && (
              <div className="p-4 rounded-xl border bg-slate-50 border-slate-300 text-slate-800 flex items-start space-x-2.5 text-xs">
                <Clock className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold uppercase tracking-wider text-[11px]">Retention Offers Not Yet Open</p>
                  <p className="mt-0.5">
                    {account.name} renews on <strong>{formatTermDate(account.contractRenewalDate!)}</strong>,
                    {' '}{daysToRenewal} days away. Offers open {OFFER_WINDOW_DAYS} days before renewal
                    {offerWindowOpens ? <> — <strong>{formatTermDate(offerWindowOpens)}</strong></> : null}.
                  </p>
                  <p className="mt-1.5 text-slate-600">
                    Discounting this far out gives money away before it is clear the account is
                    genuinely at risk. It is also when the system records what the account looked
                    like before anything was done to it, which is what the retention models are
                    later trained on.
                  </p>
                  <p className="mt-1.5 text-slate-600">
                    If the customer has said they are leaving, record it on the Renewals page and
                    discounts open straight away.
                  </p>
                </div>
              </div>
            )}

            {/* Opened early by a leaving notice - said, so the Manager knows why the window rule does
                not apply here and when it otherwise would have. */}
            {offersOpenedEarly && (
              <div className="p-4 rounded-xl border bg-sky-50 border-sky-200 text-sky-950 flex items-start space-x-2.5 text-xs">
                <Clock className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold uppercase tracking-wider text-[11px]">Offers Opened Early</p>
                  <p className="mt-0.5">
                    {account.name} has given notice that they are leaving at their renewal on{' '}
                    <strong>{formatTermDate(account.contractRenewalDate!)}</strong>, {daysToRenewal} days away.
                    Discounts would normally open on{' '}
                    {offerWindowOpens ? <strong>{formatTermDate(offerWindowOpens)}</strong> : 'the window date'}, but
                    waiting would only give a competitor the time.
                  </p>
                </div>
              </div>
            )}

            {/* Active Discount Notice — blocks stacking a second discount on top of an existing one.
                A SCHEDULED one can be withdrawn to make a different offer (with a reason if a Director
                approved it); a RUNNING one cannot - the customer is already being billed at that price. */}
            {hasActiveDiscount && !isAwaitingDirectorDecision && !isDiscountWindowShut && (
              <div className={`p-4 rounded-xl border flex items-start space-x-2.5 text-xs ${
                account.discountState === 'active'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                  : 'bg-sky-50 border-sky-300 text-sky-950'
              }`}>
                {account.discountState === 'active'
                  ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  : <Clock className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />}
                <div className="flex-1 space-y-2">
                  <p className="font-bold uppercase tracking-wider text-[11px]">
                    {account.discountState === 'active' ? 'Discount Currently Active' : 'Discount Already Scheduled'}
                  </p>
                  <p className="mt-0.5">
                    {account.name} has {account.discountLabel}. A new discount can't be submitted on top of it.
                    {account.discountState === 'active' && ' A running discount cannot be withdrawn: the customer is already paying that price.'}
                  </p>
                  {account.discountState === 'offered' && currentUser?.role !== 'admin' && (
                    withdrawMode === 'discount' ? (
                      <div className="space-y-2 pt-1">
                        <p className="text-[11px] font-bold">Withdraw this offer?</p>
                        <p className="text-[11px]">
                          The account will have no discount for this renewal until a new offer is approved. If the
                          new one needs the Account Director and is rejected, the customer gets nothing.
                        </p>
                        {withdrawNeedsReason && (
                          <>
                            <p className="text-[11px] font-semibold">
                              The Account Director approved this offer, so say why it is being withdrawn. It goes in the Audit Log.
                            </p>
                            <textarea
                              rows={2}
                              value={withdrawReason}
                              onChange={(e) => setWithdrawReason(e.target.value)}
                              placeholder="e.g. customer declined; offering 20% instead"
                              className="w-full text-xs p-2.5 border border-slate-300 rounded-lg bg-white text-slate-900 resize-none focus:outline-none focus:ring-2 focus:ring-slate-700"
                            />
                          </>
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={handleWithdraw}
                            disabled={isWithdrawing || (withdrawNeedsReason && !withdrawReason.trim())}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-sky-900 text-white hover:bg-sky-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                          >
                            {isWithdrawing ? 'Withdrawing...' : 'Withdraw offer'}
                          </button>
                          <button
                            type="button"
                            onClick={() => { setWithdrawMode(null); setWithdrawReason(''); }}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-semibold hover:underline cursor-pointer"
                          >
                            Keep it
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setWithdrawMode('discount'); setWithdrawReason(''); }}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-white border border-sky-300 text-sky-900 hover:bg-sky-100 transition-colors cursor-pointer"
                      >
                        Withdraw this offer
                      </button>
                    )
                  )}
                </div>
              </div>
            )}

            {/* Proposed Retention Rate Adjustment Input */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
              <label htmlFor="discount-pct-input" className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                Proposed Retention Rate Adjustment (%)
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <div className="relative w-48">
                  {/* Fixed steps, not a free number: exactly the uplift model's treatment arms
                      (OFFER_PCTS in pricing.ts). An offer off the grid is one the Discount Uplift
                      Advisor cannot evaluate beforehand and whose renewal cannot train the model
                      afterwards. "No discount" is a walkthrough-only offer. */}
                  <select
                    id="discount-pct-input"
                    value={selectedDiscount}
                    onChange={(e) => setSelectedDiscount(Number(e.target.value))}
                    disabled={isDiscountLocked}
                    className="w-full text-base font-bold font-mono px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 bg-slate-50 text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <option value={0}>No discount</option>
                    {OFFER_PCTS.map(p => (
                      <option key={p} value={p}>{p}%</option>
                    ))}
                  </select>
                </div>

                <div className="relative w-44">
                  <label htmlFor="discount-months-input" className="sr-only">Discount duration in months</label>
                  <select
                    id="discount-months-input"
                    // No discount has no duration. It is one control arm, not 0% for N months,
                    // so the select stands empty and locked rather than implying a length.
                    value={selectedDiscount === 0 ? '' : selectedMonths}
                    onChange={(e) => setSelectedMonths(Number(e.target.value))}
                    disabled={isDiscountLocked || selectedDiscount === 0}
                    className="w-full text-base font-bold font-mono px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 bg-slate-50 text-slate-900 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {selectedDiscount === 0 && <option value="">No duration</option>}
                    {OFFER_MONTHS.map(m => (
                      <option key={m} value={m}>{m} months</option>
                    ))}
                  </select>
                </div>

                {requiresDirector ? (
                  <span className="text-[11px] font-bold px-3 py-2 rounded-md bg-amber-100 text-amber-900 border border-amber-300">
                    Director Approval Required
                  </span>
                ) : (
                  <span className="text-[11px] font-bold px-3 py-2 rounded-md bg-slate-100 text-slate-700 border border-slate-200">
                    Within Manager Limit
                  </span>
                )}
              </div>

              {/* What the offer costs, live. The approval rule is about give-away rather
                  than headline percentage, so without this a refusal would look arbitrary
                  - and a Manager could not see that 20% for 3 months costs half what
                  10% for 12 months does. */}
              {selectedDiscount > 0 && (
                <div className="text-[11px] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-slate-500">{describeDiscount(selectedDiscount, selectedMonths)} gives away</span>
                    <span className={`font-bold font-mono ${requiresDirector ? 'text-amber-800' : 'text-slate-900'}`}>
                      {formatMoney(offerGiveback)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Account Manager limit</span>
                    <span className="font-mono text-slate-700">{formatMoney(managerCap)}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-1">
                    <span className="text-slate-500">Customer pays over the 12-month term</span>
                    <span className="font-bold font-mono text-slate-900">{formatMoney(offerTermValue)}</span>
                  </div>
                </div>
              )}

              {/* Walkthrough — an independent lever, not just a discount add-on. Can be sent
                  on its own (choose "No discount") or combined with a discount above. */}
              <div className="pt-1">
                <label className={`flex items-center space-x-2.5 ${isWalkthroughLocked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    checked={includeWalkthrough}
                    onChange={(e) => setIncludeWalkthrough(e.target.checked)}
                    disabled={isWalkthroughLocked}
                    className="w-4 h-4 rounded border-slate-300 text-violet-600 focus:ring-2 focus:ring-violet-600 disabled:cursor-not-allowed"
                  />
                  <span className="text-xs font-bold text-slate-700 flex items-center space-x-1.5">
                    <Wrench className="w-3.5 h-3.5 text-violet-600" />
                    <span>Include a product walkthrough</span>
                  </span>
                </label>
                <p className="text-[11px] text-slate-500 pl-6.5 mt-1">
                  Works on its own — choose "No discount" above for a walkthrough-only offer — or combined with a discount.
                </p>
                {/* Shown where the decision is actually made. There is no limit on how often
                    a walkthrough can be offered, so this is context rather than a warning —
                    but someone about to tick this box should not have to go looking for
                    whether one was already offered last week. */}
                {account.lastWalkthroughAt && (
                  <p className="text-[11px] text-violet-800 bg-violet-50 border border-violet-200 rounded-lg px-2.5 py-1.5 mt-2">
                    Product walkthrough last offered {formatTermDate(account.lastWalkthroughAt)}
                    {account.lastWalkthroughBy ? ` by ${account.lastWalkthroughBy}` : ''}.
                    There is no limit — offer another whenever it would help.
                  </p>
                )}
              </div>
            </div>

            {/* Account Manager Note / Remark Input — only relevant once a request actually
                needs Director justification (>10%); unused by the self-approve path. */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-2">
              <label htmlFor="manager-note-textarea" className="block text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center space-x-1.5">
                <MessageSquare className="w-3.5 h-3.5 text-slate-600" />
                <span>Account Manager Note / Remark</span>
                {requiresDirector && <span className="text-red-600 font-bold">*</span>}
              </label>
              <textarea
                id="manager-note-textarea"
                rows={2}
                value={managerNote}
                onChange={(e) => { setManagerNote(e.target.value); if (noteError) setNoteError(null); }}
                disabled={isOfferFormLocked || !requiresDirector}
                placeholder="Why does this account need an offer above your approval limit?"
                className={`w-full text-xs p-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 bg-slate-50 text-slate-900 resize-none disabled:opacity-50 disabled:cursor-not-allowed ${noteError ? 'border-red-400' : 'border-slate-200'}`}
              />
              {noteError && (
                <p className="text-[11px] font-semibold text-red-700">{noteError}</p>
              )}
              {!isOfferFormLocked && !requiresDirector && (
                <p className="text-[11px] text-slate-500">Only needed when an offer gives away more than the Account Manager limit and requires Director approval.</p>
              )}
            </div>

            {/* Calculated Saved MRR Box — only meaningful when a discount is actually
                proposed; a walkthrough-only offer has no MRR impact to show here. */}
            {selectedDiscount > 0 ? (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-5 space-y-3">
                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider block">Financial Impact Calculation</span>

                {/* Stated over the whole term, not per month: a discount now runs for a
                    set number of months, so a monthly figure alone cannot say what the
                    offer costs. The third tile previously showed the post-discount MRR
                    again and labelled it "Saved", which described the revenue retained
                    as though it were the saving - and disagreed with the email modal,
                    where "savings" means the amount given up. */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-center">
                  <div className="bg-white p-3 rounded-lg border border-slate-200">
                    <span className="text-[11px] text-slate-500 font-medium block">Full Contract Value (12 mo)</span>
                    <span className="text-lg font-bold text-slate-900">{formatMoney(account.mrr * MONTHS_PER_TERM)}</span>
                  </div>

                  <div className="bg-white p-3 rounded-lg border border-slate-200">
                    <span className="text-[11px] text-slate-500 font-medium block">
                      Customer Pays ({describeDiscount(selectedDiscount, selectedMonths)})
                    </span>
                    <span className="text-lg font-bold text-slate-900">{formatMoney(offerTermValue)}</span>
                  </div>

                  <div className="bg-amber-50 p-3 rounded-lg border border-amber-200">
                    <span className="text-[11px] text-amber-800 font-medium block">Revenue Given Up</span>
                    <span className="text-lg font-extrabold text-amber-700">{formatMoney(offerGiveback)}</span>
                  </div>
                </div>

                {/* When the money actually starts moving. A discount covers the first
                    months of the UPCOMING term, so nothing changes until the renewal —
                    which the form had no way of saying, leaving a Manager to assume the
                    rate dropped on approval. */}
                {account.contractRenewalDate && (
                  <p className="text-[11px] text-slate-600 border-t border-slate-200 pt-3">
                    Takes effect at renewal on{' '}
                    <strong className="text-slate-900">{formatTermDate(account.contractRenewalDate)}</strong>
                    {' '}and runs to{' '}
                    <strong className="text-slate-900">
                      {formatTermDate(addMonths(new Date(account.contractRenewalDate), selectedMonths))}
                    </strong>
                    . Until then {account.name} continues to pay {formatMoney(account.mrr)}/month.
                  </p>
                )}
              </div>
            ) : includeWalkthrough ? (
              <div className="bg-violet-50 border border-violet-200 rounded-xl p-5 flex items-start space-x-2.5 text-xs text-violet-900">
                <Wrench className="w-4 h-4 text-violet-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-bold uppercase tracking-wider text-[11px]">Walkthrough-Only Offer</p>
                  <p className="mt-0.5">No discount applied — the full {formatMoney(account.mrr * MONTHS_PER_TERM)} contract value stays unchanged. This offer is the walkthrough session only.</p>
                </div>
              </div>
            ) : null}

            {/* A recorded intent decides this account's outcome at the renewal, and giving a
                discount does nothing to it. Save the customer, forget the intent, and the
                renewal is still recorded as a churn: the account is closed, the discount never
                takes effect, and the training row says the offer failed on the very row that
                proves it worked. The offer form is where that mistake gets made, so the warning
                belongs here rather than only on the Renewals page. */}
            {liveIntent && (
              <div className="p-4 rounded-xl border text-xs space-y-2.5 bg-amber-50/90 border-amber-300 text-amber-950">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                  <span className="uppercase tracking-wider font-extrabold text-xs">
                    {liveIntent.kind === 'churning'
                      ? 'This account is set to churn at its renewal'
                      : `This account is set to ${liveIntent.kind === 'upgrading' ? 'upgrade' : 'downgrade'}${liveIntent.targetTier ? ` to ${liveIntent.targetTier}` : ''} at its renewal`}
                  </span>
                </div>
                <p className="leading-relaxed">
                  Recorded {liveIntent.recordedBy ? `by ${liveIntent.recordedBy}` : 'automatically'} for{' '}
                  <strong>{formatTermDate(liveIntent.effectiveFor)}</strong>. A discount does not change this on
                  its own — {liveIntent.kind === 'churning'
                    ? 'if the customer has agreed to stay, cancel it, or the account will be recorded as churned whatever offer you make.'
                    : 'if the customer has agreed to stay on their current plan, cancel it, or they will be repriced at the renewal anyway.'}
                </p>
                <button
                  type="button"
                  onClick={handleCancelIntent}
                  disabled={isCancellingIntent}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-900 text-white hover:bg-amber-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {isCancellingIntent ? 'Cancelling...' : 'Cancel it'}
                </button>
              </div>
            )}

            {/* Pending / Reviewed Request Status Container */}
            {activeDirectorRequest && activeDirectorRequest.status !== 'withdrawn' && !(activeDirectorRequest.status !== 'pending' && isRequestBannerDismissed) && (
              <div className={`p-5 rounded-xl border space-y-4 text-xs ${
                activeDirectorRequest.status === 'pending'
                  ? 'bg-amber-50/90 border-amber-300 text-amber-950'
                  : activeDirectorRequest.status === 'rejected'
                  ? 'bg-red-50 border-red-300 text-red-950 shadow-sm'
                  : 'bg-emerald-50 border-emerald-300 text-emerald-950 shadow-sm'
              }`}>
                <div className="flex items-center justify-between border-b pb-3 border-current/20">
                  <div className="flex items-center space-x-2 font-bold">
                    {activeDirectorRequest.status === 'pending' && <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />}
                    {activeDirectorRequest.status === 'rejected' && <XCircle className="w-4 h-4 text-red-600 shrink-0" />}
                    {activeDirectorRequest.status === 'approved' && <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />}
                    <span className="uppercase tracking-wider font-extrabold text-xs">
                      {activeDirectorRequest.status === 'pending' && `Discount Request Pending Director Approval (${activeDirectorRequest.discountPct}%)${activeDirectorRequest.includesWalkthrough ? ' + Walkthrough' : ''}`}
                      {activeDirectorRequest.status === 'rejected' && `Discount Request Rejected by Account Director (${activeDirectorRequest.discountPct}%)${activeDirectorRequest.includesWalkthrough ? ' + Walkthrough Also Rejected' : ''}`}
                      {activeDirectorRequest.status === 'approved' && `Discount Request Approved (${activeDirectorRequest.discountPct}%)${activeDirectorRequest.includesWalkthrough ? ' + Walkthrough' : ''}`}
                    </span>
                  </div>
                  <div className="flex items-center space-x-3 shrink-0">
                    <span className="text-[11px] opacity-75 font-mono">{activeDirectorRequest.requestedAt}</span>
                    {activeDirectorRequest.status !== 'pending' && (
                      <button
                        type="button"
                        onClick={() => setIsRequestBannerDismissed(true)}
                        aria-label="Dismiss"
                        className="text-current/60 hover:text-current cursor-pointer leading-none"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>

                {/* Manager Note */}
                <div className="space-y-1">
                  <span className="font-bold block text-[11px] uppercase opacity-75">Account Manager Note:</span>
                  <p className="italic bg-white/70 p-2.5 rounded border border-current/10 font-medium">
                    "{activeDirectorRequest.managerNote || 'No remark provided.'}"
                  </p>
                </div>

                {/* Director Remarks Display if available */}
                {activeDirectorRequest.directorNote && (
                  <div className="space-y-1 pt-1">
                    <span className="font-bold block text-[11px] uppercase tracking-wider text-red-900 flex items-center space-x-1">
                      <MessageSquare className="w-3.5 h-3.5 text-red-700" />
                      <span>Account Director Decision Remark / Reason:</span>
                    </span>
                    <p className="bg-white p-3 rounded-lg border border-red-200 text-red-950 font-medium text-xs shadow-xs leading-relaxed">
                      "{activeDirectorRequest.directorNote}"
                    </p>
                  </div>
                )}

                {/* Director Action Form if pending */}
                {activeDirectorRequest.status === 'pending' && (
                  isDirector ? (
                    <div className="pt-3 border-t border-amber-200 space-y-3">
                      <label className="block text-xs font-bold text-amber-950 uppercase tracking-wider flex items-center space-x-1">
                        <MessageSquare className="w-3.5 h-3.5 text-amber-800" />
                        <span>Account Director Review Note / Remark</span>
                      </label>
                      <textarea
                        rows={2}
                        value={directorNote}
                        onChange={(e) => setDirectorNote(e.target.value)}
                        placeholder="Type approval or rejection reason for the Account Manager..."
                        className="w-full text-xs p-3 border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-900 bg-white text-slate-900 resize-none"
                      />

                      <div className="flex items-center space-x-3 pt-1">
                        <button
                          type="button"
                          onClick={handleDirectorApprove}
                          className="px-4 py-2.5 bg-emerald-700 hover:bg-emerald-800 text-white rounded-lg font-bold text-xs flex items-center space-x-1.5 transition shadow cursor-pointer"
                        >
                          <ShieldCheck className="w-4 h-4" />
                          <span>Approve & Launch Biometric Scan</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleDirectorReject}
                          className="px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg font-bold text-xs flex items-center space-x-1.5 transition shadow cursor-pointer"
                        >
                          <XCircle className="w-4 h-4" />
                          <span>Reject Request</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="pt-2 border-t border-amber-200 space-y-2">
                      <p className="text-[11px] font-medium text-amber-900">
                        Request submitted to Account Director for review.
                      </p>
                      {/* Only a saved request can be withdrawn - the one just submitted has no id until
                          the refreshed data arrives. The server also checks it is the sender's own. */}
                      {globalReq?.status === 'pending' && (
                        withdrawMode === 'request' ? (
                          <div className="space-y-2">
                            <p className="text-[11px] text-amber-900">
                              Withdraw this request? You can make a new offer afterwards.
                            </p>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={handleWithdraw}
                                disabled={isWithdrawing}
                                className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-amber-900 text-white hover:bg-amber-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
                              >
                                {isWithdrawing ? 'Withdrawing...' : 'Withdraw request'}
                              </button>
                              <button
                                type="button"
                                onClick={() => { setWithdrawMode(null); setWithdrawReason(''); }}
                                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-amber-900 hover:underline cursor-pointer"
                              >
                                Keep it
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setWithdrawMode('request'); setWithdrawReason(''); }}
                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 transition-colors cursor-pointer"
                          >
                            Withdraw request
                          </button>
                        )
                      )}
                    </div>
                  )
                )}
              </div>
            )}

            {/* Execute / Send Request Button */}
            <div className="pt-2 flex justify-end">
              <button
                type="button"
                onClick={handleDiscountSubmit}
                disabled={isOfferFormLocked}
                className={`px-6 py-3 rounded-xl font-bold text-xs transition flex items-center space-x-2 shadow-md cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none ${
                  requiresDirector
                    ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 font-black'
                    : 'bg-slate-900 hover:bg-slate-800 text-white'
                }`}
              >
                <ShieldCheck className="w-4 h-4" />
                <span>
                  {isAwaitingDirectorDecision
                    ? 'Awaiting Account Director Decision'
                    : hasActiveDiscount
                    ? 'Discount Already Applied'
                    : requiresDirector
                    ? `Send ${includeWalkthrough ? 'discount + walkthrough' : 'discount'} request to Account Director for approval`
                    : `Execute ${
                        selectedDiscount > 0 && includeWalkthrough
                          ? `${describeDiscount(selectedDiscount, selectedMonths)} + Walkthrough`
                          : selectedDiscount > 0
                          ? describeDiscount(selectedDiscount, selectedMonths)
                          : 'Walkthrough'
                      } (Direct Approval)`}
                </span>
              </button>
            </div>

          </div>
        )}

      </div>

      {/* Biometric Face Verification Modal for >10% Overrides */}
      <FaceVerificationModal
        isOpen={showFaceModal}
        onClose={() => setShowFaceModal(false)}
        accountName={account.name}
        discountPct={selectedDiscount}
        onVerified={handleFaceVerified}
      />

      {/* Offer email: review it, then grant the offer (apply or approve) and send it */}
      <DiscountEmailModal
        isOpen={showEmailModal}
        onClose={() => setShowEmailModal(false)}
        account={account}
        discountPct={emailPct}
        discountMonths={emailMonths}
        verificationStatus={emailVerificationStatus}
        currentUser={currentUser}
        onConfirm={confirmOffer}
        confirmVerb={isApprovingRequest ? 'Approve' : 'Apply'}
        includeWalkthrough={emailWalkthrough}
      />

    </div>
  );
};
