import React, { useState } from 'react';
import { Account, RenewalRecord, RenewalIntent, IntentKind, PlanTierName } from '../types';
import { formatTermDate, formatMoney, TIER_MONTHLY_RATE, annualContractValue, tierMoves } from '../../pricing';
import { useToast } from './Toast';
import { useModalA11y } from '../hooks/useModalA11y';
import {
  CalendarClock, CheckCircle2, XCircle, TrendingUp, TrendingDown, Bot, AlertTriangle, Ban,
} from 'lucide-react';

interface RenewalsViewProps {
  accounts: Account[];
  renewalRecords: RenewalRecord[];
  renewalIntents: RenewalIntent[];
  onRefresh: () => Promise<unknown>;
}

const OUTCOME_STYLE: Record<string, { label: string; cls: string; Icon: React.ElementType }> = {
  renewed:    { label: 'Renewed',    cls: 'bg-emerald-50 text-emerald-800 border-emerald-200', Icon: CheckCircle2 },
  upgraded:   { label: 'Upgraded',   cls: 'bg-indigo-50 text-indigo-800 border-indigo-200',    Icon: TrendingUp },
  downgraded: { label: 'Downgraded', cls: 'bg-amber-50 text-amber-900 border-amber-200',       Icon: TrendingDown },
  left:       { label: 'Churned',    cls: 'bg-red-50 text-red-800 border-red-200',             Icon: XCircle },
};

// Did the model call this one correctly?
//
// This is the column the Audit Log could never have, and the reason this table is not a
// duplicate of it: the ledger records what was done, this records what the models
// predicted versus what actually happened. It is a confusion matrix, one row at a time.
//
// The band comes from the server's canonical fusionRiskCategory — the UI deliberately
// does not own a second copy of the >70 / >30 thresholds.
function scorePrediction(band: string | null, retained: boolean) {
  if (!band) return null;
  const flaggedAtRisk = band === 'High Risk';
  if (flaggedAtRisk && !retained) {
    return { label: 'Caught', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
             hint: 'Flagged as High Risk, and the account did leave.' };
  }
  if (!flaggedAtRisk && retained) {
    return { label: 'Correct', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
             hint: 'Not flagged as High Risk, and the account stayed.' };
  }
  if (!flaggedAtRisk && !retained) {
    return { label: 'Missed', cls: 'bg-red-50 text-red-800 border-red-200',
             hint: 'The account left without being flagged as High Risk — the model did not see this coming.' };
  }
  return { label: 'False alarm', cls: 'bg-amber-50 text-amber-900 border-amber-200',
           hint: 'Flagged as High Risk but the account stayed. Not necessarily wrong: a discount may be why it stayed.' };
}

const INTENT_LABEL: Record<IntentKind, string> = {
  upgrading: 'Will upgrade',
  downgrading: 'Will downgrade',
  churning: 'Will not renew',
};

