import React, { useState } from 'react';
import { Account, UserProfile } from '../types';
import { useToast } from './Toast';
import { ShieldCheck, UserPlus, Users, Building2, AlertCircle, Link2, Ban, RotateCcw } from 'lucide-react';

interface AdminDashboardProps {
  currentUser: UserProfile;
  users: UserProfile[];
  accounts: Account[];
  onRefresh: () => Promise<unknown>;
}

// Org administration: who exists, who reports to whom, and who owns which
// customer account. Deliberately the only place these can change — Managers
// can't self-register, and only an admin can revoke access.
//
// Access is revoked by deactivation, never deletion: users appear in the
// audit trail and own accounts, so removing the row would either break a
// foreign key or erase the record of who did what.
export const AdminDashboard: React.FC<AdminDashboardProps> = ({ currentUser, users, accounts, onRefresh }) => {
  const { showToast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDirectorId, setNewDirectorId] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const directors = users.filter(u => u.role === 'account_director');
  const managers = users.filter(u => u.role === 'account_manager');
  // Only active users can be assigned to — the server rejects the rest, so
  // offering them in a dropdown would just produce an error.
  const activeDirectors = directors.filter(u => u.isActive !== false);
  const activeManagers = managers.filter(u => u.isActive !== false);

  const accountsByManager = (managerId: string) => accounts.filter(a => a.accountManager === users.find(u => u.id === managerId)?.name);

  const handleCreateManager = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('create');
    setCreateError(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, email: newEmail, password: newPassword, directorId: newDirectorId || null }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error || 'Could not create the account manager.'); return; }
      showToast(`Created Account Manager ${data.user.name}.`, 'success');
      setNewName(''); setNewEmail(''); setNewPassword(''); setNewDirectorId('');
      await onRefresh();
    } catch {
      setCreateError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  };

  const handleAssignDirector = async (managerId: string, directorId: string) => {
    setBusy(managerId);
    try {
      const res = await fetch(`/api/admin/users/${managerId}/director`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directorId: directorId || null }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Could not update the reporting line.', 'error'); return; }
      showToast(
        directorId
          ? `${data.user.name} now reports to ${data.user.directorName}.`
          : `${data.user.name} is no longer assigned to a Director.`,
        'success',
      );
      await onRefresh();
    } catch {
      showToast('Could not reach the server.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleAssignAccount = async (accountId: string, managerId: string) => {
    setBusy(accountId);
    try {
      const res = await fetch(`/api/admin/accounts/${accountId}/manager`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountManagerId: managerId }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Could not reassign the account.', 'error'); return; }
      showToast('Account reassigned.', 'success');
      await onRefresh();
    } catch {
      showToast('Could not reach the server.', 'error');
    } finally {
      setBusy(null);
    }
  };

  // Revoking access is deactivation, not deletion: a user who has approved a
  // discount or appears in an audit log must keep existing, or the trail stops
  // naming a real person. Deactivating blocks their login immediately and
  // drops their live sessions, while every historical row stays intact.
  const handleToggleActive = async (user: UserProfile, next: boolean) => {
    if (!next && !window.confirm(
      `Deactivate ${user.name}? They'll be signed out immediately and won't be able to log in. ` +
      `Their history stays intact and you can reactivate them later.`
    )) return;
    setBusy(user.id);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: next }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Could not update the account.', 'error'); return; }
      showToast(next ? `${user.name} reactivated.` : `${user.name} deactivated and signed out.`, 'success');
      await onRefresh();
    } catch {
      showToast('Could not reach the server.', 'error');
    } finally {
      setBusy(null);
    }
  };

  const actionButtons = (user: UserProfile) => (
    <div className="inline-flex items-center space-x-1.5">
      {user.isActive === false ? (
        <button
          type="button" onClick={() => handleToggleActive(user, true)} disabled={busy === user.id}
          className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-emerald-700 hover:bg-emerald-50 border border-emerald-200 font-semibold transition cursor-pointer disabled:opacity-50"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Reactivate</span>
        </button>
      ) : (
        <button
          type="button" onClick={() => handleToggleActive(user, false)} disabled={busy === user.id}
          className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-amber-800 hover:bg-amber-50 border border-amber-300 font-semibold transition cursor-pointer disabled:opacity-50"
        >
          <Ban className="w-3.5 h-3.5" />
          <span>Deactivate</span>
        </button>
      )}
    </div>
  );

  return (
    <div className="space-y-6">

      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-violet-950 text-white p-6 rounded-2xl shadow-md border border-slate-800">
        <div className="flex items-center space-x-2">
          <span className="text-xs font-black uppercase tracking-wider px-2.5 py-0.5 rounded bg-violet-500/20 text-violet-300 border border-violet-500/30">
            Administrator
          </span>
          <span className="text-xs text-slate-400 font-medium">Logged in as {currentUser.name}</span>
        </div>
        <h1 className="text-2xl font-black tracking-tight text-white mt-2">Organisation Administration</h1>
        <p className="text-xs text-slate-300 max-w-2xl mt-1">
          Create Account Manager logins, set who reports to which Director, and assign customer accounts.
          A Director only sees the accounts owned by the Managers assigned to them.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Account Directors', value: directors.length, icon: ShieldCheck },
          { label: 'Account Managers', value: managers.length, icon: Users },
          { label: 'Customer Accounts', value: accounts.length, icon: Building2 },
          { label: 'Deactivated Logins', value: users.filter(u => u.isActive === false).length, icon: Ban },
        ].map(stat => (
          <div key={stat.label} className="bg-white border border-slate-200 rounded-xl p-4 space-y-1 shadow-xs">
            <div className="flex items-center space-x-1.5">
              <stat.icon className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">{stat.label}</span>
            </div>
            <p className="text-2xl font-black text-slate-900">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Create an Account Manager */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex items-center space-x-2">
          <UserPlus className="w-4 h-4 text-violet-600" />
          <h2 className="text-sm font-bold text-slate-900">Create Account Manager</h2>
        </div>
        <p className="text-xs text-slate-500">
          Account Managers cannot register themselves — their login is created here. Directors self-register,
          because only they can enrol their own face.
        </p>

        <form onSubmit={handleCreateManager} className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <input
            required value={newName} onChange={e => setNewName(e.target.value)} placeholder="Full name"
            className="px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
          />
          <input
            required type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="Work email"
            className="px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
          />
          <input
            required minLength={8} type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
            placeholder="Temporary password"
            className="px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
          />
          <select
            value={newDirectorId} onChange={e => setNewDirectorId(e.target.value)}
            className="px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
          >
            <option value="">No Director yet</option>
            {activeDirectors.map(d => <option key={d.id} value={d.id}>Reports to {d.name}</option>)}
          </select>

          {createError && (
            <div className="md:col-span-4 flex items-start space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{createError}</span>
            </div>
          )}

          <button
            type="submit" disabled={busy === 'create'}
            className="md:col-span-4 md:w-auto md:justify-self-start px-5 py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs rounded-xl shadow-md transition cursor-pointer disabled:opacity-60"
          >
            {busy === 'create' ? 'Creating…' : 'Create Account Manager'}
          </button>
        </form>
      </div>

      {/* Reporting lines */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center space-x-2">
          <Link2 className="w-4 h-4 text-violet-600" />
          <h2 className="text-sm font-bold text-slate-900">Manager → Director Assignments</h2>
        </div>

        {managers.length === 0 ? (
          <p className="p-6 text-xs text-slate-500 text-center">No Account Managers yet — create one above.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-bold">Account Manager</th>
                <th className="px-5 py-3 font-bold">Accounts Owned</th>
                <th className="px-5 py-3 font-bold">Reports To</th>
                <th className="px-5 py-3 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {managers.map(m => (
                <tr key={m.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-3">
                    <span className="font-bold text-slate-900 block">
                      {m.name}
                      {m.isActive === false && (
                        <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 align-middle">
                          Deactivated
                        </span>
                      )}
                    </span>
                    <span className="text-slate-400">{m.email}</span>
                  </td>
                  <td className="px-5 py-3 font-mono font-bold text-slate-700">{accountsByManager(m.id).length}</td>
                  <td className="px-5 py-3">
                    <select
                      value={m.directorId || ''}
                      disabled={busy === m.id}
                      onChange={e => handleAssignDirector(m.id, e.target.value)}
                      className={`px-2.5 py-1.5 border rounded-lg text-xs font-semibold focus:ring-2 focus:ring-slate-900 focus:outline-none transition ${
                        m.directorId ? 'bg-white border-slate-300 text-slate-900' : 'bg-amber-50 border-amber-300 text-amber-900'
                      }`}
                    >
                      <option value="">Unassigned</option>
                      {activeDirectors.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </td>
                  <td className="px-5 py-3 text-right">
                    {actionButtons(m)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Directors */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center space-x-2">
          <ShieldCheck className="w-4 h-4 text-violet-600" />
          <h2 className="text-sm font-bold text-slate-900">Account Directors</h2>
        </div>

        {directors.length === 0 ? (
          <p className="p-6 text-xs text-slate-500 text-center">
            No Account Directors yet — a Director registers themselves from the sign-up page so they can enrol their face.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
                <th className="px-5 py-3 font-bold">Director</th>
                <th className="px-5 py-3 font-bold">Team</th>
                <th className="px-5 py-3 font-bold">Biometric</th>
                <th className="px-5 py-3 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {directors.map(d => {
                const team = managers.filter(m => m.directorId === d.id);
                return (
                  <tr key={d.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-5 py-3">
                      <span className="font-bold text-slate-900 block">
                        {d.name}
                        {d.isActive === false && (
                          <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-600 align-middle">
                            Deactivated
                          </span>
                        )}
                      </span>
                      <span className="text-slate-400">{d.email}</span>
                    </td>
                    <td className="px-5 py-3 text-slate-700">
                      {team.length === 0
                        ? <span className="text-amber-700 font-semibold">No managers — dashboard will be empty</span>
                        : team.map(m => m.name).join(', ')}
                    </td>
                    <td className="px-5 py-3">
                      {d.faceEnrolled
                        ? <span className="font-semibold text-emerald-700">Face enrolled</span>
                        : <span className="font-semibold text-red-700">Not enrolled — cannot approve</span>}
                    </td>
                    <td className="px-5 py-3 text-right">
                      {actionButtons(d)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Customer account ownership */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center space-x-2">
          <Building2 className="w-4 h-4 text-violet-600" />
          <h2 className="text-sm font-bold text-slate-900">Customer Account Ownership</h2>
        </div>

        <table className="w-full text-xs">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500">
              <th className="px-5 py-3 font-bold">Account</th>
              <th className="px-5 py-3 font-bold">MRR</th>
              <th className="px-5 py-3 font-bold">Risk</th>
              <th className="px-5 py-3 font-bold">Owned By</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map(a => {
              const owner = managers.find(m => m.name === a.accountManager);
              return (
                <tr key={a.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-5 py-3 font-bold text-slate-900">{a.name}</td>
                  {/* What the account bills today; the list rate is shown alongside when
                      a discount is currently reducing it. */}
                  <td className="px-5 py-3 font-mono text-slate-700">
                    ${a.effectiveMrr.toLocaleString()}
                    {a.discountState === 'active' && (
                      <span className="text-slate-400 text-[11px]"> / ${a.mrr.toLocaleString()}</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`font-bold ${
                      a.riskCategory === 'High Risk' ? 'text-red-600'
                        : a.riskCategory === 'Medium Risk' ? 'text-amber-600' : 'text-emerald-600'
                    }`}>{a.fusionRiskScore}</span>
                  </td>
                  <td className="px-5 py-3">
                    <select
                      value={owner?.id || ''}
                      disabled={busy === a.id}
                      onChange={e => handleAssignAccount(a.id, e.target.value)}
                      className="px-2.5 py-1.5 bg-white border border-slate-300 rounded-lg text-xs font-semibold focus:ring-2 focus:ring-slate-900 focus:outline-none transition"
                    >
                      {activeManagers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

    </div>
  );
};
