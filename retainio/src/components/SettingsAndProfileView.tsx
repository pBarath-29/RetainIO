import React, { useState, useEffect } from 'react';
import { 
  User, 
  Settings, 
  ShieldCheck, 
  Bell, 
  CheckCircle2, 
  Lock, 
  Save, 
  LogOut,
  Key,
  AlertCircle,
  Eye,
  EyeOff,
  Check,
  X,
  Loader2,
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

  // Password Visibility Toggles
  const [showCurrentPw, setShowCurrentPw] = useState(false);
  const [showNewPw, setShowNewPw] = useState(false);
  const [showConfirmPw, setShowConfirmPw] = useState(false);

  // Change Password State
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [logoutOtherSessions, setLogoutOtherSessions] = useState(true);
  const [isSubmittingPassword, setIsSubmittingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [lastPasswordUpdate, setLastPasswordUpdate] = useState<string | null>('30 days ago');

  useEffect(() => {
    setProfileForm(currentUser);
  }, [currentUser]);

  // Password validation checks
  const hasMinLength = newPassword.length >= 8;
  const hasUpper = /[A-Z]/.test(newPassword);
  const hasLower = /[a-z]/.test(newPassword);
  const hasNumber = /[0-9]/.test(newPassword);
  const hasSpecial = /[^A-Za-z0-9]/.test(newPassword);

  const criteriaCount = [hasMinLength, hasUpper, hasLower, hasNumber, hasSpecial].filter(Boolean).length;
  
  const getStrengthLabel = () => {
    if (!newPassword) return { label: 'None', color: 'bg-slate-200', text: 'text-slate-400', width: 'w-0' };
    if (criteriaCount <= 2) return { label: 'Weak', color: 'bg-red-500', text: 'text-red-600', width: 'w-1/4' };
    if (criteriaCount === 3) return { label: 'Fair', color: 'bg-amber-500', text: 'text-amber-600', width: 'w-2/4' };
    if (criteriaCount === 4) return { label: 'Good', color: 'bg-indigo-500', text: 'text-indigo-600', width: 'w-3/4' };
    return { label: 'Strong', color: 'bg-emerald-500', text: 'text-emerald-600', width: 'w-full' };
  };

  const strength = getStrengthLabel();
  const passwordsMatch = newPassword.length > 0 && confirmPassword.length > 0 && newPassword === confirmPassword;

  // Settings State
  const [settings, setSettings] = useState({
    teamsNotifications: true,
  });

  const [activeSection, setActiveSection] = useState<'profile' | 'notifications'>('profile');

  const handleSaveSettings = (e: React.FormEvent) => {
    e.preventDefault();
    showToast('Settings saved successfully.', 'success');
  };

  const handleChangePassword = (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);

    if (!currentPassword) {
      setPasswordError('Please enter your current password.');
      return;
    }
    if (criteriaCount < 4) {
      setPasswordError('Please fulfill at least 4 password security requirements.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirmation do not match.');
      return;
    }
    if (currentPassword === newPassword) {
      setPasswordError('New password must be different from your current password.');
      return;
    }

    setIsSubmittingPassword(true);

    // Simulate API authorization & password update process
    setTimeout(() => {
      setIsSubmittingPassword(false);
      showToast('Password successfully updated across all corporate systems.', 'success');
      setLastPasswordUpdate('Just now');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowCurrentPw(false);
      setShowNewPw(false);
      setShowConfirmPw(false);
    }, 1200);
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

                {/* Industry-Standard Change Password Section */}
                <div className="space-y-5 pt-6 border-t border-slate-100">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 flex items-center space-x-2">
                        <ShieldCheck className="w-4 h-4 text-slate-800" />
                        <span>Security & Password Credentials</span>
                      </h3>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Update your account password following corporate security requirements.
                      </p>
                    </div>
                  </div>

                  {/* Feedback Messages */}
                  {passwordError && (
                    <div className="flex items-start space-x-2.5 text-xs font-semibold px-4 py-3 rounded-xl border bg-red-50 text-red-900 border-red-200">
                      <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="font-bold">Security Check Failed</p>
                        <p className="text-[11px] opacity-90 font-normal mt-0.5">{passwordError}</p>
                      </div>
                    </div>
                  )}

                  <form onSubmit={handleChangePassword} className="space-y-4">
                    {/* Current Password Field */}
                    <div className="space-y-1.5 max-w-md">
                      <div className="flex items-center justify-between">
                        <label htmlFor="settings-current-pw" className="text-xs font-semibold text-slate-700">Current Password</label>
                      </div>
                      <div className="relative">
                        <input
                          id="settings-current-pw"
                          type={showCurrentPw ? 'text' : 'password'}
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder="Enter current password"
                          className="w-full text-xs px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                        />
                        <button
                          type="button"
                          onClick={() => setShowCurrentPw(!showCurrentPw)}
                          aria-label={showCurrentPw ? 'Hide password' : 'Show password'}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer"
                        >
                          {showCurrentPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* New Password & Confirm Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

                      {/* New Password Field */}
                      <div className="space-y-1.5">
                        <label htmlFor="settings-new-pw" className="text-xs font-semibold text-slate-700">New Password</label>
                        <div className="relative">
                          <input
                            id="settings-new-pw"
                            type={showNewPw ? 'text' : 'password'}
                            value={newPassword}
                            onChange={(e) => setNewPassword(e.target.value)}
                            placeholder="Enter new strong password"
                            className="w-full text-xs px-3.5 py-2.5 pr-10 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 bg-white"
                          />
                          <button
                            type="button"
                            onClick={() => setShowNewPw(!showNewPw)}
                            aria-label={showNewPw ? 'Hide password' : 'Show password'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer"
                          >
                            {showNewPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                      {/* Confirm New Password Field */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <label htmlFor="settings-confirm-pw" className="text-xs font-semibold text-slate-700">Confirm New Password</label>
                          {confirmPassword && (
                            <span className={`text-[10px] font-bold flex items-center space-x-1 ${
                              passwordsMatch ? 'text-emerald-600' : 'text-red-500'
                            }`}>
                              {passwordsMatch ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  <span>Passwords match</span>
                                </>
                              ) : (
                                <>
                                  <X className="w-3 h-3" />
                                  <span>Does not match</span>
                                </>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="relative">
                          <input
                            id="settings-confirm-pw"
                            type={showConfirmPw ? 'text' : 'password'}
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Re-enter new password"
                            className={`w-full text-xs px-3.5 py-2.5 pr-10 border rounded-lg focus:outline-none focus:ring-2 bg-white ${
                              confirmPassword && !passwordsMatch
                                ? 'border-red-300 focus:ring-red-500'
                                : 'border-slate-200 focus:ring-slate-900'
                            }`}
                          />
                          <button
                            type="button"
                            onClick={() => setShowConfirmPw(!showConfirmPw)}
                            aria-label={showConfirmPw ? 'Hide password' : 'Show password'}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 rounded cursor-pointer"
                          >
                            {showConfirmPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>

                    </div>

                    {/* Live Password Strength Meter */}
                    {newPassword && (
                      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
                        <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                          <span>Password Strength</span>
                          <span className={`font-bold ${strength.text}`}>{strength.label}</span>
                        </div>
                        
                        {/* Progress Bar */}
                        <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div className={`h-full transition-all duration-300 ${strength.color} ${strength.width}`} />
                        </div>

                        {/* Security Requirement Checklist */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1">
                          <div className={`flex items-center space-x-1.5 text-[11px] font-medium ${
                            hasMinLength ? 'text-emerald-700' : 'text-slate-500'
                          }`}>
                            {hasMinLength ? <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <div className="w-1.5 h-1.5 rounded-full bg-slate-300 ml-1 mr-1" />}
                            <span>At least 8 characters long</span>
                          </div>

                          <div className={`flex items-center space-x-1.5 text-[11px] font-medium ${
                            hasUpper && hasLower ? 'text-emerald-700' : 'text-slate-500'
                          }`}>
                            {hasUpper && hasLower ? <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <div className="w-1.5 h-1.5 rounded-full bg-slate-300 ml-1 mr-1" />}
                            <span>Uppercase & lowercase letters</span>
                          </div>

                          <div className={`flex items-center space-x-1.5 text-[11px] font-medium ${
                            hasNumber ? 'text-emerald-700' : 'text-slate-500'
                          }`}>
                            {hasNumber ? <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <div className="w-1.5 h-1.5 rounded-full bg-slate-300 ml-1 mr-1" />}
                            <span>At least one number (0-9)</span>
                          </div>

                          <div className={`flex items-center space-x-1.5 text-[11px] font-medium ${
                            hasSpecial ? 'text-emerald-700' : 'text-slate-500'
                          }`}>
                            {hasSpecial ? <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <div className="w-1.5 h-1.5 rounded-full bg-slate-300 ml-1 mr-1" />}
                            <span>At least one special symbol (!@#$)</span>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Update Password Action Button */}
                    <div className="pt-2 flex items-center justify-start">
                      <button
                        type="submit"
                        disabled={isSubmittingPassword}
                        className="flex items-center space-x-2 px-5 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white font-bold text-xs shadow-xs transition cursor-pointer"
                      >
                        {isSubmittingPassword ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin text-slate-300" />
                            <span>Updating Credentials...</span>
                          </>
                        ) : (
                          <>
                            <Key className="w-4 h-4" />
                            <span>Update Password</span>
                          </>
                        )}
                      </button>
                    </div>
                  </form>
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

