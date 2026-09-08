import React, { useState, useEffect } from 'react';
import { Account, UserProfile } from '../types';
import { Mail, Send, Sparkles, Check, Copy, X, ShieldCheck, Building2, User, DollarSign, FileText } from 'lucide-react';
import { useModalA11y } from '../hooks/useModalA11y';
import {
  MONTHS_PER_TERM, annualContractValue, discountedTermValue, givebackValue, formatMoney,
} from '../../pricing';

interface DiscountEmailModalProps {
  isOpen: boolean;
  onClose: () => void;
  account: Account;
  discountPct: number;
  // How many months of the upcoming term the discount covers. The email states a
  // price to a customer, so it has to say how long that price lasts.
  discountMonths: number;
  verificationStatus: 'Direct Approval (Within Manager Limit)' | 'Face Verified (Biometric Pass)';
  currentUser?: UserProfile;
  onSendAndApply: () => void;
  includeWalkthrough?: boolean;
}

export const DiscountEmailModal: React.FC<DiscountEmailModalProps> = ({
  isOpen,
  onClose,
  account,
  discountPct,
  discountMonths,
  verificationStatus,
  currentUser,
  onSendAndApply,
  includeWalkthrough,
}) => {
  const hasDiscount = discountPct > 0;
  // Stated over the full 12-month term, not per month. A discount now runs for a set
  // number of months, so "savings of $1,812" was ambiguous - once a month, or twelve
  // times? These figures come from pricing.ts, the same helpers the approval gate and
  // the offer form use, so the customer sees exactly what was approved internally.
  const newMrr = Math.round(account.mrr * (1 - discountPct / 100));
  const fullTermValue = annualContractValue(account.mrr);
  const termValue = discountedTermValue(account.mrr, discountPct, discountMonths);
  const savings = givebackValue(account.mrr, discountPct, discountMonths);
  const monthsLabel = `${discountMonths} ${discountMonths === 1 ? 'month' : 'months'}`;
  const recipientEmail = `${account.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.contact@enterprise.com`;

  const offerLabel = hasDiscount && includeWalkthrough
    ? `${discountPct}% Retention Rate Lock for ${monthsLabel} + Walkthrough`
    : hasDiscount
    ? `${discountPct}% Retention Rate Lock for ${monthsLabel}`
    : 'Product Walkthrough Offer';

  const initialSubject = `[Exclusive Renewal Offer] RetainIO ${offerLabel} for ${account.name}`;

  const offerSummary = hasDiscount
    ? `Offer Details Summary:
• Account: ${account.name}
• Standard Monthly Rate: ${formatMoney(account.mrr)} (${formatMoney(fullTermValue)} across the ${MONTHS_PER_TERM}-month term)
• Proposed Retention Discount: ${discountPct}% for the first ${monthsLabel} of the term
• Discounted Monthly Rate: ${formatMoney(newMrr)} for ${monthsLabel}, then ${formatMoney(account.mrr)}
• Total You Pay Across the Term: ${formatMoney(termValue)}
• Total Saving: ${formatMoney(savings)}`
    : `Offer Details Summary:
• Account: ${account.name}
• Offer Type: Dedicated Product Walkthrough Session (no discount applied)`;

  // Only needed as an add-on when there's also a discount — the walkthrough-only opening
  // line below already covers it fully when there's no discount to describe alongside it.
  const walkthroughParagraph = includeWalkthrough && hasDiscount
    ? `\n\nAs part of this retention plan, we've also scheduled a dedicated product walkthrough session with your Customer Success team to work through any technical friction directly with your team.`
    : '';

  const openingLine = hasDiscount
    ? `Following a thorough evaluation of your usage metrics and upcoming contract renewal date (${account.contractRenewalDate}), we are pleased to offer an exclusive ${discountPct}% Retention Discount for the first ${monthsLabel} of your next ${MONTHS_PER_TERM}-month term.`
    : `Following a thorough evaluation of your usage metrics and upcoming contract renewal date (${account.contractRenewalDate}), we'd like to schedule a dedicated product walkthrough session with your team to work through any open issues directly.`;

  const initialBody = `Dear ${account.name} Executive Leadership Team,

I hope this message finds you well.

${openingLine}${walkthroughParagraph}

${offerSummary}

Governance & Compliance Verification:
• Authorization Level: ${verificationStatus}
• Approved By: ${currentUser?.name || 'Account Manager'} (${currentUser?.title || 'Client Success'})

This retention plan locks in full access to your current enterprise tier, dedicated customer support SLA, and continuous platform feature updates.

Please confirm by replying to this email to accept these revised terms for your upcoming renewal cycle.

Best regards,

${currentUser?.name || 'Account Director'}
${currentUser?.title || 'Revenue Retention Lead'} | RetainIO
Email: ${currentUser?.email || 'manager@retain.io'}`;

  const [subject, setSubject] = useState<string>(initialSubject);
  const [body, setBody] = useState<string>(initialBody);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [isPolishing, setIsPolishing] = useState<boolean>(false);
  const [polishError, setPolishError] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const { dialogRef, backdropProps } = useModalA11y(isOpen, onClose, { closeOnBackdropClick: false });

  // This modal instance stays mounted (just hidden) between offers, so `useState(initialBody)`
  // only captures whatever discountPct/includeWalkthrough happened to be true the very first
  // time it ever mounted. Regenerate the draft fresh every time it's actually opened, so a
  // walkthrough-only or discount+walkthrough offer doesn't show stale copy from an earlier draft.
  useEffect(() => {
    if (isOpen) {
      setSubject(initialSubject);
      setBody(initialBody);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopy = () => {
    navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handlePolishWithAI = async () => {
    setIsPolishing(true);
    try {
      const response = await fetch('/api/gemini/polish-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject,
          body,
          accountName: account.name,
          discountPct
        })
      });
      const data = await response.json();

      // Every failure here used to be a silent no-op: the endpoint returned the
      // untouched draft with a 200 and the client only logged to the console,
      // so clicking Polish and nothing happening was indistinguishable from a
      // polish that had chosen to change nothing. The server now refuses a
      // rewrite that altered any figure, and that reason has to reach the user.
      if (!response.ok) {
        setPolishError(data?.error || 'Could not polish this email. Your draft is unchanged.');
        return;
      }

      setPolishError(null);
      if (data.subject) setSubject(data.subject);
      if (data.body) setBody(data.body);
    } catch (err) {
      console.error('Failed to polish email with AI:', err);
      setPolishError('Could not reach the AI to polish this email. Your draft is unchanged.');
    } finally {
      setIsPolishing(false);
    }
  };

  const handleSend = () => {
    setIsSending(true);
    setTimeout(() => {
      setIsSending(false);
      onSendAndApply();
    }, 900);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn overflow-y-auto"
      {...backdropProps}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="discount-email-title"
        tabIndex={-1}
        className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-2xl w-full overflow-hidden relative my-8 focus:outline-none"
      >

        {/* Header Bar */}
        <div className="bg-slate-900 text-white p-5 sm:p-6 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/30 border border-indigo-400/30 flex items-center justify-center text-indigo-400">
              <Mail className="w-5 h-5" />
            </div>
            <div>
              <h2 id="discount-email-title" className="text-base font-bold text-white flex items-center space-x-2">
                <span>Review & Dispatch Retention Offer Email</span>
              </h2>
              <p className="text-xs text-slate-400">
                Draft client communication for {account.name} ({offerLabel})
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            aria-label="Close email review dialog"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Verification Status Badge */}
        <div className="bg-slate-50 border-b border-slate-200 px-6 py-2.5 flex items-center justify-between text-xs">
          <div className="flex items-center space-x-2">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span className="font-semibold text-slate-700">Governance Status:</span>
            <span className="font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
              {verificationStatus}
            </span>
          </div>

          {hasDiscount ? (
            <div className="text-slate-500 font-mono text-[11px]">
              Given up: <strong className="text-slate-900">{formatMoney(savings)}</strong> <span className="text-slate-400">over the term</span>
            </div>
          ) : (
            <div className="text-slate-500 font-mono text-[11px]">
              <strong className="text-slate-900">Walkthrough Only</strong> — no discount
            </div>
          )}
        </div>

        {/* Form Body */}
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          
          {/* Recipient Field */}
          <div>
            <label htmlFor="email-recipient" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              To (Recipient)
            </label>
            <div className="relative">
              <input
                id="email-recipient"
                type="text"
                readOnly
                value={recipientEmail}
                className="w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-lg text-xs font-mono text-slate-800 font-medium"
              />
            </div>
          </div>

          {/* Subject Line */}
          <div>
            <label htmlFor="email-subject" className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
              Subject Line
            </label>
            <input
              id="email-subject"
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full px-3 py-2 bg-white border border-slate-300 rounded-lg text-xs font-semibold text-slate-900 focus:ring-2 focus:ring-slate-900 focus:outline-none transition"
            />
          </div>

          {/* Email Content Area */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="email-body" className="block text-xs font-bold text-slate-700 uppercase tracking-wider">
                Email Offer Copy
              </label>

              <button
                type="button"
                onClick={handlePolishWithAI}
                disabled={isPolishing}
                className="flex items-center space-x-1 text-[11px] font-bold text-indigo-600 hover:text-indigo-800 transition cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{isPolishing ? 'AI Refining...' : 'Polish with Gemini AI'}</span>
              </button>
            </div>

            {polishError && (
              <p className="mb-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                {polishError}
              </p>
            )}

            <textarea
              id="email-body"
              rows={11}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full p-3 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono text-slate-800 leading-relaxed focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
            />
          </div>

        </div>

        {/* Modal Footer Controls */}
        <div className="bg-slate-50 border-t border-slate-200 p-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center space-x-1.5 px-3.5 py-2 text-xs font-bold text-slate-700 bg-white border border-slate-300 rounded-xl hover:bg-slate-100 transition cursor-pointer w-full sm:w-auto justify-center"
          >
            {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4 text-slate-500" />}
            <span>{copied ? 'Copied Email' : 'Copy Draft'}</span>
          </button>

          <div className="flex items-center space-x-2 w-full sm:w-auto justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 text-xs font-bold text-slate-600 hover:text-slate-900 transition cursor-pointer"
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleSend}
              disabled={isSending}
              className="flex items-center justify-center space-x-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition shadow-md cursor-pointer shrink-0"
            >
              {isSending ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Dispatching Email & Applying {hasDiscount && includeWalkthrough ? 'Discount + Walkthrough' : hasDiscount ? 'Discount' : 'Walkthrough'}...</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  <span>Send Offer Email & Execute {hasDiscount && includeWalkthrough ? 'Discount + Walkthrough' : hasDiscount ? 'Discount' : 'Walkthrough'}</span>
                </>
              )}
            </button>
          </div>

        </div>

      </div>
    </div>
  );
};
