import React, { useState, useEffect, useCallback } from 'react';
import { MONTHS_PER_TERM, annualContractValue, needsDirectorApproval, blocksNewOffer } from '../pricing';
import { Account, AuditLog, DiscountRequest, UserProfile, RenewalRecord, RenewalIntent } from './types';
import { LoginPage } from './components/LoginPage';
import { SignupPage } from './components/SignupPage';
import { Navbar } from './components/Navbar';
import { Dashboard } from './components/Dashboard';
import { AccountDirectorDashboard } from './components/AccountDirectorDashboard';
import { AdminDashboard } from './components/AdminDashboard';
import { AccountAnalysisPage } from './components/AccountAnalysisPage';
import { AIAdvisorChat } from './components/AIAdvisorChat';
import { AuditTrailView } from './components/AuditTrailView';
import { RenewalsView } from './components/RenewalsView';
import { SettingsAndProfileView } from './components/SettingsAndProfileView';
import { useToast } from './components/Toast';

export default function App() {
  const { showToast } = useToast();
  const [isLoggedIn, setIsLoggedIn] = useState<boolean>(false);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [authScreen, setAuthScreen] = useState<'login' | 'signup'>('login');
  const [isCheckingSession, setIsCheckingSession] = useState<boolean>(true);

  // Everything here comes from the database via server.ts's /api/bootstrap.
  // There is no hardcoded fallback data left in the app: an account's fields
  // are table reads plus trained-model output, so an empty value means the
  // database genuinely has nothing rather than a mock standing in for it.
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Every staff login, used by the admin dashboard to manage reporting lines.
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [discountRequests, setDiscountRequests] = useState<DiscountRequest[]>([]);
  const [portfolioTrend, setPortfolioTrend] = useState<{ month: string; year: number; mrrRiskK: number; avgRiskPct: number }[]>([]);
  // Renewal outcomes recorded at term boundaries, and intents still waiting for theirs.
  const [renewalRecords, setRenewalRecords] = useState<RenewalRecord[]>([]);
  const [renewalIntents, setRenewalIntents] = useState<RenewalIntent[]>([]);
  const [isLoadingData, setIsLoadingData] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<'dashboard' | 'advisor' | 'renewals' | 'audit' | 'settings'>('dashboard');
  const [selectedAccountForDetail, setSelectedAccountForDetail] = useState<Account | null>(null);
  const [chatContextAccount, setChatContextAccount] = useState<Account | null>(null);
  const [analysisInitialTab, setAnalysisInitialTab] = useState<'fusion' | 'shap' | 'uplift' | 'discount'>('fusion');

  // Loads everything from the real database. Only reachable once signed in —
  // /api/bootstrap now requires a valid session (server.ts's requireAuth).
  // Called right after login, and again after every mutation (discount
  // request submitted/approved/rejected, a discount applied directly) so the
  // UI always reflects what's actually stored rather than an optimistic guess.
  const refreshData = useCallback(async () => {
    setIsLoadingData(true);
    try {
      const res = await fetch('/api/bootstrap');
      if (res.status === 401) {
        setIsLoggedIn(false);
        setCurrentUser(null);
        return null;
      }
      if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
      const data = await res.json();
      setAccounts(data.accounts);
      setUsers(data.users ?? []);
      setDiscountRequests(data.discountRequests);
      setAuditLogs(data.auditLogs);
      setPortfolioTrend(data.portfolioTrend || []);
      setRenewalRecords(data.renewalRecords || []);
      setRenewalIntents(data.renewalIntents || []);

      // The open account panel keeps its OWN copy of the account, so refreshing the list
      // alone left it rendering pre-mutation data — a walkthrough would be written, audited
      // and returned by the API, and the panel would still show the account as it was until
      // you navigated away and back.
      //
      // Done here rather than in each handler because it was already missed once: the
      // sentiment correction grew its own bespoke sync while applying a discount silently
      // went without. The functional form avoids making refreshData depend on the value.
      setSelectedAccountForDetail(prev =>
        prev ? (data.accounts?.find((a: Account) => a.id === prev.id) ?? prev) : prev);

      setLoadError(null);
      return data;
    } catch (err) {
      console.error('Failed to load data from the database:', err);
      setLoadError('Could not reach the database. Is the server running?');
      return null;
    } finally {
      setIsLoadingData(false);
    }
  }, []);

  // On first mount, check for an existing session (real, httpOnly cookie —
  // survives a refresh, unlike the old React-state-only isLoggedIn flag).
  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        setCurrentUser(data.user);
        setIsLoggedIn(true);
        const bootstrap = await refreshData();
        if (bootstrap?.accounts?.length) setChatContextAccount(bootstrap.accounts[0]);
      })
      .finally(() => setIsCheckingSession(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle Login from LoginPage — LoginPage already did the real
  // POST /api/auth/login; this just loads this session's data.
  const handleLogin = async (profile: UserProfile) => {
    setCurrentUser(profile);
    setIsLoggedIn(true);
    setActiveTab('dashboard');
    const bootstrap = await refreshData();
    if (bootstrap?.accounts?.length) setChatContextAccount(bootstrap.accounts[0]);
  };

  // Handle Logout
  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error('Logout request failed:', err);
    }
    setIsLoggedIn(false);
    setCurrentUser(null);
    setAccounts([]);
    setDiscountRequests([]);
    setAuditLogs([]);
    setRenewalRecords([]);
    setRenewalIntents([]);
    setChatContextAccount(null);
  };

  // Records a person's disagreement with the sentiment model's read of a review.
  //
  // This is the only feedback that can retrain that model: a renewal outcome cannot say
  // what mood a review was written in, and training sentiment on outcomes would turn it
  // into a second churn predictor — leaving the fusion model blending a number with a
  // copy of itself. Passing null withdraws a correction.
  //
  // Nothing about the account's displayed scores changes. The correction is stored beside
  // the prediction and read by the next training run.
  const handleCorrectSentiment = async (
    reviewId: string,
    sentiment: 'Frustrated' | 'Neutral' | 'Satisfied' | null,
  ) => {
    try {
      const res = await fetch(`/api/reviews/${reviewId}/sentiment-correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sentiment }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not record the correction.');
      showToast(
        sentiment
          ? `Recorded: the model read this as ${body.modelSaid ?? 'unknown'}, you marked it ${sentiment}. Saved as a training example.`
          : 'Correction withdrawn.',
        'success',
      );
      // refreshData re-points the open panel at the refreshed account for us.
      await refreshData();
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  // One-Click Context Transfer Handler ("Discuss with Advisor")
  const handleDiscussWithAdvisor = (account: Account) => {
    setChatContextAccount(account);
    setActiveTab('advisor');
  };

  // Apply Retention Discount Handler
  const handleApplyDiscount = async (
    account: Account,
    discountPct: number,
    _verificationStatus: 'Direct Approval (Within Manager Limit)' | 'Face Verified (Biometric Pass)',
    _snapshot?: string,
    managerNote?: string,
    includeWalkthrough?: boolean,
    discountMonths: number = MONTHS_PER_TERM
  ) => {
    if (!currentUser) return;

    // Prevent stacking a second discount on top of one that's already active, regardless
    // of which UI surface (offer form, AI Advisor chat, quick-approve) triggered this.
    // An ended discount does not block: its months have elapsed and the account is back
    // at list price. This used to check `currentDiscountApproved > 0`, which locked an
    // account out of every future offer over a discount that had long since expired.
    if (blocksNewOffer(account.discountState)) {
      showToast(
        `${account.name} has ${account.discountLabel} — cannot apply another.`,
        'error'
      );
      return;
    }

    try {
      // Routed on what the offer gives away rather than its headline percentage, so a
      // cheap short discount is no longer escalated and an expensive year-long one no
      // longer slips through. The server enforces the same rule - this only decides
      // which endpoint to call.
      if (currentUser.role === 'account_manager' && needsDirectorApproval(account.mrr, discountPct, discountMonths)) {
        const res = await fetch('/api/discount-requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId: account.id,
            requestedById: currentUser.id,
            discountPct,
            discountMonths,
            managerNote,
            riskScore: account.fusionRiskScore,
            includesWalkthrough: includeWalkthrough || false
          })
        });
        if (!res.ok) throw new Error(`submit failed: ${res.status}`);
      } else {
        // Direct Approval (<=10%) OR Account Director Face Verified approval via handleApproveDiscountRequest
        const res = await fetch(`/api/accounts/${account.id}/apply-discount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            discountPct,
            discountMonths,
            approverId: currentUser.id,
            includesWalkthrough: includeWalkthrough || false
          })
        });
        if (!res.ok) {
          // The server prices the offer against the account's own contract and refuses
          // anything over the Manager's limit. Show that reason rather than a generic
          // failure, or a refused discount looks like an outage.
          const body = await res.json().catch(() => null);
          throw new Error(body?.error || `apply failed: ${res.status}`);
        }
      }
      await refreshData();
    } catch (err: any) {
      console.error('Failed to apply/submit discount:', err);
      showToast(err?.message || 'Could not reach the database — the discount was not saved.', 'error');
    }
  };

  // Director Approval of Discount Request with Facial Verification
  const handleApproveDiscountRequest = async (requestId: string, matchedName?: string) => {
    if (!currentUser) return;
    try {
      const res = await fetch(`/api/discount-requests/${requestId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedById: currentUser.id, matchedName })
      });
      if (!res.ok) throw new Error(`approve failed: ${res.status}`);
      await refreshData();
    } catch (err) {
      console.error('Failed to approve discount request:', err);
      showToast('Could not reach the database — the approval was not saved.', 'error');
    }
  };

  // Director Rejection of Discount Request
  const handleRejectDiscountRequest = async (requestId: string, reason: string) => {
    if (!currentUser) return;
    try {
      const res = await fetch(`/api/discount-requests/${requestId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directorNote: reason, rejectedById: currentUser.id })
      });
      if (!res.ok) throw new Error(`reject failed: ${res.status}`);
      await refreshData();
    } catch (err) {
      console.error('Failed to reject discount request:', err);
      showToast('Could not reach the database — the rejection was not saved.', 'error');
    }
  };

  // Quick 10% Discount Handler from Dashboard
  const handleQuickApproveDiscount = (account: Account, discountPct: number) => {
    handleApplyDiscount(account, discountPct, 'Direct Approval (Within Manager Limit)');
  };

  // Chat "Open Retention Offer" Handler — the chatbot only recommends; executing a
  // discount (or walkthrough) always happens through the real Retention Offer pipeline.
  const handleOpenRetentionOffer = (account: Account) => {
    setAnalysisInitialTab('discount');
    setSelectedAccountForDetail(account);
  };

  const highRiskCount = accounts.filter(a => a.riskCategory === 'High Risk').length;
  // effectiveMrr: what those accounts actually bill today, which is less than list for
  // any of them part-way through a retention discount.
  const totalArrAtRisk = annualContractValue(
    accounts.filter(a => a.riskCategory === 'High Risk').reduce((sum, a) => sum + a.effectiveMrr, 0)
  );

  // Checking for an existing session before deciding what to render at all
  if (isCheckingSession) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center text-slate-500 text-sm font-medium">
        Checking session...
      </div>
    );
  }

  // Render Login Page if not signed in
  if (!isLoggedIn || !currentUser) {
    return authScreen === 'signup'
      ? <SignupPage onSignedUp={handleLogin} onBackToLogin={() => setAuthScreen('login')} />
      : <LoginPage onLogin={handleLogin} onCreateAccount={() => setAuthScreen('signup')} />;
  }

  // Loading / error states while /api/bootstrap is fetched from the database
  // Only on the FIRST load, when there is genuinely nothing to show yet.
  //
  // refreshData() runs after every mutation - submitting a request, applying a
  // discount, approving one - and this used to replace the whole page while it ran.
  // That unmounted everything below it, so any component state went with it: the
  // account analysis page came back on tab 1 no matter which tab you submitted from,
  // because its activeTab is initialised from the initialTab prop at mount.
  //
  // A background refresh should not tear down the UI it is refreshing.
  if (isLoadingData && accounts.length === 0) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center text-slate-500 text-sm font-medium">
        Loading accounts from the database...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-[#F8FAFC] flex flex-col items-center justify-center gap-3 text-center px-4">
        <p className="text-slate-800 font-bold">{loadError}</p>
        <button
          onClick={() => { refreshData(); }}
          className="px-4 py-2 bg-slate-900 text-white text-xs font-bold rounded-lg hover:bg-slate-800"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-800 flex flex-col font-sans selection:bg-slate-800 selection:text-white">
      
      {/* Top Navigation */}
      <Navbar
        activeTab={activeTab}
        setActiveTab={(tab) => {
          setSelectedAccountForDetail(null);
          setActiveTab(tab);
        }}
        highRiskCount={highRiskCount}
        totalArrAtRisk={totalArrAtRisk}
        currentUser={currentUser}
        onLogout={handleLogout}
      />

      {/* Main View Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 space-y-6">
        
        {/* DEDICATED FULL-PAGE ACCOUNT ANALYSIS VIEW */}
        {selectedAccountForDetail ? (
          <AccountAnalysisPage
            account={selectedAccountForDetail}
            currentUser={currentUser}
            discountRequests={discountRequests}
            initialTab={analysisInitialTab}
            onBack={() => {
              setSelectedAccountForDetail(null);
              setAnalysisInitialTab('fusion');
            }}
            onDiscussWithAdvisor={(acc) => {
              handleDiscussWithAdvisor(acc);
              setSelectedAccountForDetail(null);
            }}
            onCorrectSentiment={handleCorrectSentiment}
            onApplyDiscount={handleApplyDiscount}
            onApproveDiscountRequest={handleApproveDiscountRequest}
            onRejectDiscountRequest={handleRejectDiscountRequest}
            onRescored={refreshData}
            renewalIntents={renewalIntents}
            onIntentCancelled={refreshData}
          />
        ) : (
          <>
            {/* DASHBOARD TAB */}
            {activeTab === 'dashboard' && (
              currentUser.role === 'admin' ? (
                /* ADMINISTRATOR VIEW — org structure, not retention work */
                <AdminDashboard
                  currentUser={currentUser}
                  users={users}
                  accounts={accounts}
                  onRefresh={refreshData}
                />
              ) : currentUser.role === 'account_director' ? (
                /* ACCOUNT DIRECTOR VIEW */
                <AccountDirectorDashboard
                  currentUser={currentUser}
                  accounts={accounts}
                  discountRequests={discountRequests}
                  auditLogs={auditLogs}
                  onApproveDiscountRequest={handleApproveDiscountRequest}
                  onRejectDiscountRequest={handleRejectDiscountRequest}
                  onSelectAccountDetail={(acc) => {
                    setAnalysisInitialTab('fusion');
                    setSelectedAccountForDetail(acc);
                  }}
                />
              ) : (
                /* ACCOUNT MANAGER VIEW */
                <Dashboard
                  accounts={accounts}
                  portfolioTrend={portfolioTrend}
                  discountRequests={discountRequests}
                  onSelectAccount={(acc) => {
                    setAnalysisInitialTab('fusion');
                    setSelectedAccountForDetail(acc);
                  }}
                  onDiscussWithAdvisor={handleDiscussWithAdvisor}
                  onQuickApproveDiscount={handleQuickApproveDiscount}
                  onInboxChecked={refreshData}
                />
              )
            )}

            {/* ACCOUNT MANAGER ONLY TABS */}
            {activeTab === 'advisor' && currentUser.role === 'account_manager' && (
              <AIAdvisorChat
                initialAccount={chatContextAccount}
                accounts={accounts}
                onOpenRetentionOffer={handleOpenRetentionOffer}
              />
            )}

            {/* RENEWALS TAB */}
            {activeTab === 'renewals' && (
              <RenewalsView
                accounts={accounts}
                renewalRecords={renewalRecords}
                renewalIntents={renewalIntents}
                onRefresh={refreshData}
              />
            )}

            {/* AUDIT LOG TAB */}
            {activeTab === 'audit' && (
              <AuditTrailView
                auditLogs={auditLogs}
                currentUser={currentUser}
                accounts={accounts}
              />
            )}

            {/* SETTINGS AND PROFILE TAB */}
            {activeTab === 'settings' && (
              <SettingsAndProfileView
                currentUser={currentUser}
                onUpdateCurrentUser={setCurrentUser}
                onLogout={handleLogout}
              />
            )}
          </>
        )}

      </main>

    </div>
  );
}
