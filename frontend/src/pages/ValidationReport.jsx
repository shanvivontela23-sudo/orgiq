import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Download, CheckCircle, Loader2 } from 'lucide-react';
import axios from 'axios';
import Sidebar from '../components/Sidebar';
import { supabase } from '../lib/supabase';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

function StatCard({ label, value, sub, color = 'text-white' }) {
  return (
    <div className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl p-5">
      <p className="text-xs text-white/40 mb-2">{label}</p>
      <p className={`text-3xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-white/30 mt-1">{sub}</p>}
    </div>
  );
}

export default function ValidationReport() {
  const { id } = useParams();
  const [user, setUser] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    axios.get(`${API}/api/migrations/${id}/report`)
      .then(({ data }) => {
        const counts = data.record_counts || { total: 0, succeeded: 0, failed: 0 };
        const total = counts.total || 0;
        const succeeded = counts.succeeded || 0;
        setReport({
          summary: {
            total,
            succeeded,
            failed: counts.failed || 0,
            successRate: total > 0 ? Number(((succeeded / total) * 100).toFixed(1)) : 0,
            duration: data.completed_at ? 'Completed' : 'In progress',
            apiCalls: 0,
          },
          byObject: data.by_object || [],
          errors: data.error_summary?.errors || [],
          piiMasked: data.pii_masked || [],
          pdfUrl: data.pdf_url,
          csvUrl: data.csv_url,
        });
      })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <div className="flex min-h-screen bg-[#0f1e30] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8">
        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <Link to={`/migrations/${id}`} className="text-white/40 hover:text-white text-xs mb-2 inline-block transition">← Migration Status</Link>
            <h1 className="text-2xl font-bold">Validation Report</h1>
            <p className="text-white/40 text-xs mt-1 font-mono">{id}</p>
          </div>
          <div className="flex gap-3">
            {report.pdfUrl && (
              <a
                href={report.pdfUrl}
                className="flex items-center gap-2 bg-[#2E86AB]/15 hover:bg-[#2E86AB]/25 text-[#2E86AB] font-medium px-4 py-2.5 rounded-xl text-sm transition"
              >
                <Download size={14} /> Download PDF
              </a>
            )}
            {report.csvUrl && (
              <a
                href={report.csvUrl}
                className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-white/70 font-medium px-4 py-2.5 rounded-xl text-sm transition"
              >
                <Download size={14} /> Download CSV
              </a>
            )}
            {/* Show stub download buttons even without real URLs */}
            {!report.pdfUrl && (
              <button className="flex items-center gap-2 bg-[#2E86AB]/15 hover:bg-[#2E86AB]/25 text-[#2E86AB] font-medium px-4 py-2.5 rounded-xl text-sm transition">
                <Download size={14} /> Download PDF
              </button>
            )}
            {!report.csvUrl && (
              <button className="flex items-center gap-2 bg-white/5 hover:bg-white/10 text-white/70 font-medium px-4 py-2.5 rounded-xl text-sm transition">
                <Download size={14} /> Download CSV
              </button>
            )}
          </div>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20 text-white/30">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading report...
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {report && (
          <>
        {/* Summary cards */}
        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 mb-8">
          <StatCard label="Total Records" value={report.summary.total.toLocaleString()} />
          <StatCard label="Succeeded" value={report.summary.succeeded.toLocaleString()} color="text-green-400" />
          <StatCard label="Failed" value={report.summary.failed.toLocaleString()} color={report.summary.failed > 0 ? 'text-red-400' : 'text-white'} />
          <StatCard label="Success Rate" value={`${report.summary.successRate}%`} color={report.summary.successRate >= 99 ? 'text-green-400' : report.summary.successRate >= 95 ? 'text-yellow-400' : 'text-red-400'} />
          <StatCard label="Duration" value={report.summary.duration} />
          <StatCard label="API Calls" value={report.summary.apiCalls.toLocaleString()} />
        </div>

        <div className="grid lg:grid-cols-2 gap-6 mb-6">
          {/* Per-object breakdown */}
          <div className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-white/8">
              <h2 className="font-semibold text-sm">Per-Object Breakdown</h2>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-white/40 uppercase tracking-wider border-b border-white/8">
                  <th className="text-left px-6 py-3 font-medium">Object</th>
                  <th className="text-right px-4 py-3 font-medium">Total</th>
                  <th className="text-right px-4 py-3 font-medium">Failed</th>
                  <th className="text-right px-4 py-3 font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {report.byObject.length === 0 ? (
                  <tr>
                    <td colSpan="4" className="px-6 py-6 text-white/30 text-center">No per-object breakdown saved for this run.</td>
                  </tr>
                ) : report.byObject.map((row) => (
                  <tr key={row.object} className="border-b border-white/5 hover:bg-white/3 transition">
                    <td className="px-6 py-3 font-medium">{row.object}</td>
                    <td className="px-4 py-3 text-right text-white/60">{row.total.toLocaleString()}</td>
                    <td className={`px-4 py-3 text-right ${row.failed > 0 ? 'text-red-400' : 'text-white/30'}`}>
                      {row.failed.toLocaleString()}
                    </td>
                    <td className={`px-4 py-3 text-right font-semibold ${
                      row.rate >= 99 ? 'text-green-400' : row.rate >= 95 ? 'text-yellow-400' : 'text-red-400'
                    }`}>
                      {row.rate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* PII masking summary */}
          {report.piiMasked?.length > 0 && (
            <div className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl overflow-hidden">
              <div className="px-6 py-4 border-b border-white/8">
                <h2 className="font-semibold text-sm">PII Masking Summary</h2>
              </div>
              <div className="p-4 space-y-2">
                {report.piiMasked.map((row) => (
                  <div key={`${row.object}-${row.field}`} className="flex justify-between items-center px-2 py-2.5 rounded-lg hover:bg-white/3 transition">
                    <span className="text-sm text-white/70">{row.object} → <span className="font-mono text-xs text-[#2E86AB]">{row.field}</span></span>
                    <span className="text-xs text-white/40">{row.count.toLocaleString()} records masked</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Error detail table */}
        <div className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/8 flex items-center justify-between">
            <h2 className="font-semibold text-sm">Error Detail</h2>
            <span className="text-xs text-red-400 bg-red-500/10 px-2.5 py-1 rounded-full">
              {report.errors.length} errors shown
            </span>
          </div>
          {report.errors.length === 0 ? (
            <div className="flex items-center gap-2 px-6 py-6 text-green-400 text-sm">
              <CheckCircle size={16} />
              No errors — clean migration!
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-white/40 uppercase tracking-wider border-b border-white/8">
                  <th className="text-left px-6 py-3 font-medium">Salesforce ID</th>
                  <th className="text-left px-4 py-3 font-medium">Object</th>
                  <th className="text-left px-4 py-3 font-medium">Error Code</th>
                  <th className="text-left px-4 py-3 font-medium">Recommended Action</th>
                </tr>
              </thead>
              <tbody>
                {report.errors.map((err, i) => (
                  <tr key={i} className="border-b border-white/5 hover:bg-white/3 transition">
                    <td className="px-6 py-3 font-mono text-xs text-white/50">{err.sfId}</td>
                    <td className="px-4 py-3 text-white/70">{err.object}</td>
                    <td className="px-4 py-3 text-red-400 text-xs font-mono">{err.code}</td>
                    <td className="px-4 py-3 text-white/50 text-xs">{err.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
          </>
        )}
      </main>
    </div>
  );
}
