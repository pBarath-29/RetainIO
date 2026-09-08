import React, { useState } from 'react';
import { UserProfile } from '../types';
import { ShieldCheck, Lock, Eye, EyeOff, ArrowRight, AlertCircle } from 'lucide-react';

interface LoginPageProps {
  onLogin: (profile: UserProfile) => void;
  onCreateAccount: () => void;
}

export const LoginPage: React.FC<LoginPageProps> = ({ onLogin, onCreateAccount }) => {
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [rememberMe, setRememberMe] = useState<boolean>(true);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, rememberDevice: rememberMe })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Sign in failed.');
        return;
      }
      onLogin(data.user);
    } catch (err) {
      console.error('Login request failed:', err);
      setError('Could not reach the server. Is it running?');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-center items-center p-4 sm:p-6 text-slate-900 font-sans">

      {/* Login Container Box */}
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">

        {/* Brand Header */}
        <div className="bg-slate-900 text-white p-6 sm:p-8 text-center relative">
          <div className="w-12 h-12 bg-amber-500 rounded-xl flex items-center justify-center mx-auto mb-3 shadow-lg">
            <ShieldCheck className="w-7 h-7 text-slate-950" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white">RetainIO</h1>
          <p className="text-xs text-slate-400 font-medium mt-1">Retention Intelligence & Churn Analytics</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="p-6 sm:p-8 space-y-4">
          <div>
            <label htmlFor="login-email" className="block text-xs font-bold text-slate-700 mb-1">
              Work Email Address
            </label>
            <div className="relative">
              <input
                id="login-email"
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-3 pr-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-900 font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
                placeholder="name@company.com"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="login-password" className="block text-xs font-bold text-slate-700">
                Password
              </label>
              <a href="#" onClick={(e) => e.preventDefault()} className="text-xs text-indigo-600 hover:text-indigo-800 font-semibold">
                Forgot password?
              </a>
            </div>
            <div className="relative">
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-3 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm text-slate-900 font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
                placeholder="••••••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-3 text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <label className="flex items-center space-x-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="rounded text-slate-900 focus:ring-slate-900 h-4 w-4"
              />
              <span className="font-medium">Remember this device</span>
            </label>

            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
              SSO Enabled
            </span>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm rounded-xl shadow-md transition flex items-center justify-center space-x-2 cursor-pointer mt-2 disabled:opacity-60"
          >
            {isSubmitting ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <>
                <span>Sign In</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>

          <p className="text-center text-xs text-slate-500 pt-1">
            Don't have an account?{' '}
            <button
              type="button"
              onClick={onCreateAccount}
              className="text-indigo-600 hover:text-indigo-800 font-semibold cursor-pointer"
            >
              Create one
            </button>
          </p>
        </form>

        {/* Demo credentials — this is a coursework demo database, not a real
            production directory; a real deployment would never print this. */}
        <div className="mx-6 mb-6 text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3">
          <p className="font-bold text-slate-600 mb-1">Seeded logins (shared temporary password):</p>
          <p className="font-mono">admin@retain.io <span className="text-slate-400">— administrator</span></p>
          <p className="font-mono">sarah.jenkins@retain.io · elena.rostova@retain.io <span className="text-slate-400">— managers</span></p>
          <p className="font-mono mt-1">Password: RetainIO!2026</p>
          <p className="mt-2 text-slate-400 leading-relaxed">
            Account Directors aren't seeded — a Director enrols their own face at signup, so register one
            with “Create an account” above.
          </p>
        </div>

        {/* Security Footer */}
        <div className="bg-slate-50 border-t border-slate-200 p-4 text-center text-xs text-slate-500 flex items-center justify-center space-x-2">
          <Lock className="w-3.5 h-3.5 text-slate-400" />
          <span>Enterprise SAML 2.0 / OKTA / Biometric Verification</span>
        </div>

      </div>

    </div>
  );
};
