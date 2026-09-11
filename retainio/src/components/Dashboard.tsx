import React, { useState } from 'react';
// daysUntil comes from pricing.ts rather than being re-implemented here. This file used
// to carry its own copy using Math.ceil where the shared one uses Math.round — they agreed
// on today's data and would eventually not, and the difference is no longer cosmetic:
// 180 days now decides whether a discount may be offered at all, so a card reading "181d"
// while the offer form accepts it would be the same drift that put this dashboard's risk
// bands out of step with the canonical ones.
import { annualContractValue, formatTermDate, daysUntil } from '../../pricing';
import { Account, DiscountRequest } from '../types';
import { Search, ShieldAlert, Bot, Eye, Filter, CheckCircle2, ArrowUpDown, Layers, Clock, Mail } from 'lucide-react';
import { useToast } from './Toast';
import { RiskSparkline } from './RiskSparkline';
import { PortfolioTrajectoryCharts } from './PortfolioTrajectoryCharts';

interface DashboardProps {
  accounts: Account[];
  portfolioTrend?: { month: string; year: number; mrrRiskK: number; avgRiskPct: number }[];
  // Needed so a card can show a discount that's been requested but not yet
  // decided — that state lives on the request, not on the Account itself
  // (Account only carries currentDiscountApproved, the post-approval number).
  discountRequests?: DiscountRequest[];
  onSelectAccount: (account: Account) => void;
  onDiscussWithAdvisor: (account: Account) => void;
  onQuickApproveDiscount: (account: Account, discountPct: number) => void;
  // Reload after the mailbox check pulls in a review, so the new text and the re-scored
  // risk appear without the page having to be refreshed by hand.
  onInboxChecked?: () => void;
}