export const RenewalsView: React.FC<RenewalsViewProps> = ({
  accounts, renewalRecords, renewalIntents, onRefresh,
}) => {
  const { showToast } = useToast();
  const [intentModalFor, setIntentModalFor] = useState<Account | null>(null);
  const [busy, setBusy] = useState(false);

  const autoCount = renewalRecords.filter(r => r.autoRecorded).length;
  const churnCount = renewalRecords.filter(r => !r.retained).length;

  const cancelIntent = async (intent: RenewalIntent) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/renewal-intents/${intent.id}/cancel`, { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to cancel.');
      showToast(`Cancelled — ${intent.accountName} will now renew as normal.`, 'success');
      await onRefresh();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const correctOutcome = async (record: RenewalRecord, outcome: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/renewals/${record.id}/correct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to correct.');
      showToast(`${record.accountName}'s renewal corrected to "${outcome}".`, 'success');
      await onRefresh();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-900">Renewals</h2>
        <p className="text-xs text-slate-500 mt-1 max-w-3xl">
          Annual contracts renew automatically unless notice is given, so outcomes are recorded at the
          term boundary without anyone filling in a form. Record an intent only when an account is
          doing something other than renewing as-is — it does not affect the contract until that renewal date.
        </p>
        <p className="text-xs text-slate-500 mt-1.5 max-w-3xl">
          Customers can also give notice by email, with the subject <strong>RetainIO Renewal Notice: &lt;company&gt;</strong> and
          the line <code>Request: Upgrade</code>, <code>Request: Downgrade</code> or <code>Request: Not renewing</code> — plus{' '}
          <code>Plan: &lt;tier&gt;</code> for a plan change. Those appear here marked "from email", and an email never
          replaces a notice recorded here.
        </p>
      </div>

      {/* Honesty tiles. The auto-recorded count is the one that matters: it says how much
          of this history is assumption rather than confirmation, and the training export
          carries the same flag so a future result can be read in that light. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <span className="text-slate-500 text-[11px] font-medium uppercase tracking-wider block">Renewals Recorded</span>
          <div className="text-2xl font-bold text-slate-900">{renewalRecords.length}</div>
          <span className="text-[11px] text-slate-500">{churnCount} ended in churn</span>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <span className="text-slate-500 text-[11px] font-medium uppercase tracking-wider block">Assumed, Not Confirmed</span>
          <div className="text-2xl font-bold text-amber-700">{autoCount}</div>
          <span className="text-[11px] text-slate-500">
            {autoCount ? 'Auto-renewed with no intent recorded' : 'Every outcome was intent-driven'}
          </span>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-xs">
          <span className="text-slate-500 text-[11px] font-medium uppercase tracking-wider block">Pending Intents</span>
          <div className="text-2xl font-bold text-sky-700">{renewalIntents.length}</div>
          <span className="text-[11px] text-slate-500">Held until their renewal date</span>
        </div>
      </div>

      {/* Pending intents — the hold window, where an intent can still be taken back. */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <h3 className="font-bold text-sm text-slate-900">Pending Intents</h3>
          <span className="text-[11px] text-slate-500">Nothing changes until the renewal date</span>
        </div>
        {renewalIntents.length === 0 ? (
          <p className="px-5 py-6 text-xs text-slate-500">
            No intents recorded. Every account will renew as-is at its next renewal.
          </p>
        ) : (
          <div className="divide-y divide-slate-100">
            {renewalIntents.map(intent => (
              <div key={intent.id} className="px-5 py-3 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-sm text-slate-900">{intent.accountName}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${
                      intent.kind === 'churning'
                        ? 'bg-red-50 text-red-800 border-red-200'
                        : 'bg-sky-50 text-sky-800 border-sky-200'
                    }`}>
                      {INTENT_LABEL[intent.kind]}
                      {intent.targetTier ? ` → ${intent.targetTier}` : ''}
                    </span>
                    {intent.source === 'email' && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-violet-50 text-violet-800 border-violet-200 flex items-center gap-1">
                        <Bot className="w-3 h-3" /> from email
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    Applies at renewal on <strong className="text-slate-700">{formatTermDate(intent.effectiveFor)}</strong>
                    {intent.recordedBy ? ` · recorded by ${intent.recordedBy}` : ' · recorded automatically'}
                  </p>
                </div>
                <button
                  onClick={() => cancelIntent(intent)}
                  disabled={busy}
                  className="shrink-0 text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 px-3 py-1.5 rounded-lg transition disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
                >
                  <Ban className="w-3.5 h-3.5" /> Cancel
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Record an intent */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs px-5 py-4">
        <h3 className="font-bold text-sm text-slate-900">Record an intent</h3>
        <p className="text-[11px] text-slate-500 mt-0.5 mb-3">
          For an account that is not simply renewing as-is. Takes effect only at that account's renewal.
        </p>
        <div className="flex flex-wrap gap-2">
          {accounts.map(a => (
            <button
              key={a.id}
              onClick={() => setIntentModalFor(a)}
              className="text-xs font-semibold text-slate-700 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-lg transition cursor-pointer"
            >
              {a.name}
              <span className="text-slate-400 font-normal">
                {' '}· {a.contractRenewalDate ? formatTermDate(a.contractRenewalDate) : 'no renewal'}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* History */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-xs overflow-hidden">
        {/* Deliberately NOT a second copy of the Audit Log. The ledger records what was
            done and who did it; this records what the models predicted against what
            actually happened, and is the labelled dataset the retraining step exports.
            It also has to be editable, which an append-only audit trail cannot be. */}
        <div className="px-5 py-3 border-b border-slate-200">
          <h3 className="font-bold text-sm text-slate-900">Model Feedback</h3>
          <p className="text-[11px] text-slate-500 mt-0.5 max-w-3xl">
            Every resolved renewal becomes one labelled training row: what the account looked like,
            what offer it had, and whether it stayed. The Audit Log records that these renewals
            happened — this records whether the models were right about them.
          </p>
          {autoCount > 0 && (
            /* A verdict measured against an assumed outcome is only as good as the
               assumption. Saying so here is the difference between a scorecard and a
               claim: the same flag rides along into the training export for the same reason. */
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>
                {autoCount} of {renewalRecords.length} outcomes were assumed rather than confirmed —
                no intent was recorded and nobody verified them. Verdicts on those rows are only as
                reliable as the assumption that silence meant renewal.
              </span>
            </p>
          )}
        </div>
        {renewalRecords.length === 0 ? (
          <p className="px-5 py-6 text-xs text-slate-500">
            No renewals have come round yet. The first will be recorded automatically on its renewal date.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider text-[10px]">
                <tr>
                  <th className="text-left font-bold px-5 py-2.5">Account</th>
                  <th className="text-left font-bold px-4 py-2.5">Renewal</th>
                  <th className="text-left font-bold px-4 py-2.5">Model Predicted</th>
                  <th className="text-left font-bold px-4 py-2.5">Actually</th>
                  <th className="text-left font-bold px-4 py-2.5">Verdict</th>
                  <th className="text-left font-bold px-4 py-2.5">Offer In Force</th>
                  <th className="text-left font-bold px-4 py-2.5">Source</th>
                  <th className="text-right font-bold px-5 py-2.5">Correct</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {renewalRecords.map(r => {
                  const style = OUTCOME_STYLE[r.outcome];
                  const tierChanged = r.planTierBefore !== r.planTierAfter;
                  const verdict = scorePrediction(r.predictedBand, r.retained);
                  return (
                    <tr key={r.id} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3 font-bold text-slate-900">
                        {r.accountName}
                        {tierChanged && (
                          <span className="block text-[10px] font-normal text-slate-500">
                            {r.planTierBefore} → {r.planTierAfter}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600">{formatTermDate(r.renewalDate)}</td>
                      {/* Prediction first, outcome second, verdict third — read left to
                          right it says "the model thought X, in fact Y, so Z". */}
                      <td className="px-4 py-3 text-slate-600">
                        {r.predictedRisk === null ? '—' : (
                          <>
                            <strong className="text-slate-900">{Math.round(r.predictedRisk * 100)}%</strong>
                            <span className="block text-[10px] text-slate-500">{r.predictedBand}</span>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded border inline-flex items-center gap-1 ${style.cls}`}>
                          <style.Icon className="w-3 h-3" /> {style.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {verdict ? (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded border ${verdict.cls}`}
                                title={verdict.hint}>
                            {verdict.label}
                          </span>
                        ) : <span className="text-[10px] text-slate-400">no prediction</span>}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {r.discountPct > 0 ? `${r.discountPct}% for ${r.discountMonths} mo` : 'none'}
                      </td>
                      <td className="px-4 py-3">
                        {r.autoRecorded ? (
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-amber-50 text-amber-900 border-amber-200 inline-flex items-center gap-1"
                                title="No intent was recorded and nobody confirmed this. It was assumed to renew.">
                            <AlertTriangle className="w-3 h-3" /> assumed
                          </span>
                        ) : (
                          <span className="text-[10px] text-slate-500">{r.recordedBy || 'intent'}</span>
                        )}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <select
                          value={r.outcome}
                          disabled={busy}
                          onChange={e => correctOutcome(r, e.target.value)}
                          className="text-[11px] border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-700 cursor-pointer disabled:opacity-50"
                        >
                          <option value="renewed">Renewed</option>
                          <option value="upgraded">Upgraded</option>
                          <option value="downgraded">Downgraded</option>
                          <option value="left">Churned</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {intentModalFor && (
        <IntentModal
          account={intentModalFor}
          onClose={() => setIntentModalFor(null)}
          onSaved={async () => { setIntentModalFor(null); await onRefresh(); }}
        />
      )}
    </div>
  );
};

// Every intent this account could actually carry out at its renewal, built from its current
// plan: an Enterprise account is never offered an upgrade, nor a Basic one a downgrade. The
// old generic options fed an all-tiers dropdown, which let Enterprise "upgrade" to Basic.
interface IntentOption {
  kind: IntentKind;
  targetTier?: PlanTierName;
  label: string;
  description: string;
}

const optionKey = (o: IntentOption) => `${o.kind}:${o.targetTier ?? ''}`;

function intentOptions(currentTier: PlanTierName): IntentOption[] {
  const { upgrades, downgrades } = tierMoves(currentTier);
  const toOption = (kind: IntentKind, verb: string, tier: PlanTierName): IntentOption => ({
    kind,
    targetTier: tier,
    label: `${verb} to ${tier}`,
    description: `${formatMoney(TIER_MONTHLY_RATE[tier])}/month (${formatMoney(annualContractValue(TIER_MONTHLY_RATE[tier]))}/year) from the renewal.`,
  });
  return [
    { kind: 'churning', label: INTENT_LABEL.churning,
      description: 'The customer has given notice. The account will churn at the renewal, and retention discounts open for it straight away.' },
    ...downgrades.map(t => toOption('downgrading', 'Downgrade', t)),
    ...upgrades.map(t => toOption('upgrading', 'Upgrade', t)),
  ];
}

const IntentModal: React.FC<{ account: Account; onClose: () => void; onSaved: () => void }> = ({
  account, onClose, onSaved,
}) => {
  const { showToast } = useToast();
  const { dialogRef, backdropProps } = useModalA11y(true, onClose);
  const currentTier = account.subscriptionType;
  const options = intentOptions(currentTier);
  const [selectedKey, setSelectedKey] = useState(() => optionKey(options[0]));
  const [saving, setSaving] = useState(false);

  const selected = options.find(o => optionKey(o) === selectedKey) ?? options[0];

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/accounts/${account.id}/renewal-intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: selected.kind, targetTier: selected.targetTier }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to record the intent.');
      showToast(
        `Recorded. ${account.name} is unchanged until its renewal on ${formatTermDate(body.effectiveFor)}.`,
        'success',
      );
      onSaved();
    } catch (e: any) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 flex items-center justify-center z-50 p-4" {...backdropProps}>
      <div ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1}
           className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4">
        <div>
          <h3 className="font-bold text-slate-900">Renewal intent — {account.name}</h3>
          <p className="text-[11px] text-slate-500 mt-1">
            Currently on <strong className="text-slate-700">{currentTier}</strong>
            {' '}— {formatMoney(TIER_MONTHLY_RATE[currentTier])}/month.
          </p>
          <p className="text-[11px] text-slate-500 mt-1 flex items-start gap-1.5">
            <CalendarClock className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span>
              Nothing changes now. This is held until{' '}
              <strong className="text-slate-700">
                {account.contractRenewalDate ? formatTermDate(account.contractRenewalDate) : 'the renewal'}
              </strong>{' '}
              and applied then — and can be cancelled any time before.
            </span>
          </p>
        </div>

        <div className="space-y-2">
          {options.map(o => {
            const key = optionKey(o);
            return (
              <label key={key} className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition ${
                selectedKey === key ? 'border-slate-900 bg-slate-50' : 'border-slate-200 hover:bg-slate-50'
              }`}>
                <input type="radio" name="intent" value={key} checked={selectedKey === key}
                       onChange={() => setSelectedKey(key)} className="mt-0.5 cursor-pointer" />
                <span className="text-xs">
                  <strong className="text-slate-900 block">{o.label}</strong>
                  <span className="text-slate-500">{o.description}</span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={saving}
                  className="text-xs font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-lg transition disabled:opacity-50 cursor-pointer">
            Cancel
          </button>
          <button onClick={save} disabled={saving}
                  className="text-xs font-bold text-white bg-slate-900 hover:bg-slate-800 px-4 py-2 rounded-lg transition disabled:opacity-50 cursor-pointer">
            {saving ? 'Recording…' : 'Record intent'}
          </button>
        </div>
      </div>
    </div>
  );
};
