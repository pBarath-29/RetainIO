import React, { useEffect, useRef, useState } from 'react';
import { UserProfile } from '../types';
import { ShieldCheck, Lock, Eye, EyeOff, ArrowRight, AlertCircle, Camera, CheckCircle2, ScanFace } from 'lucide-react';

interface SignupPageProps {
  onSignedUp: (profile: UserProfile) => void;
  onBackToLogin: () => void;
}

// Self-registration is for Account Directors only — Account Manager logins
// are created by an admin, since a Manager's account is meaningless until
// someone assigns them a Director and accounts. Step 2 enrols the Director's
// face: their approvals are gated on a biometric check (/api/face-verify),
// and only the person themselves can enrol it.
export const SignupPage: React.FC<SignupPageProps> = ({ onSignedUp, onBackToLogin }) => {
  const [step, setStep] = useState<'details' | 'face'>('details');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [title, setTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [rememberMe, setRememberMe] = useState(true);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<UserProfile | null>(null);

  // ── face enrolment (Directors only) ──────────────────────────────────────
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [streamActive, setStreamActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [samples, setSamples] = useState(0);
  const [isCapturing, setIsCapturing] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);

  const REQUIRED_SAMPLES = 3; // more angles => a more reliable match at approval time

  useEffect(() => {
    if (step === 'face') startCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const startCamera = async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        setStreamActive(true);
      }
    } catch (err) {
      console.warn('Webcam access denied:', err);
      setCameraError('Camera access is required to enrol a Director. Allow camera permission and reload.');
      setStreamActive(false);
    }
  };

  const stopCamera = () => {
    const stream = videoRef.current?.srcObject as MediaStream | null;
    stream?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreamActive(false);
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role: 'account_director', title, department, rememberDevice: rememberMe }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Could not create the account.');
        return;
      }
      setCreatedUser(data.user);
      // The session cookie is already set, so enrolment can authenticate.
      if (data.faceEnrollmentRequired) setStep('face');
      else onSignedUp(data.user);
    } catch (err) {
      console.error('Signup request failed:', err);
      setError('Could not reach the server. Is it running?');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCaptureSample = async () => {
    if (!streamActive || !videoRef.current || !canvasRef.current) return;
    setIsCapturing(true);
    setEnrollError(null);
    try {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const res = await fetch('/api/auth/enroll-face', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: canvas.toDataURL('image/png') }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        // A failed capture is normal (no face in frame) — report it and let
        // them retry rather than counting a sample that wasn't stored.
        setEnrollError(data.error || 'Capture failed — try again.');
        return;
      }
      setSamples(data.samples);
    } catch (err) {
      console.error('Face enrolment failed:', err);
      setEnrollError('Could not reach the face service.');
    } finally {
      setIsCapturing(false);
    }
  };

  const finishEnrolment = () => {
    stopCamera();
    if (createdUser) onSignedUp({ ...createdUser, faceEnrolled: true, biometricStatus: 'Biometric Verified' });
  };

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col justify-center items-center p-4 sm:p-6 text-slate-900 font-sans">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden">

        <div className="bg-slate-900 text-white p-6 sm:p-8 text-center">
          <div className="w-12 h-12 bg-amber-500 rounded-xl flex items-center justify-center mx-auto mb-3 shadow-lg">
            <ShieldCheck className="w-7 h-7 text-slate-950" />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white">Create your account</h1>
          <p className="text-xs text-slate-400 font-medium mt-1">
            {step === 'details' ? 'RetainIO — Retention Intelligence' : 'Step 2 of 2 — Biometric enrolment'}
          </p>
        </div>

        {step === 'details' && (
          <form onSubmit={handleCreateAccount} className="p-6 sm:p-8 space-y-4">

            <div className="flex items-start space-x-2 text-[11px] text-slate-600 bg-slate-50 border border-slate-200 rounded-lg p-3">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-slate-400" />
              <span>
                This registers an <strong>Account Director</strong>. Account Manager logins are created by an
                administrator — ask them to set yours up.
              </span>
            </div>

            <div>
              <label htmlFor="signup-name" className="block text-xs font-bold text-slate-700 mb-1">Full Name</label>
              <input
                id="signup-name" type="text" required value={name} onChange={e => setName(e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
                placeholder="Alex Tan"
              />
            </div>

            <div>
              <label htmlFor="signup-email" className="block text-xs font-bold text-slate-700 mb-1">Work Email Address</label>
              <input
                id="signup-email" type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
                placeholder="name@company.com"
              />
            </div>

            <div>
              <label htmlFor="signup-password" className="block text-xs font-bold text-slate-700 mb-1">Password</label>
              <div className="relative">
                <input
                  id="signup-password" type={showPassword ? 'text' : 'password'} required minLength={8}
                  autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full pl-3 pr-10 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
                  placeholder="At least 8 characters"
                />
                <button
                  type="button" onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-3 text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="signup-title" className="block text-xs font-bold text-slate-700 mb-1">Job Title <span className="font-normal text-slate-400">(optional)</span></label>
                <input
                  id="signup-title" type="text" value={title} onChange={e => setTitle(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
                  placeholder="Account Director"
                />
              </div>
              <div>
                <label htmlFor="signup-dept" className="block text-xs font-bold text-slate-700 mb-1">Department <span className="font-normal text-slate-400">(optional)</span></label>
                <input
                  id="signup-dept" type="text" value={department} onChange={e => setDepartment(e.target.value)}
                  className="w-full px-3 py-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-900 focus:bg-white focus:outline-none transition"
                  placeholder="Customer Success"
                />
              </div>
            </div>

            {(
              <div className="flex items-start space-x-2 text-[11px] text-indigo-900 bg-indigo-50 border border-indigo-200 rounded-lg p-3">
                <ScanFace className="w-4 h-4 shrink-0 mt-0.5 text-indigo-600" />
                <span>
                  As a Director you approve discounts above 10%, which requires a biometric check.
                  The next step captures your face so approvals can be verified as yours.
                </span>
              </div>
            )}

            <label className="flex items-center space-x-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={e => setRememberMe(e.target.checked)}
                className="rounded text-slate-900 focus:ring-slate-900 h-4 w-4"
              />
              <span className="font-medium">Remember this device for 30 days</span>
            </label>

            {error && (
              <div className="flex items-start space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit" disabled={isSubmitting}
              className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm rounded-xl shadow-md transition flex items-center justify-center space-x-2 cursor-pointer mt-2 disabled:opacity-60"
            >
              {isSubmitting ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              ) : (
                <>
                  <span>Continue to face enrolment</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>

            <p className="text-center text-xs text-slate-500 pt-1">
              Already have an account?{' '}
              <button type="button" onClick={onBackToLogin} className="text-indigo-600 hover:text-indigo-800 font-semibold cursor-pointer">
                Sign in
              </button>
            </p>
          </form>
        )}

        {step === 'face' && (
          <div className="p-6 sm:p-8 space-y-4">
            <p className="text-xs text-slate-600 leading-relaxed">
              Capture <strong>{REQUIRED_SAMPLES}</strong> photos of your face from slightly different angles.
              These are stored against your account, and every discount approval you make will be checked against them.
            </p>

            <div className="relative bg-slate-900 rounded-xl overflow-hidden aspect-4/3 flex items-center justify-center">
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
              <canvas ref={canvasRef} className="hidden" />
              {!streamActive && (
                <div className="absolute inset-0 flex items-center justify-center text-center p-4">
                  <span className="text-xs text-slate-400">{cameraError || 'Starting camera…'}</span>
                </div>
              )}
            </div>

            <div className="flex items-center justify-center space-x-2">
              {Array.from({ length: REQUIRED_SAMPLES }).map((_, i) => (
                <span
                  key={i}
                  className={`w-2.5 h-2.5 rounded-full transition ${i < samples ? 'bg-emerald-500' : 'bg-slate-300'}`}
                />
              ))}
              <span className="text-xs text-slate-500 font-medium pl-1">{samples}/{REQUIRED_SAMPLES} captured</span>
            </div>

            {enrollError && (
              <div className="flex items-start space-x-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{enrollError}</span>
              </div>
            )}

            {samples < REQUIRED_SAMPLES ? (
              <button
                type="button" onClick={handleCaptureSample} disabled={!streamActive || isCapturing}
                className="w-full py-3 bg-slate-900 hover:bg-slate-800 text-white font-bold text-sm rounded-xl shadow-md transition flex items-center justify-center space-x-2 cursor-pointer disabled:opacity-60"
              >
                {isCapturing ? (
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                ) : (
                  <>
                    <Camera className="w-4 h-4" />
                    <span>Capture photo {samples + 1}</span>
                  </>
                )}
              </button>
            ) : (
              <>
                <div className="flex items-center space-x-2 text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                  <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
                  <span>Face enrolled. Your approvals can now be biometrically verified.</span>
                </div>
                <button
                  type="button" onClick={finishEnrolment}
                  className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm rounded-xl shadow-md transition flex items-center justify-center space-x-2 cursor-pointer"
                >
                  <span>Enter RetainIO</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        )}

        <div className="bg-slate-50 border-t border-slate-200 p-4 text-center text-xs text-slate-500 flex items-center justify-center space-x-2">
          <Lock className="w-3.5 h-3.5 text-slate-400" />
          <span>Enterprise SAML 2.0 / OKTA / Biometric Verification</span>
        </div>
      </div>
    </div>
  );
};
