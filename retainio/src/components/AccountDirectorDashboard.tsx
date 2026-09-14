import React, { useState } from 'react';
import { MONTHS_PER_TERM, annualContractValue, formatMoney, describeDiscount, formatTermDate } from '../../pricing';
import { Account, AuditLog, DiscountRequest, OfferResult, UserProfile } from '../types';
import { FaceVerificationModal } from './FaceVerificationModal';
import { DiscountEmailModal } from './DiscountEmailModal';
import { CheckInboxButton } from './CheckInboxButton';
import { splitByStatus } from '../accountStatus';
import { useToast } from './Toast';
import { useModalA11y } from '../hooks/useModalA11y';
import {
  Layers,
  ShieldCheck,
  AlertTriangle,
  CheckCircle2, 
  XCircle, 
  Camera, 
  TrendingUp, 
  TrendingDown, 
  Building2, 
  DollarSign, 
  Clock, 
  Lock, 
  FileCheck,
  User,
  Users,
  ArrowRight,
  Search,
  Sparkles,
  ChevronRight,
  ShieldAlert,
  MessageSquare,
  BarChart3,
  Filter,
  Check
} from 'lucide-react';

interface AccountDirectorDashboardProps {
  currentUser: UserProfile;
  accounts: Account[];
  discountRequests: DiscountRequest[];
  auditLogs: AuditLog[];
  // Resolves with the offer row the approval wrote, which the offer email then names.
  onApproveDiscountRequest: (requestId: string, matchedName?: string) => Promise<OfferResult>;
  onRejectDiscountRequest: (requestId: string, reason: string) => void;
  onSelectAccountDetail: (account: Account) => void;
  // Reload after the mailbox check pulls in a review or a notice.
  onInboxChecked?: () => void;
}

