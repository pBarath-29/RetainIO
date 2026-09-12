import React, { useState, useEffect } from 'react';
import { 
  User,
  Settings,
  Bell,
  CheckCircle2,
  Lock,
  Save,
  LogOut,
  ShieldAlert
} from 'lucide-react';
import { UserProfile } from '../types';
import { useToast } from './Toast';

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
  const { showToast } = useToast();

  // Local Profile Form State synced with currentUser
  const [profileForm, setProfileForm] = useState<UserProfile>(currentUser);

  useEffect(() => {
    setProfileForm(currentUser);
  }, [currentUser]);

  // Settings State
  const [settings, setSettings] = useState({
    teamsNotifications: true,
  });

  const [activeSection, setActiveSection] = useState<'profile' | 'notifications'>('profile');

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    showToast('Settings saved successfully.', 'success');
  };

  return (
    <div className="space-y-6">
      
      {/* Page Title & Save / Logout Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-6 rounded-xl border border-slate-200 shadow-xs">
        <div>
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold">
              <User className="w-4 h-4" />
            </div>
            <h1 className="text-xl font-black text-slate-900 tracking-tight">Account Profile & System Settings</h1>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            View your active profile details, job title, department, and notification preferences.
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

      {/* Main Grid: Sidebar Navigation + Content Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Side Navigation Tabs */}
        <div className="lg:col-span-3 space-y-2">
          <div className="bg-white rounded-xl border border-slate-200 p-2 space-y-1 shadow-xs">
            <button
              onClick={() => setActiveSection('profile')}
              className={`w-full flex items-center space-x-3 px-3.5 py-2.5 rounded-lg text-xs font-semibold transition text-left cursor-pointer ${
                activeSection === 'profile'
                  ? 'bg-slate-900 text-white font-bold shadow-xs'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <User className="w-4 h-4" />
              <span>User Profile Credentials</span>
            </button>

            <button
              onClick={() => setActiveSection('notifications')}
              className={`w-full flex items-center space-x-3 px-3.5 py-2.5 rounded-lg text-xs font-semibold transition text-left cursor-pointer ${
                activeSection === 'notifications'
                  ? 'bg-slate-900 text-white font-bold shadow-xs'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Bell className="w-4 h-4" />
              <span>Notifications</span>
            </button>
          </div>
        </div>

        {/* Right Side Settings Form Content */}
        <div className="lg:col-span-9">

          {/* SECTION 1: User Profile & Identity */}
          {activeSection === 'profile' && (
            <div className="space-y-6">
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
          )}

          {/* SECTION 2: Notifications */}
          {activeSection === 'notifications' && (
            <form onSubmit={handleSaveSettings} className="space-y-6">
              <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-6 shadow-xs">
                
                <div className="space-y-1 border-b border-slate-100 pb-3">
                  <h2 className="text-sm font-bold text-slate-900">Notifications</h2>
                  <p className="text-xs text-slate-500">Manage alerts and notifications for important updates.</p>
                </div>

                <div className="space-y-4">
                  
                  <label className="flex items-start space-x-3 cursor-pointer p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <input
                      type="checkbox"
                      checked={settings.teamsNotifications}
                      onChange={(e) => setSettings({ ...settings, teamsNotifications: e.target.checked })}
                      className="mt-0.5 rounded text-slate-900 focus:ring-slate-900 cursor-pointer"
                    />
                    <div className="text-xs">
                      <span className="font-bold text-slate-900 block">Teams Notification Alert</span>
                      <span className="text-slate-500 text-[11px]">
                        Receive Teams notifications for important updates.
                      </span>
                    </div>
                  </label>

                </div>

              </div>

              {/* Bottom Save Action Bar for Notifications */}
              <div className="flex items-center justify-end space-x-3 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
                <button
                  type="submit"
                  className="flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs shadow-xs transition cursor-pointer"
                >
                  <Save className="w-4 h-4" />
                  <span>Save Changes</span>
                </button>
              </div>
            </form>
          )}

        </div>

      </div>

    </div>
  );
};

