import React from 'react';
import { ShieldAlert, Bot, Activity, FileText, Settings, User, CalendarClock } from 'lucide-react';
import { UserProfile } from '../types';

interface NavbarProps {
  activeTab: 'dashboard' | 'advisor' | 'renewals' | 'audit' | 'settings';
  setActiveTab: (tab: 'dashboard' | 'advisor' | 'renewals' | 'audit' | 'settings') => void;
  highRiskCount: number;
  totalArrAtRisk: number;
  currentUser?: UserProfile;
  onLogout?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  highRiskCount,
  totalArrAtRisk,
  currentUser
}) => {
  const isDirector = currentUser?.role === 'account_director';
  const isAdmin = currentUser?.role === 'admin';
  // The AI Advisor and pipeline tools belong to the people who work a
  // book of accounts. An admin manages org structure and has none.
  const isManager = currentUser?.role === 'account_manager';

  return (
    <header className="bg-white border-b border-slate-200 text-slate-800 sticky top-0 z-40 shadow-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          
          {/* Logo & Platform Name */}
          <div className="flex items-center space-x-3 cursor-pointer" onClick={() => setActiveTab('dashboard')}>
            <div className="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center text-white font-black text-base shadow-xs">
              R
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-extrabold text-lg text-slate-900 tracking-tight">
                  RetainIO
                </span>
              </div>
              <p className="text-[11px] text-slate-500 hidden sm:block">
                {isAdmin ? 'Organisation Administration' : isDirector ? 'Account Director Command Center' : 'B2B SaaS Churn & Retention Analytics'}
              </p>
            </div>
          </div>

          {/* Role-Specific Navigation Tabs */}
          <nav className="hidden md:flex space-x-1 bg-slate-100/80 p-1 rounded-lg border border-slate-200">
            
            <button
              onClick={() => setActiveTab('dashboard')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition cursor-pointer ${
                activeTab === 'dashboard'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              <Activity className="w-3.5 h-3.5" />
              <span>{isAdmin ? 'Administration' : isDirector ? 'Executive Command Center' : 'Dashboard'}</span>
            </button>

            {/* Account Manager Only Tabs */}
            {isManager && (
              <button
                onClick={() => setActiveTab('advisor')}
                className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition cursor-pointer ${
                  activeTab === 'advisor'
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
                }`}
              >
                <Bot className="w-3.5 h-3.5" />
                <span>Advisor Assistant</span>
              </button>
            )}

            <button
              onClick={() => setActiveTab('renewals')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition cursor-pointer ${
                activeTab === 'renewals'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              <CalendarClock className="w-3.5 h-3.5" />
              <span>Renewals</span>
            </button>

            <button
              onClick={() => setActiveTab('audit')}
              className={`flex items-center space-x-2 px-3.5 py-1.5 rounded-md text-xs font-semibold transition cursor-pointer ${
                activeTab === 'audit'
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/60'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Audit Log</span>
            </button>
          </nav>

          {/* Quick Stats Metrics Bar */}
          <div className="flex items-center space-x-3">
            <div className="hidden xl:flex items-center space-x-3 text-xs bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
              <div className="flex items-center space-x-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-red-600" />
                <span className="text-slate-500 font-medium">High Risk:</span>
                <span className="font-bold text-red-700">{highRiskCount}</span>
              </div>
              <span className="text-slate-300">|</span>
              <div className="flex items-center space-x-1.5">
                <span className="text-slate-500 font-medium">ARR At Risk:</span>
                <span className="font-bold text-slate-900">${(totalArrAtRisk / 1000).toFixed(0)}k</span>
              </div>
            </div>

            {/* User Profile Badge Button -> Navigates to Profile & Settings */}
            <button
              onClick={() => setActiveTab('settings')}
              title="Click to view Profile & Settings"
              className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg border transition cursor-pointer text-slate-800 ${
                activeTab === 'settings'
                  ? 'bg-slate-900 text-white border-slate-900 shadow-xs'
                  : 'bg-slate-50 border-slate-200 hover:bg-slate-100 hover:border-slate-300'
              }`}
            >
              <div className={`w-7 h-7 rounded-full font-bold flex items-center justify-center text-xs border shrink-0 ${
                activeTab === 'settings' ? 'bg-white text-slate-900 border-white' : 'bg-slate-900 text-white border-slate-700'
              }`}>
                {currentUser?.avatarInitials || 'SJ'}
              </div>
              <div className="text-left hidden sm:block">
                <p className={`text-xs font-bold leading-tight ${activeTab === 'settings' ? 'text-white' : 'text-slate-900'}`}>
                  {currentUser?.name || 'Sarah Jenkins'}
                </p>
              </div>
            </button>

          </div>

        </div>
      </div>

      {/* Mobile Tab bar */}
      <div className="md:hidden flex border-t border-slate-200 bg-slate-50 divide-x divide-slate-200 text-xs">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`flex-1 py-2 text-center flex items-center justify-center space-x-1 font-semibold ${
            activeTab === 'dashboard' ? 'text-slate-900 bg-white font-bold' : 'text-slate-600'
          }`}
        >
          <Activity className="w-3.5 h-3.5" />
          <span>{isAdmin ? 'Admin' : isDirector ? 'Command' : 'Dashboard'}</span>
        </button>

        {isManager && (
          <button
            onClick={() => setActiveTab('advisor')}
            className={`flex-1 py-2 text-center flex items-center justify-center space-x-1 font-semibold ${
              activeTab === 'advisor' ? 'text-slate-900 bg-white font-bold' : 'text-slate-600'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>Advisor</span>
          </button>
        )}

        <button
          onClick={() => setActiveTab('renewals')}
          className={`flex-1 py-2 text-center flex items-center justify-center space-x-1 font-semibold ${
            activeTab === 'renewals' ? 'text-slate-900 bg-white font-bold' : 'text-slate-600'
          }`}
        >
          <CalendarClock className="w-3.5 h-3.5" />
          <span>Renewals</span>
        </button>

        <button
          onClick={() => setActiveTab('audit')}
          className={`flex-1 py-2 text-center flex items-center justify-center space-x-1 font-semibold ${
            activeTab === 'audit' ? 'text-slate-900 bg-white font-bold' : 'text-slate-600'
          }`}
        >
          <FileText className="w-3.5 h-3.5" />
          <span>Audit</span>
        </button>
      </div>
    </header>
  );
};

