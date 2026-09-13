import React, { useState, useEffect } from 'react';
import { User, CheckCircle2, Lock, LogOut } from 'lucide-react';
import { UserProfile } from '../types';

interface SettingsAndProfileViewProps {
  currentUser: UserProfile;
  onUpdateCurrentUser?: (updated: UserProfile) => void;
  onLogout?: () => void;
}

export const SettingsAndProfileView: React.FC<SettingsAndProfileViewProps> = ({
  currentUser,
  onUpdateCurrentUser,
  onLogout
}) => {
  // Local Profile Form State synced with currentUser
  const [profileForm, setProfileForm] = useState<UserProfile>(currentUser);

  useEffect(() => {
    setProfileForm(currentUser);
  }, [currentUser]);

  return (
    <div className="space-y-6">

      {/* Page title and Log Out */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-xs">
        <div>
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold">
              <User className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-black text-slate-900 tracking-tight">Account Profile</h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            View your profile details, job title and department.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          {onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="flex items-center space-x-1.5 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold px-3.5 py-2 rounded-lg border border-red-200 transition cursor-pointer shadow-2xs"
            >
              <LogOut className="w-4 h-4" />
              <span>Log Out</span>
            </button>
          )}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-6 shadow-xs">
        
        {/* Active Profile Header Card */}
        <div className="flex flex-col sm:flex-row items-center space-y-4 sm:space-y-0 sm:space-x-5 p-4 bg-slate-50 border border-slate-200 rounded-xl">
          <div className="relative">
            <div className="w-20 h-20 rounded-full bg-slate-900 text-white text-2xl font-black flex items-center justify-center border-4 border-white shadow-md">
              {profileForm.avatarInitials}
            </div>
            <div className="absolute bottom-0 right-0 w-6 h-6 rounded-full bg-emerald-500 border-2 border-white flex items-center justify-center text-white" title="Active">
              <CheckCircle2 className="w-3.5 h-3.5" />
            </div>
          </div>

          <div className="text-center sm:text-left space-y-1">
            <div className="flex items-center space-x-2 justify-center sm:justify-start">
              <h2 className="text-lg font-bold text-slate-900">{profileForm.name}</h2>
            </div>
            <p className="text-xs text-slate-500 font-medium">{profileForm.title} &bull; {profileForm.department}</p>
            <div className="flex flex-wrap justify-center sm:justify-start gap-2 pt-1">
              <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
                ID: {profileForm.employeeId}
              </span>
            </div>
          </div>
        </div>

        {/* Personal Information Fields - Read Only / Disabled */}
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Active User Details
            </h3>
            <span className="flex items-center space-x-1 text-[11px] font-semibold text-slate-500 bg-slate-100 px-2.5 py-0.5 rounded border border-slate-200">
              <Lock className="w-3 h-3 text-slate-400" />
              <span>Read-Only Account Details</span>
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Full Name</label>
              <input
                type="text"
                disabled
                value={profileForm.name}
                className="w-full text-xs px-3 py-2 border border-slate-200 bg-slate-100 text-slate-600 rounded-lg cursor-not-allowed font-medium"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Work Email</label>
              <input
                type="email"
                disabled
                value={profileForm.email}
                className="w-full text-xs px-3 py-2 border border-slate-200 bg-slate-100 text-slate-600 rounded-lg cursor-not-allowed font-medium"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Job Title</label>
              <input
                type="text"
                disabled
                value={profileForm.title}
                className="w-full text-xs px-3 py-2 border border-slate-200 bg-slate-100 text-slate-600 rounded-lg cursor-not-allowed font-medium"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-700">Department</label>
              <input
                type="text"
                disabled
                value={profileForm.department}
                className="w-full text-xs px-3 py-2 border border-slate-200 bg-slate-100 text-slate-600 rounded-lg cursor-not-allowed font-medium"
              />
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
