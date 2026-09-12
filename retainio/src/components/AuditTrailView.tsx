import React, { useState } from 'react';
import { Account, AuditLog, UserProfile } from '../types';
import { FileText, ShieldCheck, CheckCircle2, Search, Download, AlertCircle, XCircle } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

interface AuditTrailViewProps {
  auditLogs: AuditLog[];
  currentUser?: UserProfile;
  accounts?: Account[];
}

export const AuditTrailView: React.FC<AuditTrailViewProps> = ({ auditLogs, currentUser, accounts }) => {
  const [searchQuery, setSearchQuery] = useState('');

  // Role scoping happens on the server (GET /api/bootstrap's auditScope):
  // a manager is sent only their own entries plus Director decisions on their
  // accounts; a Director is sent everything. The previous filter here also
  // matched any log on an account the user manages, which showed one
  // manager's actions to another whenever an account changed hands — and
  // filtering in the browser can't protect data the API already sent anyway.
  const filteredLogs = auditLogs.filter(log => {
    const matchesSearch =
      log.accountName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.approver.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.details.toLowerCase().includes(searchQuery.toLowerCase());

    return matchesSearch;
  });

  const handleDownloadPdf = () => {
    const doc = new jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();

    // 1. Header Banner Bar (Navy / Slate-900)
    doc.setFillColor(15, 23, 42); // Slate 900
    doc.rect(0, 0, pageWidth, 24, 'F');

    // Header Logo & Title Text
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text("RETAIN.IO", 14, 15);

    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(203, 213, 225); // Slate 300
    doc.text("|   Governance & Compliance Audit Log", 45, 15);

    // Header Right Badge: Exported Date
    const dateStr = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text(`Exported: ${dateStr}`, pageWidth - 14, 15, { align: 'right' });

    // 2. Report Overview Box
    doc.setFillColor(248, 250, 252); // Slate 50
    doc.setDrawColor(226, 232, 240); // Slate 200
    doc.roundedRect(14, 30, pageWidth - 28, 22, 3, 3, 'FD');

    // Summary Statistics Metrics
    const biometricCount = filteredLogs.filter(l => l.verificationStatus.includes('Face Verified')).length;
    const directCount = filteredLogs.filter(l => l.verificationStatus.includes('Direct')).length;
    const rejectedCount = filteredLogs.filter(l => l.verificationStatus.includes('Rejected')).length;

    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text("AUDIT SUMMARY METRICS", 20, 38);

    doc.setFontSize(8.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(71, 85, 105);
    doc.text(
      `Total Logged Events: ${filteredLogs.length}   |   Direct Approvals: ${directCount}   |   Executive Overrides: ${biometricCount}   |   Rejections: ${rejectedCount}`,
      20,
      46
    );

    // 3. Prepare AutoTable Data
    const tableData = filteredLogs.map(log => [
      log.timestamp,
      log.accountName,
      // The reason, when one was asked for, belongs with the action it explains.
      log.reason ? `${log.action}\nReason: "${log.reason}"` : log.action,
      log.discountApplied > 0 ? `${log.discountApplied}%${log.withdrawn ? ' (withdrawn)' : ''}` : 'None',
      `${log.approver}\n(${log.approverRole})`,
      log.verificationStatus
    ]);

    autoTable(doc, {
      startY: 58,
      head: [['Timestamp', 'Company Account', 'Action Executed', 'Discount', 'Approver / Actor', 'Verification & Status']],
      body: tableData,
      headStyles: {
        fillColor: [15, 23, 42],
        textColor: [255, 255, 255],
        fontSize: 8,
        fontStyle: 'bold',
        cellPadding: 4
      },
      bodyStyles: {
        fontSize: 7.5,
        textColor: [51, 65, 85],
        cellPadding: 3.5,
        lineColor: [241, 245, 249],
        lineWidth: 0.1
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252]
      },
      styles: {
        overflow: 'linebreak',
        font: 'helvetica'
      },
      columnStyles: {
        0: { cellWidth: 28 },
        1: { cellWidth: 35 },
        2: { cellWidth: 42 },
        3: { cellWidth: 20, halign: 'center' },
        4: { cellWidth: 32 },
        5: { cellWidth: 25 }
      },
      didDrawPage: (data) => {
        const totalPages = (doc as any).internal.getNumberOfPages();
        const pageHeight = doc.internal.pageSize.getHeight();

        // Footer Divider Line
        doc.setDrawColor(226, 232, 240);
        doc.line(14, pageHeight - 14, pageWidth - 14, pageHeight - 14);

        // Footer Text
        doc.setFontSize(7.5);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(148, 163, 184);
        doc.text("RetainIO Confidential | Internal Governance Audit Trail", 14, pageHeight - 8);
        doc.text(`Page ${data.pageNumber} of ${totalPages}`, pageWidth - 14, pageHeight - 8, { align: 'right' });
      }
    });

    const fileName = `RetainIO_Audit_Report_${new Date().toISOString().slice(0, 10)}.pdf`;
    doc.save(fileName);
  };

  return (
    <div className="space-y-6">
      
      {/* Header Banner */}
      <div className="bg-slate-900 border border-slate-800 p-6 rounded-xl flex flex-col md:flex-row items-center justify-between gap-4 shadow-sm text-white">
        <div className="space-y-1">
          <div className="flex items-center space-x-2">
            <FileText className="w-5 h-5 text-slate-300" />
            <h2 className="text-lg font-bold tracking-tight">Audit Log</h2>
          </div>
          <p className="text-xs text-slate-400">
            Traceability ledger for retention discount approvals and Director request escalations.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={handleDownloadPdf}
            className="flex items-center space-x-2 px-3.5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition shadow-xs cursor-pointer border border-emerald-500 shrink-0"
          >
            <Download className="w-4 h-4 text-white" />
            <span>Download Audit Report (PDF)</span>
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 space-y-3 shadow-xs">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          
          <div className="relative w-full sm:w-80">
            <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search account name, approver, or action..."
              className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-4 py-2 text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-slate-400"
            />
          </div>

          <span className="text-xs text-slate-500 font-medium">
            Showing <strong>{filteredLogs.length}</strong> of <strong>{auditLogs.length}</strong> Audit Events
          </span>

        </div>

      </div>

      {/* Audit Log Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-700">
            <thead className="bg-slate-50 text-slate-500 font-mono uppercase text-[10px] border-b border-slate-200">
              <tr>
                <th className="py-3.5 px-4 font-semibold">Timestamp</th>
                <th className="py-3.5 px-4 font-semibold">Company Account</th>
                <th className="py-3.5 px-4 font-semibold">Action Executed</th>
                <th className="py-3.5 px-4 font-semibold">Discount</th>
                <th className="py-3.5 px-4 font-semibold">Approver / Actor</th>
                <th className="py-3.5 px-4 font-semibold">Verification & Status</th>
              </tr>
            </thead>

            <tbody className="divide-y divide-slate-200">
              {filteredLogs.map((log) => {
                const isBiometric = log.verificationStatus.includes('Face Verified');
                const isPending = log.verificationStatus.includes('Pending');
                const isRejected = log.verificationStatus.includes('Rejected');

                return (
                  <tr key={log.id} className="hover:bg-slate-50/80 transition">
                    <td className="py-3.5 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                      {log.timestamp}
                    </td>

                    <td className="py-3.5 px-4 font-bold text-slate-900 whitespace-nowrap">
                      {log.accountName}
                    </td>

                    <td className="py-3.5 px-4 text-slate-800 font-medium max-w-xs">
                      {log.action}
                      {log.reason && (
                        <span className="block mt-1 text-[11px] font-normal text-slate-500">Reason: “{log.reason}”</span>
                      )}
                    </td>

                    <td className="py-3.5 px-4 font-bold text-emerald-700 whitespace-nowrap">
                      {log.discountApplied > 0 ? (
                        <>
                          <span className={log.withdrawn ? 'line-through text-slate-400' : ''}>{log.discountApplied}%</span>
                          {log.withdrawn && <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">withdrawn</span>}
                        </>
                      ) : 'None'}
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span className="font-semibold text-slate-900 block">{log.approver}</span>
                      <span className="text-[10px] text-slate-500 block">{log.approverRole}</span>
                    </td>

                    <td className="py-3.5 px-4 whitespace-nowrap">
                      <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold inline-flex items-center space-x-1 ${
                        isBiometric
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                          : isPending
                          ? 'bg-amber-50 text-amber-700 border border-amber-200'
                          : isRejected
                          ? 'bg-red-50 text-red-700 border border-red-200'
                          : 'bg-slate-100 text-slate-800 border border-slate-300'
                      }`}>
                        {isBiometric ? (
                          <ShieldCheck className="w-3 h-3 inline mr-1" />
                        ) : isRejected ? (
                          <XCircle className="w-3 h-3 inline mr-1" />
                        ) : isPending ? (
                          <AlertCircle className="w-3 h-3 inline mr-1" />
                        ) : (
                          <CheckCircle2 className="w-3 h-3 inline mr-1" />
                        )}
                        <span>{log.verificationStatus}</span>
                      </span>
                    </td>
                  </tr>
                );
              })}

              {filteredLogs.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-slate-500 italic">
                    No audit records found matching your filter criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};