export const Dashboard: React.FC<DashboardProps> = ({
  accounts,
  portfolioTrend,
  discountRequests = [],
  onSelectAccount,
  onDiscussWithAdvisor,
  onQuickApproveDiscount,
  onInboxChecked
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [isCheckingInbox, setIsCheckingInbox] = useState(false);
  const { showToast } = useToast();

  const [selectedRiskFilter, setSelectedRiskFilter] = useState<'All' | 'High Risk' | 'Medium Risk' | 'Low Risk'>('All');
  const [selectedTierFilter, setSelectedTierFilter] = useState<'All' | 'Enterprise' | 'Pro' | 'Basic'>('All');
  const [sortBy, setSortBy] = useState<'default' | 'churnRisk' | 'mrrValue' | 'daysToRenewal'>('default');

  // Pulls any waiting feedback emails in now, rather than waiting out the two-minute poll.
  // The server does the matching and re-scoring; this only reports what happened.
  const handleCheckInbox = async () => {
    if (isCheckingInbox) return;
    setIsCheckingInbox(true);
    try {
      const res = await fetch('/api/inbox/check', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Could not check the mailbox.', 'error'); return; }

      // Unmatched emails are reported as loudly as ingested ones. An email naming an account
      // that does not exist produces no review and no visible change, so silence here would
      // read as "nothing had arrived" rather than "something arrived and was rejected".
      const parts: string[] = [];
      if (data.ingested) parts.push(`${data.ingested} review${data.ingested === 1 ? '' : 's'} ingested`);
      if (data.notices) parts.push(`${data.notices} renewal notice${data.notices === 1 ? '' : 's'} recorded`);
      if (data.unmatched) parts.push(`${data.unmatched} could not be matched to an account`);
      if (data.failed) parts.push(`${data.failed} failed`);
      showToast(
        parts.length ? parts.join(', ') + '.' : 'No new emails.',
        data.unmatched || data.failed ? 'info' : data.ingested || data.notices ? 'success' : 'info',
      );
      if (data.ingested || data.notices) onInboxChecked?.();
    } catch {
      showToast('Could not reach the server to check the mailbox.', 'error');
    } finally {
      setIsCheckingInbox(false);
    }
  };

  // One pass over the requests instead of a find() per rendered card.
  const pendingRequestByAccount = new Map(
    discountRequests.filter(r => r.status === 'pending').map(r => [r.accountId, r]),
  );

  const filteredAccounts = accounts
    .filter(acc => {
      const matchesSearch = acc.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            acc.industry.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            acc.accountManager.toLowerCase().includes(searchQuery.toLowerCase());
      
      const matchesRisk = selectedRiskFilter === 'All' || acc.riskCategory === selectedRiskFilter;

      const matchesTier = selectedTierFilter === 'All' || acc.subscriptionType === selectedTierFilter;

      return matchesSearch && matchesRisk && matchesTier;
    })
    .sort((a, b) => {
      if (sortBy === 'churnRisk') {
        return b.fusionRiskScore - a.fusionRiskScore; // Highest risk first
      }
      if (sortBy === 'mrrValue') {
        return b.effectiveMrr - a.effectiveMrr; // Highest actual billing first
      }
      if (sortBy === 'daysToRenewal') {
        return daysUntil(a.contractRenewalDate) - daysUntil(b.contractRenewalDate); // Closest renewal first
      }
      return 0;
    });

  const highRiskCount = accounts.filter(a => a.riskCategory === 'High Risk').length;
  // Stated annually: contracts are 12-month terms and a discount's cost is judged
  // over the term, so the monthly figure understated what is actually at stake.
  // ARR is derived here rather than stored - see pricing.ts.
  const highRisk = accounts.filter(a => a.riskCategory === 'High Risk');
  // effectiveMrr, not mrr: an account part-way through a retention discount is billing
  // less than its list rate, and the revenue actually at stake is what it currently pays.
  const totalArrAtRisk = annualContractValue(highRisk.reduce((sum, a) => sum + a.effectiveMrr, 0));

  // Contracts are annual, so an at-risk account cannot leave mid-term - the revenue
  // is lost at RENEWAL, not now. The tile used to read "Immediate Action Required",
  // which was untrue of the money: the outreach is urgent, the loss is months away.
  //
  // Naming a single date was no better - these accounts renew on different dates, so
  // quoting the earliest implied the whole sum was at stake that day. The subtext
  // says the total is spread across the accounts instead.
  // Only discounts that are actually running. This counted every account ever given a
  // discount — including ones whose renewal is months away and ones whose months ran out
  // long ago — so the tile never went down and never meant anything.
  const activeDiscountsCount = accounts.filter(a => a.discountState === 'active').length;
  const scheduledDiscountsCount = accounts.filter(a => a.discountState === 'offered').length;

  // A newly registered user manages nothing until accounts are assigned to
  // them. Showing the full command centre — empty KPI tiles, a flat portfolio
  // chart, filters over nothing — would read as broken, so say plainly what's
  // going on instead. This is distinct from the "no matching accounts" state
  // below, which means filters excluded everything.
  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 text-white p-6 rounded-xl border border-slate-800 shadow-sm">
          <div className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight text-white">Customer Retention Command Center</h1>
            <p className="text-xs text-slate-400">
              Real-time usage metrics fused with NLP sentiment classification to protect SaaS revenue.
            </p>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
          <Layers className="w-10 h-10 text-slate-300 mx-auto" />
          <p className="text-sm font-bold text-slate-700">No accounts assigned</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
            You don't manage any customer accounts yet. Once an Account Director assigns accounts to you,
            their churn risk, sentiment and retention tools will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Top Banner Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900 text-white p-6 rounded-xl border border-slate-800 shadow-sm">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <h1 className="text-xl font-bold tracking-tight text-white">Customer Retention Command Center</h1>
            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
              Live Analytics Engine
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Real-time usage metrics fused with NLP sentiment classification to protect SaaS revenue.
          </p>
        </div>

        <button
          onClick={handleCheckInbox}
          disabled={isCheckingInbox}
          title="Pull in any customer feedback and renewal notice emails waiting in the inbox now"
          className="flex items-center space-x-2 px-3.5 py-2 rounded-lg text-xs font-bold bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
        >
          <Mail className={`w-3.5 h-3.5 ${isCheckingInbox ? 'animate-pulse' : ''}`} />
          <span>{isCheckingInbox ? 'Checking inbox...' : 'Check inbox now'}</span>
        </button>
      </div>

      {/* Stats KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1 shadow-xs">
          <span className="text-slate-500 text-[11px] font-medium uppercase tracking-wider block">Total Accounts</span>
          <div className="text-2xl font-bold text-slate-900">{accounts.length}</div>
          <span className="text-[11px] text-slate-500">Active SaaS Portfolios</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1 shadow-xs">
          <span className="text-slate-500 text-[11px] font-medium uppercase tracking-wider block">High Risk Accounts</span>
          <div className="text-2xl font-bold text-red-600 flex items-center space-x-2">
            <span>{highRiskCount}</span>
            <ShieldAlert className="w-5 h-5 text-red-600 inline" />
          </div>
          <span className="text-[11px] text-red-600 font-semibold">&gt; 70% Churn Probability</span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1 shadow-xs">
          <span className="text-slate-500 text-[11px] font-medium uppercase tracking-wider block">ARR At Risk</span>
          <div className="text-2xl font-bold text-slate-900">${(totalArrAtRisk / 1000).toFixed(0)}k</div>
          <span className="text-[11px] text-slate-500">
            {highRisk.length
              ? `Across ${highRisk.length} ${highRisk.length === 1 ? 'account' : 'accounts'}, at their renewals`
              : 'No accounts at risk'}
          </span>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-1 shadow-xs">
          <span className="text-slate-500 text-[11px] font-medium uppercase tracking-wider block">Discounts In Effect</span>
          <div className="text-2xl font-bold text-emerald-700">{activeDiscountsCount}</div>
          {/* Scheduled offers are called out separately rather than folded into the
              headline: they are approved but cost nothing until their renewal arrives. */}
          <span className="text-[11px] text-slate-500">
            {scheduledDiscountsCount > 0
              ? `${scheduledDiscountsCount} more scheduled for a future renewal`
              : 'Currently reducing billed rates'}
          </span>
        </div>

      </div>

      {/* Portfolio Trajectory & Sentiment Health Charts */}
      <PortfolioTrajectoryCharts accounts={accounts} monthlyData={portfolioTrend} />

      {/* Filter & Search Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-xs space-y-3">
        
        <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
          {/* Search */}
          <div className="relative w-full lg:w-80">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search account name, industry, manager..."
              className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-4 py-1.5 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-slate-400"
            />
          </div>

          {/* Sort Control Dropdown */}
          <div className="flex items-center space-x-2">
            <div className="flex items-center space-x-1 text-xs text-slate-600 font-bold shrink-0">
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-700" />
              <span>Sort By:</span>
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="bg-slate-50 border border-slate-300 text-slate-900 font-semibold text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-slate-500 cursor-pointer shadow-2xs"
            >
              <option value="default">Default Order</option>
              <option value="churnRisk">Churn Risk (Highest First)</option>
              <option value="mrrValue">MRR Value (Highest First)</option>
              <option value="daysToRenewal">Days to Renewal (Closest First)</option>
            </select>
          </div>
        </div>

        {/* Filter Rows: Tier & Risk */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-slate-100">
          
          {/* Tier Filter */}
          <div className="flex items-center space-x-1.5 overflow-x-auto">
            <div className="flex items-center space-x-1 text-xs text-slate-500 font-semibold mr-1 shrink-0">
              <Layers className="w-3.5 h-3.5 text-slate-500" />
              <span>Tier:</span>
            </div>
            {(['All', 'Enterprise', 'Pro', 'Basic'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setSelectedTierFilter(t)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
                  selectedTierFilter === t
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-50 text-slate-600 border border-slate-200 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {t === 'All' ? 'All Tiers' : t}
              </button>
            ))}
          </div>

          {/* Risk Category Filter */}
          <div className="flex items-center space-x-1.5 overflow-x-auto">
            <div className="flex items-center space-x-1 text-xs text-slate-500 font-semibold mr-1 shrink-0">
              <Filter className="w-3.5 h-3.5 text-slate-500" />
              <span>Risk:</span>
            </div>
            {(['All', 'High Risk', 'Medium Risk', 'Low Risk'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setSelectedRiskFilter(r)}
                className={`px-3 py-1 rounded-lg text-xs font-semibold whitespace-nowrap transition cursor-pointer ${
                  selectedRiskFilter === r
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-slate-50 text-slate-600 border border-slate-200 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                {r === 'All' ? 'All Risks' : r}
              </button>
            ))}
          </div>

        </div>

      </div>

      {/* Accounts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredAccounts.length === 0 ? (
          <div className="col-span-full bg-white border border-slate-200 rounded-xl p-8 text-center space-y-2">
            <Filter className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-sm font-bold text-slate-700">No matching accounts found</p>
            <p className="text-xs text-slate-500">Try adjusting your search keywords, tier selection, or risk filter.</p>
          </div>
        ) : (
          filteredAccounts.map((account) => {
            const isHigh = account.riskCategory === 'High Risk';
            const isMed = account.riskCategory === 'Medium Risk';
            const daysToRenewal = daysUntil(account.contractRenewalDate);

            return (
              <div
                key={account.id}
                className="bg-white border border-slate-200 rounded-xl p-5 space-y-4 shadow-xs transition hover:border-slate-300 flex flex-col justify-between"
              >
                {/* Account Top Info */}
                <div>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-lg bg-slate-100 text-slate-800 border border-slate-200 font-bold flex items-center justify-center text-sm shadow-xs">
                        {account.logo}
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-base leading-tight hover:text-slate-700 transition cursor-pointer" onClick={() => onSelectAccount(account)}>
                          {account.name}
                        </h3>
                        <p className="text-[11px] text-slate-500 font-medium flex items-center space-x-1 mt-0.5">
                          <span>{account.industry}</span>
                          <span>•</span>
                          <span className="font-semibold px-1.5 py-0.2 bg-slate-100 border border-slate-200 text-slate-800 rounded text-[10px]">
                            {account.subscriptionType}
                          </span>
                        </p>
                      </div>
                    </div>

                    {/* Risk Badge */}
                    <span className={`px-2.5 py-1 text-xs font-bold rounded-md ${
                      isHigh
                        ? 'bg-red-50 text-red-700 border border-red-200'
                        : isMed
                        ? 'bg-amber-50 text-amber-700 border border-amber-200'
                        : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    }`}>
                      {account.fusionRiskScore}% Risk
                    </span>
                  </div>

                  {/* Score Level & Progress */}
                  <div className="mt-4 bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-500 text-[11px] font-medium">Risk Score Classification:</span>
                      <span className={`font-bold text-xs ${
                        isHigh ? 'text-red-700' : isMed ? 'text-amber-700' : 'text-emerald-700'
                      }`}>
                        {account.riskCategory}
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${
                          isHigh ? 'bg-red-600' : isMed ? 'bg-amber-500' : 'bg-emerald-600'
                        }`}
                        style={{ width: `${account.fusionRiskScore}%` }}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-slate-500">
                      <div>
                        <span>Usage Model: </span>
                        <span className="font-bold text-slate-800">{account.churnModelScore}%</span>
                      </div>
                      <div>
                        <span>Sentiment: </span>
                        <span className="font-bold text-slate-800">{account.sentimentClassification}</span>
                      </div>
                    </div>
                  </div>

                  {/* Risk Trend Sparkline */}
                  <div className="mt-3">
                    <RiskSparkline
                      history={account.riskHistory}
                      trend={account.riskTrend}
                      riskCategory={account.riskCategory}
                      currentScore={account.fusionRiskScore}
                    />
                  </div>

                  {/* Contract & MRR */}
                  <div className="mt-3 flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-200">
                    <span
                      title={account.discountState === 'active'
                        ? `List rate $${account.mrr.toLocaleString()}, currently discounted`
                        : undefined}
                    >
                      MRR: <strong className="text-slate-900">${account.effectiveMrr.toLocaleString()}</strong>
                    </span>
                    <span className="flex items-center space-x-1" title={`${daysToRenewal} days until contract renewal`}>
                      <Clock className="w-3 h-3 text-slate-400 inline" />
                      <span>Renewal: </span>
                      <strong className="text-slate-800">{account.contractRenewalDate} ({daysToRenewal}d)</strong>
                    </span>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="pt-2 space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => onDiscussWithAdvisor(account)}
                      className="flex items-center justify-center space-x-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 transition shadow-xs cursor-pointer"
                    >
                      <Bot className="w-3.5 h-3.5" />
                      <span>Advisor</span>
                    </button>

                    <button
                      onClick={() => onSelectAccount(account)}
                      className="flex items-center justify-center space-x-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-200 transition cursor-pointer"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Analysis</span>
                    </button>
                  </div>

                  {/* Discount status badge — approved (green) takes precedence over
                      awaiting-approval (amber). Reserved space (invisible placeholder
                      when neither applies) so every card in the grid stays the same
                      height regardless of discount state. */}
                  {account.discountState === 'active' ? (
                    <div className="w-full text-center py-1.5 px-2 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800 font-bold text-[11px] flex items-center justify-center space-x-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 inline" />
                      <span>{account.currentDiscountApproved}% Discount Active</span>
                    </div>
                  ) : account.discountState === 'offered' ? (
                    /* Approved but not yet in effect — it starts at the renewal, which may
                       be months away. This read "Retention Discount Approved" in the same
                       green as a running one, so nothing on the card distinguished money
                       already being given up from money merely promised. */
                    <div className="w-full text-center py-1.5 px-2 bg-sky-50 border border-sky-200 rounded-lg text-sky-800 font-bold text-[11px] flex items-center justify-center space-x-1">
                      <Clock className="w-3.5 h-3.5 text-sky-700 inline" />
                      <span>
                        {account.currentDiscountApproved}% from{' '}
                        {account.discountStartsAt ? formatTermDate(account.discountStartsAt) : 'next renewal'}
                      </span>
                    </div>
                  ) : pendingRequestByAccount.get(account.id) ? (
                    <div className="w-full text-center py-1.5 px-2 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 font-bold text-[11px] flex items-center justify-center space-x-1">
                      <Clock className="w-3.5 h-3.5 text-amber-700 inline" />
                      <span>{pendingRequestByAccount.get(account.id)!.requestedDiscountPct}% Discount Pending Approval</span>
                    </div>
                  ) : (
                    <div className="w-full text-center py-1.5 px-2 border border-transparent text-[11px] flex items-center justify-center space-x-1 invisible" aria-hidden="true">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Placeholder</span>
                    </div>
                  )}
                </div>

              </div>
            );
          })
        )}
      </div>

    </div>
  );
};

