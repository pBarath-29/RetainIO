import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import { useToast } from './Toast';

interface CheckInboxButtonProps {
  // Reload after the check pulls in a review or a notice, so the new text and the re-scored risk
  // appear without the page having to be refreshed by hand.
  onChecked?: () => void;
}

/**
 * Pulls any waiting feedback and renewal notice emails in now, rather than waiting out the
 * two-minute poll. Shared by the Account Manager and Account Director dashboards. The server does
 * the matching and re-scoring; this only reports what happened.
 */
export const CheckInboxButton: React.FC<CheckInboxButtonProps> = ({ onChecked }) => {
  const [isChecking, setIsChecking] = useState(false);
  const { showToast } = useToast();

  const handleCheck = async () => {
    if (isChecking) return;
    setIsChecking(true);
    try {
      const res = await fetch('/api/inbox/check', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { showToast(data.error || 'Could not check the mailbox.', 'error'); return; }

      // Unmatched emails are reported as loudly as ingested ones. An email naming an account
      // that does not exist produces no review and no visible change, so silence here would
      // read as "nothing had arrived" rather than "something arrived and was rejected".
      const parts: string[] = [];
      if (data.ingested) parts.push(`${data.ingested} review${data.ingested === 1 ? '' : 's'} ingested`);
      if (data.notices) parts.push(`${data.notices} renewal notice${data.notices === 1 ? '' : 's'} recorded`);
      if (data.unmatched) parts.push(`${data.unmatched} could not be matched to an account`);
      if (data.failed) parts.push(`${data.failed} failed`);
      showToast(
        parts.length ? parts.join(', ') + '.' : 'No new emails.',
        data.unmatched || data.failed ? 'info' : data.ingested || data.notices ? 'success' : 'info',
      );
      if (data.ingested || data.notices) onChecked?.();
    } catch {
      showToast('Could not reach the server to check the mailbox.', 'error');
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <button
      onClick={handleCheck}
      disabled={isChecking}
      title="Pull in any customer feedback and renewal notice emails waiting in the inbox now"
      className="flex items-center space-x-2 px-3.5 py-2 rounded-lg text-xs font-bold bg-slate-800 text-slate-200 border border-slate-700 hover:bg-slate-700 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
    >
      <Mail className={`w-3.5 h-3.5 ${isChecking ? 'animate-pulse' : ''}`} />
      <span>{isChecking ? 'Checking inbox...' : 'Check inbox now'}</span>
    </button>
  );
};