export const AccountDirectorDashboard: React.FC<AccountDirectorDashboardProps> = ({
  currentUser,
  accounts,
  discountRequests,
  auditLogs,
  onApproveDiscountRequest,
  onRejectDiscountRequest,
  onSelectAccountDetail,
  onInboxChecked
}) => {
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<'pending' | 'portfolio'>('pending');
  const [selectedRequestForScan, setSelectedRequestForScan] = useState<DiscountRequest | null>(null);
  const [verifiedRequestForEmail, setVerifiedRequestForEmail] = useState<{ request: DiscountRequest; matchedName?: string } | null>(null);
  const [rejectingRequest, setRejectingRequest] = useState<DiscountRequest | null>(null);
  const [rejectReason, setRejectReason] = useState<string>('');
  const { dialogRef: rejectDialogRef, backdropProps: rejectBackdropProps } = useModalA11y(
    !!rejectingRequest,
    () => setRejectingRequest(null),
    { closeOnBackdropClick: true }
  );
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedAmFilter, setSelectedAmFilter] = useState<string>('all');
  const [selectedRiskFilter, setSelectedRiskFilter] = useState<'all' | 'high' | 'medium' | 'low'>('all');

  // The working portfolio is the customers who can still be saved. Churned accounts are left out of
  // every figure, the tiers, the per-manager table and the portfolio table, and listed on their own.
  const { active: activeAccounts, churned: churnedAccounts } = splitByStatus(accounts);

  // Executive Metrics Calculations
  // Every figure on this page reports revenue, so all of them read effectiveMrr — what
  // the accounts actually bill today. `mrr` stays the list rate and is what offers are
  // priced against; mixing the two would let a discount compound against itself.
  const totalPortfolioMrr = activeAccounts.reduce((acc, a) => acc + a.effectiveMrr, 0);
  // Contracts are 12-month terms now, so the portfolio headline is stated annually.
  // ARR is derived, never stored — a second copy is what let the risk bands drift.
  const totalPortfolioArr = annualContractValue(totalPortfolioMrr);
  // Read the band the server already computed rather than re-deriving it from
  // the score. This page had drifted: it used >= 70 for High where the
  // canonical band is > 70, and a 35 boundary for Medium where the canonical
  // one is 30 - so an account scoring 32 showed as Medium everywhere else in
  // the app and Low here. fusionRiskCategory in fusionSnapshot.ts is the single
  // definition; every other component reads riskCategory off the account.
  const highRiskAccounts = activeAccounts.filter(a => a.riskCategory === 'High Risk');
  const totalMrrAtRisk = highRiskAccounts.reduce((acc, a) => acc + a.effectiveMrr, 0);
  const totalArrAtRisk = annualContractValue(totalMrrAtRisk);
  const pendingRequests = discountRequests.filter(r => r.status === 'pending');
  const approvedRequests = discountRequests.filter(r => r.status === 'approved');

  // Group stats by Account Manager
  const accountManagers: string[] = Array.from(new Set(activeAccounts.map(a => a.accountManager || 'Unassigned')));

  const amStats = accountManagers.map(amName => {
    const amAccounts = activeAccounts.filter(a => a.accountManager === amName);
    const totalMrr = amAccounts.reduce((sum, a) => sum + a.effectiveMrr, 0);
    const highRiskAccs = amAccounts.filter(a => a.riskCategory === 'High Risk');
    const highRiskMrr = highRiskAccs.reduce((sum, a) => sum + a.effectiveMrr, 0);
    const avgRiskScore = amAccounts.length > 0 
      ? Math.round(amAccounts.reduce((sum, a) => sum + a.fusionRiskScore, 0) / amAccounts.length)
      : 0;
    
    const pendingCount = discountRequests.filter(r => 
      r.status === 'pending' && amAccounts.some(a => a.id === r.accountId)
    ).length;

    // Discounts actually running, not every discount ever granted to this AM's accounts.
    const approvedCount = amAccounts.filter(a => a.discountState === 'active').length;

    return {
      amName,
      accountCount: amAccounts.length,
      totalMrr,
      highRiskMrr,
      highRiskCount: highRiskAccs.length,
      avgRiskScore,
      pendingCount,
      approvedCount
    };
  });

  // Risk Tier Summaries
  const highRiskTier = activeAccounts.filter(a => a.riskCategory === 'High Risk');
  const mediumRiskTier = activeAccounts.filter(a => a.riskCategory === 'Medium Risk');
  const lowRiskTier = activeAccounts.filter(a => a.riskCategory === 'Low Risk');

  const highRiskMrrTotal = highRiskTier.reduce((sum, a) => sum + a.effectiveMrr, 0);
  const mediumRiskMrrTotal = mediumRiskTier.reduce((sum, a) => sum + a.effectiveMrr, 0);
  const lowRiskMrrTotal = lowRiskTier.reduce((sum, a) => sum + a.effectiveMrr, 0);

  // Filtered Accounts
  const filteredAccounts = activeAccounts.filter(a => {
    const matchesSearch = 
      a.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.industry.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.accountManager.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesAm = selectedAmFilter === 'all' || a.accountManager === selectedAmFilter;

    let matchesRisk = true;
    if (selectedRiskFilter === 'high') matchesRisk = a.riskCategory === 'High Risk';
    if (selectedRiskFilter === 'medium') matchesRisk = a.riskCategory === 'Medium Risk';
    if (selectedRiskFilter === 'low') matchesRisk = a.riskCategory === 'Low Risk';

    return matchesSearch && matchesAm && matchesRisk;
  });

  // Biometric scan only stages the approval — the discount is applied once the
  // Director reviews and sends the retention offer email, mirroring the Account
  // Manager's <=10% direct-approval flow.
  const handlePassFaceScan = (_snapshot: string, matchedName?: string) => {
    if (selectedRequestForScan) {
      setVerifiedRequestForEmail({ request: selectedRequestForScan, matchedName });
      setSelectedRequestForScan(null);
    }
  };

  // The approval itself, made when the Director confirms the offer email. The email window then sends
  // the email and says what actually happened. This used to announce the offer as sent when no email
  // had gone anywhere.
  const confirmApproval = async (): Promise<OfferResult> => {
    if (!verifiedRequestForEmail) return { ok: false };
    return onApproveDiscountRequest(verifiedRequestForEmail.request.id, verifiedRequestForEmail.matchedName);
  };

  // Same reasoning as the Account Manager dashboard: with nothing to oversee,
  // the executive tiles and portfolio charts would all render as zeroes and
  // read as a broken page rather than an empty one.
  if (accounts.length === 0) {
    return (
      <div className="space-y-6">
        <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white p-6 rounded-2xl shadow-md border border-slate-800">
          <span className="text-xs font-black uppercase tracking-wider px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
            Executive Portal
          </span>
          <h1 className="text-2xl font-black tracking-tight text-white mt-2">Account Director Command Center</h1>
          <p className="text-xs text-slate-400 mt-1">Logged in as {currentUser.name}</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center space-y-3">
          <Layers className="w-10 h-10 text-slate-300 mx-auto" />
          <p className="text-sm font-bold text-slate-700">No accounts assigned</p>
          <p className="text-xs text-slate-500 max-w-md mx-auto leading-relaxed">
            There are no customer accounts in your portfolio yet. Once accounts exist and are assigned to
            Account Managers, their risk, discount requests and approvals will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* Executive Welcome Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-indigo-950 text-white p-6 rounded-2xl shadow-md border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <span className="text-xs font-black uppercase tracking-wider px-2.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
              Executive Portal
            </span>
            <span className="text-xs text-slate-400 font-medium">Logged in as {currentUser.name}</span>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white">Account Director Command Center</h1>
          <p className="text-xs text-slate-300 max-w-2xl">
            High-level portfolio oversight, revenue risk governance, and biometric facial verification authority for discount overrides &ge;10%.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* The same check the Account Managers have. Directors see every team account, so a
              notice or review that just arrived is theirs to see straight away too. */}
          <CheckInboxButton onChecked={onInboxChecked} />
          <div className="flex items-center space-x-3 bg-slate-900/80 p-3 rounded-xl border border-slate-700/80 backdrop-blur-sm">
            <div className="w-10 h-10 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold border border-amber-500/30">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="text-xs">
              <p className="font-bold text-slate-200">Facial Verification Status</p>
              <p className="text-emerald-400 font-medium flex items-center space-x-1">
                <CheckCircle2 className="w-3 h-3 inline" />
                <span>SOC2 Biometric Active</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Executive Key Metrics Bar */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        
        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-1">
          <p className="text-xs font-bold text-slate-500">Total Managed ARR</p>
          <div className="flex items-baseline space-x-2">
            <p className="text-2xl font-black text-slate-900">${(totalPortfolioArr / 1000).toFixed(0)}k</p>
            <span className="text-xs text-slate-400 font-semibold">{activeAccounts.length} Accounts</span>
          </div>
          <p className="text-[11px] text-slate-500 pt-1">{formatMoney(totalPortfolioMrr)}/mo across {MONTHS_PER_TERM}-month terms</p>
        </div>

        <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-xs space-y-1">
          <p className="text-xs font-bold text-red-600 flex items-center space-x-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>High Risk ARR at Stake</span>
          </p>
          <div className="flex items-baseline space-x-2">
            <p className="text-2xl font-black text-red-600">${(totalArrAtRisk / 1000).toFixed(0)}k</p>
            <span className="text-xs text-red-500 font-semibold font-mono">
              {totalPortfolioMrr > 0 ? ((totalMrrAtRisk / totalPortfolioMrr) * 100).toFixed(0) : 0}%
            </span>
          </div>
          <p className="text-[11px] text-slate-500 pt-1">{highRiskAccounts.length} High Risk Accounts</p>
        </div>

        <div className="bg-amber-50/80 p-5 rounded-xl border border-amber-200 shadow-xs space-y-1">
          <p className="text-xs font-bold text-amber-900 flex items-center space-x-1">
            <Clock className="w-3.5 h-3.5 text-amber-700" />
            <span>Pending Facial Approvals</span>
          </p>
          <div className="flex items-baseline space-x-2">
            <p className="text-2xl font-black text-amber-900">{pendingRequests.length}</p>
            <span className="text-xs text-amber-700 font-semibold">Requests</span>
          </div>
          <p className="text-[11px] text-amber-800 pt-1 font-medium">Requires Director Biometric Scan</p>
        </div>

        <div className="bg-emerald-50/80 p-5 rounded-xl border border-emerald-200 shadow-xs space-y-1">
          <p className="text-xs font-bold text-emerald-900 flex items-center space-x-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-700" />
            <span>Executed Biometric Approvals</span>
          </p>
          <div className="flex items-baseline space-x-2">
            <p className="text-2xl font-black text-emerald-900">{approvedRequests.length}</p>
            <span className="text-xs text-emerald-700 font-semibold">Overrides</span>
          </div>
          <p className="text-[11px] text-emerald-800 pt-1 font-medium">Audited & Verified</p>
        </div>

      </div>

      {/* Navigation Tabs for Director */}
      <div className="flex border-b border-slate-200 space-x-6">
        <button
          onClick={() => setActiveTab('pending')}
          className={`pb-3 text-xs font-bold transition flex items-center space-x-2 border-b-2 cursor-pointer ${
            activeTab === 'pending'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Camera className="w-4 h-4 text-amber-600" />
          <span>Pending Facial Verification Queue</span>
          {pendingRequests.length > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-500 text-slate-950 font-black text-[10px]">
              {pendingRequests.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveTab('portfolio')}
          className={`pb-3 text-xs font-bold transition flex items-center space-x-2 border-b-2 cursor-pointer ${
            activeTab === 'portfolio'
              ? 'border-slate-900 text-slate-900'
              : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Building2 className="w-4 h-4 text-slate-700" />
          <span>High-Level Portfolio Overview</span>
        </button>
      </div>

      {/* TAB 1: PENDING DISCOUNT APPROVAL REQUESTS (Biometric Approval Center) */}
      {activeTab === 'pending' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Discount Override Requests (&ge; 10% MRR)</h2>
              <p className="text-xs text-slate-500">
                Submitted by Account Managers. Directors must perform live webcam facial verification to authorize overrides.
              </p>
            </div>
          </div>

          {pendingRequests.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center space-y-3">
              <div className="w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mx-auto border border-emerald-200">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-slate-900">Queue is Clear!</h3>
              <p className="text-xs text-slate-500 max-w-sm mx-auto">
                No pending discount requests requiring facial verification at this time.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {pendingRequests.map((request) => {
                const targetAccount = accounts.find(a => a.id === request.accountId);

                return (
                  <div
                    key={request.id}
                    className="bg-white rounded-2xl border-2 border-amber-200/80 p-6 shadow-sm hover:shadow-md transition space-y-4"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
                      <div className="flex items-center space-x-3">
                        <div className="w-10 h-10 rounded-xl bg-slate-900 text-white font-black text-sm flex items-center justify-center shadow-xs">
                          {request.accountName.substring(0, 2).toUpperCase()}
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <h3 className="font-bold text-slate-900 text-sm">{request.accountName}</h3>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300">
                              Requires Face Scan
                            </span>
                          </div>
                          <p className="text-xs text-slate-500">MRR: ${request.mrr.toLocaleString()} &bull; Requested by {request.requestedBy}</p>
                        </div>
                      </div>

                      <div className="flex items-center space-x-3 self-start sm:self-auto">
                        <div className="text-right">
                          <span className="text-xs text-slate-400 font-semibold block">Requested Discount</span>
                          <span className="text-lg font-black text-amber-700">{describeDiscount(request.requestedDiscountPct, request.requestedDurationMonths)}</span>
                          {request.includesWalkthrough && (
                            <span className="mt-1 inline-block text-[10px] font-bold px-2 py-0.5 rounded bg-violet-100 text-violet-800 border border-violet-300">
                              + Walkthrough Requested
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Justification & Risk Info */}
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                      <div className="md:col-span-2 space-y-1">
                        <span className="font-bold text-slate-700 block">Manager Justification</span>
                        <p className="text-slate-600 italic leading-relaxed">"{request.managerNote}"</p>
                      </div>

                      <div className="space-y-1.5 border-t md:border-t-0 md:border-l border-slate-200 pt-2 md:pt-0 md:pl-4">
                        <span className="font-bold text-slate-700 block">Fusion Risk Score</span>
                        <div className="flex items-center space-x-2">
                          <span className="text-base font-mono font-black text-red-600">{request.riskScore}/100</span>
                          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800">
                            High Risk Account
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Executive Actions */}
                    <div className="flex flex-col sm:flex-row items-center justify-end gap-3 pt-2">
                      <div className="flex items-center space-x-3 w-full sm:w-auto">
                        <button
                          type="button"
                          onClick={() => {
                            setRejectingRequest(request);
                            setRejectReason('');
                          }}
                          className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-100 transition cursor-pointer"
                        >
                          Reject Request
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedRequestForScan(request)}
                          className="flex-1 sm:flex-initial px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs shadow-md transition flex items-center justify-center space-x-2 cursor-pointer"
                        >
                          <Camera className="w-4 h-4 text-white" />
                          <span>Review & Biometric Face Approval ({request.requestedDiscountPct}%)</span>
                        </button>
                      </div>
                    </div>

                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: PORTFOLIO OVERVIEW */}
      {activeTab === 'portfolio' && (
        <div className="space-y-6">
          
          {/* 1. Account Manager Team Performance & Workload Breakdown */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center space-x-2">
                  <Users className="w-4 h-4 text-indigo-600" />
                  <span>Account Manager Team Performance & MRR Exposure</span>
                </h2>
                <p className="text-xs text-slate-500">
                  Select an Account Manager card below to filter accounts and inspect individual portfolio risk density.
                </p>
              </div>

              {selectedAmFilter !== 'all' && (
                <button
                  type="button"
                  onClick={() => setSelectedAmFilter('all')}
                  className="text-xs font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 px-3 py-1.5 rounded-lg border border-indigo-200 transition cursor-pointer self-start sm:self-auto"
                >
                  Reset Filter (Show All AMs)
                </button>
              )}
            </div>

            {/* AM Cards Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {amStats.map((stat) => {
                const isSelected = selectedAmFilter === stat.amName;
                const initials = stat.amName.split(' ').map(n => n[0]).join('').toUpperCase();

                return (
                  <div
                    key={stat.amName}
                    onClick={() => setSelectedAmFilter(isSelected ? 'all' : stat.amName)}
                    className={`p-4 rounded-xl border transition cursor-pointer flex flex-col justify-between space-y-3 ${
                      isSelected
                        ? 'border-indigo-600 bg-indigo-50/40 shadow-md ring-2 ring-indigo-500/20'
                        : 'border-slate-200 bg-slate-50/50 hover:bg-slate-100/80 hover:border-slate-300'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center space-x-2">
                          <div className={`w-8 h-8 rounded-full font-black text-xs flex items-center justify-center ${
                            isSelected ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-100'
                          }`}>
                            {initials}
                          </div>
                          <div>
                            <h3 className="font-bold text-xs text-slate-900">{stat.amName}</h3>
                            <p className="text-[10px] text-slate-500">{stat.accountCount} Accounts Managed</p>
                          </div>
                        </div>

                        {isSelected && (
                          <span className="w-5 h-5 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs">
                            <Check className="w-3 h-3" />
                          </span>
                        )}
                      </div>

                      <div className="space-y-1 mt-3">
                        <div className="flex items-baseline justify-between text-xs">
                          <span className="text-slate-500 font-medium">Total Managed MRR:</span>
                          <span className="font-mono font-bold text-slate-900">${(stat.totalMrr / 1000).toFixed(0)}k</span>
                        </div>

                        <div className="flex items-baseline justify-between text-xs">
                          <span className="text-slate-500 font-medium">High Risk MRR:</span>
                          <span className={`font-mono font-bold ${stat.highRiskMrr > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                            ${(stat.highRiskMrr / 1000).toFixed(0)}k
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-2 border-t border-slate-200/60 space-y-2">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-500 font-medium">Avg Risk Score:</span>
                        <span className={`font-mono font-black ${
                          stat.avgRiskScore >= 70 ? 'text-red-600' : stat.avgRiskScore >= 35 ? 'text-amber-600' : 'text-emerald-600'
                        }`}>
                          {stat.avgRiskScore}/100
                        </span>
                      </div>

                      <div className="w-full bg-slate-200 h-1.5 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${
                            stat.avgRiskScore >= 70 ? 'bg-red-500' : stat.avgRiskScore >= 35 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                          style={{ width: `${Math.min(stat.avgRiskScore, 100)}%` }}
                        />
                      </div>

                      {/* Pending Discount Escalations Alert for this AM */}
                      {stat.pendingCount > 0 && (
                        <div className="flex items-center space-x-1 text-[10px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded border border-amber-300">
                          <Clock className="w-3 h-3 text-amber-700" />
                          <span>{stat.pendingCount} Pending Facial Verification</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2. Portfolio Risk Tier Concentration Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            
            <div className="bg-red-50/50 rounded-2xl border border-red-200/80 p-5 space-y-2 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-red-900 flex items-center space-x-1.5">
                  <ShieldAlert className="w-4 h-4 text-red-600" />
                  <span>High Risk Tier (&ge;70 Risk)</span>
                </span>
                <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-red-200 text-red-900">
                  Critical Focus
                </span>
              </div>

              <div className="flex items-baseline space-x-2 pt-1">
                <p className="text-2xl font-black text-red-700">${(highRiskMrrTotal / 1000).toFixed(0)}k</p>
                <span className="text-xs font-bold text-red-600">
                  {totalPortfolioMrr > 0 ? ((highRiskMrrTotal / totalPortfolioMrr) * 100).toFixed(0) : 0}% Portfolio MRR
                </span>
              </div>

              <p className="text-xs text-slate-600">
                <strong className="text-slate-900">{highRiskTier.length} Accounts</strong> requiring Director discount approvals and executive retention plans.
              </p>
            </div>

            <div className="bg-amber-50/50 rounded-2xl border border-amber-200/80 p-5 space-y-2 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-amber-900 flex items-center space-x-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  <span>Medium Risk Tier (35-69 Risk)</span>
                </span>
                <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-amber-200 text-amber-900">
                  Proactive AM Care
                </span>
              </div>

              <div className="flex items-baseline space-x-2 pt-1">
                <p className="text-2xl font-black text-amber-800">${(mediumRiskMrrTotal / 1000).toFixed(0)}k</p>
                <span className="text-xs font-bold text-amber-700">
                  {totalPortfolioMrr > 0 ? ((mediumRiskMrrTotal / totalPortfolioMrr) * 100).toFixed(0) : 0}% Portfolio MRR
                </span>
              </div>

              <p className="text-xs text-slate-600">
                <strong className="text-slate-900">{mediumRiskTier.length} Accounts</strong> monitored for pricing sensitivity and sentiment drops.
              </p>
            </div>

            <div className="bg-emerald-50/50 rounded-2xl border border-emerald-200/80 p-5 space-y-2 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-emerald-900 flex items-center space-x-1.5">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  <span>Low Risk Tier (&lt;35 Risk)</span>
                </span>
                <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded bg-emerald-200 text-emerald-900">
                  Expansion Targets
                </span>
              </div>

              <div className="flex items-baseline space-x-2 pt-1">
                <p className="text-2xl font-black text-emerald-800">${(lowRiskMrrTotal / 1000).toFixed(0)}k</p>
                <span className="text-xs font-bold text-emerald-700">
                  {totalPortfolioMrr > 0 ? ((lowRiskMrrTotal / totalPortfolioMrr) * 100).toFixed(0) : 0}% Portfolio MRR
                </span>
              </div>

              <p className="text-xs text-slate-600">
                <strong className="text-slate-900">{lowRiskTier.length} Accounts</strong> with strong engagement, ideal candidates for seat expansion.
              </p>
            </div>

          </div>

          {/* 3. Account Governance Directory Table */}
          <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-4 shadow-xs">
            
            {/* Header & Controls */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-sm font-bold text-slate-900">Portfolio Accounts Directory</h2>
                <p className="text-xs text-slate-500">Inspect accounts, assigned account managers, risk scores, and discount history.</p>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full md:w-auto">
                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    placeholder="Search accounts or industries..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full text-xs pl-8 pr-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-slate-900 bg-slate-50/50"
                  />
                </div>
              </div>
            </div>

            {/* Quick Filter Bar */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
              
              {/* Filter by Account Manager */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-slate-500 font-bold mr-1 flex items-center space-x-1">
                  <Filter className="w-3.5 h-3.5 text-slate-400" />
                  <span>AM:</span>
                </span>

                <button
                  onClick={() => setSelectedAmFilter('all')}
                  className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                    selectedAmFilter === 'all'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                  }`}
                >
                  All AMs ({activeAccounts.length})
                </button>

                {accountManagers.map(am => (
                  <button
                    key={am}
                    onClick={() => setSelectedAmFilter(am)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition cursor-pointer ${
                      selectedAmFilter === am
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                    }`}
                  >
                    {am}
                  </button>
                ))}
              </div>

              {/* Filter by Risk Level */}
              <div className="flex items-center gap-1.5">
                <span className="text-slate-500 font-bold mr-1">Risk:</span>

                <button
                  onClick={() => setSelectedRiskFilter('all')}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                    selectedRiskFilter === 'all'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  All
                </button>

                <button
                  onClick={() => setSelectedRiskFilter('high')}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                    selectedRiskFilter === 'high'
                      ? 'bg-red-600 text-white'
                      : 'bg-red-50 text-red-700 hover:bg-red-100 border border-red-200'
                  }`}
                >
                  High Risk (&ge;70)
                </button>

                <button
                  onClick={() => setSelectedRiskFilter('medium')}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                    selectedRiskFilter === 'medium'
                      ? 'bg-amber-600 text-white'
                      : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200'
                  }`}
                >
                  Medium (35-69)
                </button>

                <button
                  onClick={() => setSelectedRiskFilter('low')}
                  className={`px-2 py-1 rounded-lg text-[11px] font-bold transition cursor-pointer ${
                    selectedRiskFilter === 'low'
                      ? 'bg-emerald-600 text-white'
                      : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200'
                  }`}
                >
                  Low (&lt;35)
                </button>
              </div>

            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 font-bold bg-slate-50/80">
                    <th className="py-3 px-4">Account</th>
                    <th className="py-3 px-4">Account Manager</th>
                    <th className="py-3 px-4">Industry / Tier</th>
                    <th className="py-3 px-4">MRR</th>
                    <th className="py-3 px-4">Fusion Risk</th>
                    <th className="py-3 px-4">Renewal Date</th>
                    <th className="py-3 px-4">Active Discount</th>
                    <th className="py-3 px-4 text-right">Director Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredAccounts.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500 font-medium">
                        No accounts found matching the selected filters.
                      </td>
                    </tr>
                  ) : (
                    filteredAccounts.map((account) => {
                      const amInitials = account.accountManager
                        ? account.accountManager.split(' ').map(n => n[0]).join('').toUpperCase()
                        : 'AM';

                      return (
                        <tr key={account.id} className="hover:bg-slate-50/80 transition">
                          <td className="py-3 px-4">
                            <div className="flex items-center space-x-2.5">
                              <div className="w-7 h-7 rounded-lg bg-slate-900 text-white font-black text-[10px] flex items-center justify-center shrink-0">
                                {account.logo || account.name.substring(0, 2).toUpperCase()}
                              </div>
                              <div>
                                <span className="font-bold text-slate-900 block">{account.name}</span>
                                <span className="text-[10px] text-slate-400">{account.id}</span>
                              </div>
                            </div>
                          </td>

                          <td className="py-3 px-4">
                            <div className="flex items-center space-x-2">
                              <div className="w-6 h-6 rounded-full bg-slate-200 text-slate-700 font-bold text-[10px] flex items-center justify-center shrink-0">
                                {amInitials}
                              </div>
                              <span className="font-bold text-slate-700 text-xs">{account.accountManager}</span>
                            </div>
                          </td>

                          <td className="py-3 px-4">
                            <span className="text-slate-800 font-medium block">{account.industry}</span>
                            <span className="text-[10px] text-slate-400">{account.subscriptionType} Plan</span>
                          </td>

                          <td className="py-3 px-4 font-mono font-bold text-slate-900">
                            ${account.effectiveMrr.toLocaleString()}
                          </td>

                          <td className="py-3 px-4">
                            <div className="flex items-center space-x-1.5">
                              <span className={`font-mono font-black text-xs ${
                                account.riskCategory === 'High Risk' ? 'text-red-600' : account.riskCategory === 'Medium Risk' ? 'text-amber-600' : 'text-emerald-600'
                              }`}>
                                {account.fusionRiskScore}/100
                              </span>
                              
                              {account.riskTrend === 'increasing' && <TrendingUp className="w-3.5 h-3.5 text-red-500" />}
                              {account.riskTrend === 'decreasing' && <TrendingDown className="w-3.5 h-3.5 text-emerald-500" />}
                            </div>
                          </td>

                          <td className="py-3 px-4 font-mono text-slate-600">
                            {account.contractRenewalDate}
                          </td>

                          <td className="py-3 px-4">
                            {/* "Executed" was shown the moment a discount was approved,
                                including when its renewal was a year out and nothing had
                                been executed at all. Each state now reads as itself. */}
                            {account.discountState === 'active' ? (
                              <span
                                className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200"
                                title={account.discountLabel}
                              >
                                {account.currentDiscountApproved}% Active
                              </span>
                            ) : account.discountState === 'offered' ? (
                              <span
                                className="text-[10px] font-bold px-2 py-0.5 rounded bg-sky-50 text-sky-800 border border-sky-200"
                                title={account.discountLabel}
                              >
                                {account.currentDiscountApproved}% Scheduled
                              </span>
                            ) : account.discountState === 'ended' ? (
                              <span
                                className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200"
                                title={account.discountLabel}
                              >
                                {account.currentDiscountApproved}% Ended
                              </span>
                            ) : account.actionStatus === 'Pending Director Approval' ? (
                              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-300">
                                Pending Approval
                              </span>
                            ) : (
                              <span className="text-[10px] text-slate-400">None</span>
                            )}
                          </td>

                          <td className="py-3 px-4 text-right">
                            <button
                              onClick={() => onSelectAccountDetail(account)}
                              className="text-xs font-bold text-indigo-600 hover:text-indigo-900 hover:underline flex items-center space-x-1 justify-end ml-auto cursor-pointer"
                            >
                              <span>Inspect Analysis</span>
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Customers who have left: out of the table and every figure above, kept here so their
                history stays one click away. */}
            {churnedAccounts.length > 0 && (
              <details className="border-t border-slate-200">
                <summary className="cursor-pointer select-none px-4 py-3 text-xs font-bold text-slate-700 flex flex-wrap items-center justify-between gap-2">
                  <span>Churned accounts ({churnedAccounts.length})</span>
                  <span className="text-[11px] font-medium text-slate-500">Left at their renewal; not counted above</span>
                </summary>
                <div className="border-t border-slate-100 divide-y divide-slate-100">
                  {churnedAccounts.map(account => (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => onSelectAccountDetail(account)}
                      className="w-full flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-left text-xs hover:bg-slate-50 transition cursor-pointer"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span className="font-semibold text-slate-900 truncate">{account.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-100 text-slate-600 border border-slate-200">Churned</span>
                        <span className="text-[11px] text-slate-500">{account.accountManager}</span>
                      </span>
                      <span className="text-[11px] text-slate-500">
                        Left at its renewal on {formatTermDate(account.contractRenewalDate)} · {account.fusionRiskScore != null ? `final risk ${account.fusionRiskScore}/100` : 'never scored'}
                      </span>
                    </button>
                  ))}
                </div>
              </details>
            )}

          </div>

        </div>
      )}

      {/* FACE VERIFICATION MODAL WHEN DIRECTOR CLICKS APPROVE */}
      <FaceVerificationModal
        isOpen={!!selectedRequestForScan}
        onClose={() => setSelectedRequestForScan(null)}
        discountPct={selectedRequestForScan?.requestedDiscountPct || 0}
        accountName={selectedRequestForScan?.accountName || ''}
        onVerified={handlePassFaceScan}
      />

      {/* RETENTION OFFER EMAIL REVIEW MODAL — AFTER BIOMETRIC VERIFICATION, BEFORE DISCOUNT IS APPLIED */}
      <DiscountEmailModal
        isOpen={!!verifiedRequestForEmail}
        onClose={() => setVerifiedRequestForEmail(null)}
        account={
          accounts.find(a => a.id === verifiedRequestForEmail?.request.accountId) || accounts[0]
        }
        discountPct={verifiedRequestForEmail?.request.requestedDiscountPct || 0}
        discountMonths={verifiedRequestForEmail?.request.requestedDurationMonths || MONTHS_PER_TERM}
        verificationStatus="Face Verified (Biometric Pass)"
        currentUser={currentUser}
        onConfirm={confirmApproval}
        confirmVerb="Approve"
        includeWalkthrough={verifiedRequestForEmail?.request.includesWalkthrough}
      />

      {/* REJECTION REMARK MODAL WHEN DIRECTOR CLICKS REJECT */}
      {rejectingRequest && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50" {...rejectBackdropProps}>
          <div
            ref={rejectDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reject-modal-title"
            tabIndex={-1}
            className="bg-white rounded-2xl max-w-md w-full p-6 space-y-4 shadow-xl border border-slate-200 focus:outline-none"
          >
            <div className="flex items-center justify-between border-b pb-3 border-slate-100">
              <h3 id="reject-modal-title" className="text-sm font-bold text-slate-900 flex items-center space-x-2">
                <XCircle className="w-5 h-5 text-red-600" />
                <span>Reject Discount Request ({rejectingRequest.accountName})</span>
              </h3>
              <button
                type="button"
                onClick={() => setRejectingRequest(null)}
                aria-label="Close rejection dialog"
                className="text-slate-400 hover:text-slate-600 text-sm font-bold cursor-pointer p-1.5 rounded-lg hover:bg-slate-100"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2">
              <label htmlFor="reject-reason-textarea" className="block text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center space-x-1">
                <MessageSquare className="w-3.5 h-3.5 text-slate-600" />
                <span>Account Director Rejection Remark / Reason</span>
              </label>
              <textarea
                id="reject-reason-textarea"
                rows={3}
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Type the reason for rejecting this discount request..."
                className="w-full text-xs p-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-600 bg-slate-50 text-slate-900 resize-none font-medium"
              />
            </div>

            <div className="flex items-center justify-end space-x-3 pt-2">
              <button
                type="button"
                onClick={() => setRejectingRequest(null)}
                className="px-4 py-2 text-xs font-bold text-slate-600 hover:text-slate-900 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const finalReason = rejectReason.trim() || 'Discount request rejected by Account Director.';
                  onRejectDiscountRequest(rejectingRequest.id, finalReason);
                  setRejectingRequest(null);
                  showToast('Discount request rejected.', 'info');
                }}
                className="px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl transition shadow cursor-pointer"
              >
                Confirm Rejection
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
