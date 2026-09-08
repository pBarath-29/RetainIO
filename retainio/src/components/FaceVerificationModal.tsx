import React, { useState, useRef, useEffect } from 'react';
import { Camera, CheckCircle2, ShieldCheck, AlertCircle, X, UserCheck, XCircle } from 'lucide-react';
import { useModalA11y } from '../hooks/useModalA11y';

interface FaceVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountName: string;
  discountPct: number;
  onVerified: (snapshotDataUrl: string, matchedName?: string) => void;
}

export const FaceVerificationModal: React.FC<FaceVerificationModalProps> = ({
  isOpen,
  onClose,
  accountName,
  discountPct,
  onVerified
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { dialogRef, backdropProps } = useModalA11y(isOpen, onClose, { closeOnBackdropClick: false });

  const [streamActive, setStreamActive] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [verified, setVerified] = useState<boolean>(false);
  const [capturedSnapshot, setCapturedSnapshot] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);

  // Real result from server.ts -> face_app's /api/scan — not assumed.
  const [matchedName, setMatchedName] = useState<string | null>(null);
  const [confidenceScore, setConfidenceScore] = useState<number | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      startCamera();
    } else {
      stopCamera();
      setVerified(false);
      setCapturedSnapshot(null);
      setIsScanning(false);
      setScanProgress(0);
      setMatchedName(null);
      setConfidenceScore(null);
      setVerifyError(null);
    }
    return () => {
      stopCamera();
    };
  }, [isOpen]);

  const startCamera = async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
      });
      // Held in a ref as well as on the element: if the video element is ever
      // unmounted (modal closed mid-request) the tracks still need stopping,
      // otherwise the camera stays on with nowhere to display.
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setStreamActive(true);
    } catch (err: any) {
      console.warn('Webcam access denied:', err);
      setCameraError('Camera access is required for biometric approval. Allow camera permission and try again.');
      setStreamActive(false);
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStreamActive(false);
  };

  const handleStartScan = () => {
    setIsScanning(true);
    setScanProgress(0);
    setVerifyError(null);
    setCapturedSnapshot(null);

    let current = 0;
    const interval = setInterval(() => {
      current += 10;
      setScanProgress(current);

      if (current >= 100) {
        clearInterval(interval);
        captureSnapshotAndVerify();
      }
    }, 150);
  };

  const captureSnapshotAndVerify = async () => {
    let dataUrl = '';
    if (streamActive && videoRef.current && canvasRef.current) {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        dataUrl = canvas.toDataURL('image/png');
      }
    } else {
      // No real camera frame available (permission denied / preview sandbox) —
      // this placeholder has no actual face in it, so the real scan below will
      // correctly report "no face detected" rather than faking a pass.
      dataUrl = createFallbackSnapshot();
    }

    setCapturedSnapshot(dataUrl);
    setVerifyError(null);

    try {
      const res = await fetch('/api/face-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: dataUrl, approverRole: 'Account Director', discountPct, accountName })
      });
      const data = await res.json();

      if (data.verified) {
        setMatchedName(data.matchProfile?.name ?? null);
        setConfidenceScore(data.confidenceScore ?? null);
        setVerified(true);
      } else {
        setVerifyError(data.error || 'Biometric verification did not pass.');
        setVerified(false);
      }
    } catch (err) {
      console.error('Face verification request failed:', err);
      setVerifyError('Could not reach the verification service.');
      setVerified(false);
    } finally {
      setIsScanning(false);
    }
  };

  const createFallbackSnapshot = (): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      // Dark background
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, 400, 300);

      // Face outline silhouette
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(200, 130, 60, 0, Math.PI * 2);
      ctx.stroke();

      // Shoulder outline
      ctx.beginPath();
      ctx.arc(200, 270, 110, 0, Math.PI, true);
      ctx.stroke();

      // No real camera frame to work with — labeled as such, not as a pass.
      // The real scan below will correctly reject this (no actual face in it).
      ctx.fillStyle = '#f8fafc';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText('NO CAMERA FEED — PLACEHOLDER IMAGE', 60, 280);
    }
    return canvas.toDataURL('image/png');
  };

  const handleConfirmApproval = () => {
    if (capturedSnapshot) {
      onVerified(capturedSnapshot, matchedName ?? undefined);
      onClose();
    }
  };

  const handleRetry = () => {
    setVerifyError(null);
    setCapturedSnapshot(null);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4" {...backdropProps}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="face-verification-title"
        tabIndex={-1}
        className="bg-white border border-slate-200 rounded-xl max-w-lg w-full p-6 shadow-xl relative text-slate-800 focus:outline-none"
      >

        {/* Close Button */}
        <button
          onClick={onClose}
          aria-label="Close verification dialog"
          className="absolute top-4 right-4 p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center space-x-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-slate-100 text-slate-800 border border-slate-200 flex items-center justify-center">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h3 id="face-verification-title" className="text-lg font-bold text-slate-900">Face Verification Security Check</h3>
            <p className="text-xs text-slate-500 font-medium">
              Required for retention discount &gt; 10% ({discountPct}% for {accountName})
            </p>
          </div>
        </div>

        {/* Policy Rule Alert Banner */}
        <div className="mb-4 bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700 flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 text-slate-600 shrink-0 mt-0.5" />
          <div>
            <span className="font-bold text-slate-900">Enterprise Security Rule:</span> Discount approvals exceeding 10% require facial biometric verification from an Account Director to prevent unauthorized rate cuts and ensure audit compliance.
          </div>
        </div>

        {/* Camera / Biometric Scan Frame */}
        <div className="relative bg-slate-900 border border-slate-800 rounded-lg overflow-hidden aspect-video flex items-center justify-center text-white">
          {/* Always mounted, only hidden. Rendering this conditionally on
              streamActive was a deadlock: the element didn't exist when
              startCamera ran, so videoRef was null, the stream was never
              attached, and streamActive never became true — leaving the
              placeholder up with the camera switched on but invisible. */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover transform -scale-x-100 ${
              streamActive && !capturedSnapshot ? '' : 'hidden'
            }`}
          />

          {capturedSnapshot ? (
            <img src={capturedSnapshot} alt="Biometric Snapshot" className="w-full h-full object-cover" />
          ) : !streamActive ? (
            <div className="text-center p-6 space-y-3">
              <div className="relative w-24 h-24 mx-auto border-2 border-dashed border-slate-600 rounded-full flex items-center justify-center">
                <UserCheck className="w-12 h-12 text-slate-400" />
                <div className="absolute inset-0 rounded-full border-t-2 border-slate-400 animate-spin" />
              </div>
              <p className="text-xs text-slate-300 font-mono">
                {cameraError ? 'Camera unavailable' : 'Starting camera…'}
              </p>
            </div>
          ) : null}

          {/* Canvas for snapshot capture */}
          <canvas ref={canvasRef} className="hidden" />

          {/* Scanning Overlay Grid */}
          {isScanning && (
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-[1px] flex flex-col items-center justify-center p-4">
              <div className="w-48 h-48 border-2 border-slate-400 rounded-2xl relative flex items-center justify-center">
                <div className="absolute top-2 left-2 w-4 h-4 border-t-2 border-l-2 border-slate-300" />
                <div className="absolute top-2 right-2 w-4 h-4 border-t-2 border-r-2 border-slate-300" />
                <div className="absolute bottom-2 left-2 w-4 h-4 border-b-2 border-l-2 border-slate-300" />
                <div className="absolute bottom-2 right-2 w-4 h-4 border-b-2 border-r-2 border-slate-300" />
                <div className="w-full h-0.5 bg-slate-200 animate-bounce" />
              </div>

              <div className="mt-4 w-48 bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700">
                <div
                  className="bg-slate-200 h-full transition-all duration-150"
                  style={{ width: `${scanProgress}%` }}
                />
              </div>
              <span className="text-[11px] font-mono text-slate-300 mt-2">
                Analyzing Facial Features... {scanProgress}%
              </span>
            </div>
          )}

          {/* Verified Success Overlay — real matched identity from face_app */}
          {verified && (
            <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-xs flex flex-col items-center justify-center text-center p-4">
              <CheckCircle2 className="w-16 h-16 text-emerald-400 mb-2" />
              <h4 className="text-lg font-bold text-white">Biometric Identity Verified</h4>
              <p className="text-xs text-slate-300 mt-1">
                Matched enrolled identity: <span className="font-semibold text-white">{matchedName}</span>
              </p>
              <div className="mt-2 text-[11px] font-mono bg-slate-800 text-slate-300 px-3 py-1 rounded-full border border-slate-700">
                Match Confidence: {confidenceScore}%
              </div>
            </div>
          )}

          {/* Verification Failed Overlay — a real rejection, not glossed over */}
          {verifyError && !verified && !isScanning && (
            <div className="absolute inset-0 bg-slate-900/90 backdrop-blur-xs flex flex-col items-center justify-center text-center p-4">
              <XCircle className="w-16 h-16 text-red-400 mb-2" />
              <h4 className="text-lg font-bold text-white">Verification Failed</h4>
              <p className="text-xs text-slate-300 mt-1 max-w-xs">{verifyError}</p>
              <button
                type="button"
                onClick={handleRetry}
                className="mt-3 px-4 py-1.5 text-xs font-semibold text-slate-900 bg-white rounded-lg hover:bg-slate-100 transition"
              >
                Try Again
              </button>
            </div>
          )}
        </div>

        {cameraError && (
          <p className="text-[11px] text-slate-700 mt-2 bg-slate-100 p-2 rounded-lg border border-slate-200 font-medium">
            {cameraError}
          </p>
        )}

        {/* Action Controls */}
        <div className="mt-5 flex items-center justify-end space-x-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-800 bg-slate-100 rounded-lg hover:bg-slate-200 transition"
          >
            Cancel
          </button>

          {!verified ? (
            <button
              onClick={handleStartScan}
              disabled={isScanning}
              className="flex items-center space-x-2 px-5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition disabled:opacity-50"
            >
              <Camera className="w-4 h-4" />
              <span>{isScanning ? 'Scanning Face...' : 'Verify Biometrics & Approve'}</span>
            </button>
          ) : (
            <button
              onClick={handleConfirmApproval}
              className="flex items-center space-x-2 px-5 py-2 text-xs font-semibold text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Sign Audit Log & Apply {discountPct}% Discount</span>
            </button>
          )}
        </div>

      </div>
    </div>
  );
};
