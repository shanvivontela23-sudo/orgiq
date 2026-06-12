import { useCallback, useEffect, useState } from 'react';
import { Clock, CheckCircle, XCircle, Loader2, RefreshCw, Download, ChevronDown, ChevronUp, Database, Zap, FileText } from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const STATUS_STYLES = {
  completed: 'text-green-400 bg-green-500/10 border-green-500/20',
  failed:    'text-red-400 bg-red-500/10 border-red-500/20',
  running:   'text-blue-400 bg-blue-500/10 border-blue-500/20',
  pending:   'text-white/40 bg-white/5 border-white/10',
  cancelled: 'text-white/30 bg-white/5 border-white/10',
};

function StatusBadge({ status }) {
  const style = STATUS_STYLES[status] || STATUS_STYLES.pending;
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium border ${style}`}>
      {status}
    </span>
  );
}

function JobRow({ job, type }) {
  const [expanded, setExpanded] = useState(false);

  const cfg = job.mapping_config || {};
  const title = cfg.label
    ? cfg.label
    : type === 'data_load'
    ? `${(cfg.operation || job.operation || 'LOAD').toUpperCase()} → ${cfg.objectApiName || job.objectApiName || job.object_api_name || '—'}`
    : type === 'deployment'
    ? `${cfg.metadata_type || job.metadata_type || 'Deploy'} — ${cfg.component_name || job.component_name || job.requested_action || '—'}`
    : `Migration: ${job.phase_name || job.status}`;

  const counts = job.record_counts || {};
  const succeeded = counts.succeeded ?? job.succeeded_rows ?? null;
  const failed    = counts.failed    ?? job.failed_rows    ?? null;
  const total     = counts.total     ?? job.total_rows     ?? null;

  const icon = type === 'data_load'    ? <Database size={14} className="text-purple-400" />
             : type === 'deployment'   ? <Zap size={14} className="text-blue-400" />
             :                          <FileText size={14} className="text-indigo-400" />;

  return (
    <div className="border border-white/8 rounded-xl overflow-hidden">
      <div
        className="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-white/[0.02] transition"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white truncate">{title}</span>
            <StatusBadge status={job.status} />
          </div>
          <div className="flex items-center gap-3 mt-1 text-xs text-white/35 flex-wrap">
            <span className="flex items-center gap-1"><Clock size={10} /> {new Date(job.created_at || job.started_at).toLocaleString()}</span>
            {total !== null && <span>Total: {total?.toLocaleString()}</span>}
            {succeeded !== null && <span className="text-green-400/70">✓ {succeeded?.toLocaleString()}</span>}
            {failed !== null && failed > 0 && <span className="text-red-400/70">✗ {failed?.toLocaleString()}</span>}
          </div>
        </div>
        <div className="shrink-0 text-white/25">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/6 px-5 py-4 bg-black/10 space-y-3 text-xs text-white/50">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1">
            <div><span className="text-white/30">Job ID</span><br /><span className="font-mono text-white/60 break-all">{job.id}</span></div>
            {job.instance_url && <div><span className="text-white/30">Org</span><br />{job.instance_url}</div>}
            {job.phase_name   && <div><span className="text-white/30">Phase</span><br />{job.phase_name}</div>}
            {job.operation    && <div><span className="text-white/30">Operation</span><br />{job.operation}</div>}
            {job.completed_at && <div><span className="text-white/30">Completed</span><br />{new Date(job.completed_at).toLocaleString()}</div>}
            {job.dry_run_passed !== undefined && (
              <div><span className="text-white/30">Dry run</span><br />{job.dry_run_passed ? '✓ passed' : '✗ not passed'}</div>
            )}
          </div>

          {/* Preflight / error summary */}
          {job.error_summary?.preflight?.warnings?.length > 0 && (
            <div>
              <p className="text-white/30 mb-1 font-medium">Preflight warnings</p>
              {job.error_summary.preflight.warnings.slice(0, 3).map((w, i) => (
                <p key={i} className="text-yellow-300/60">• {w.message}</p>
              ))}
            </div>
          )}
          {job.error_summary?.errors?.length > 0 && (
            <div>
              <p className="text-white/30 mb-1 font-medium">Row errors (first 3)</p>
              {job.error_summary.errors.slice(0, 3).map((e, i) => (
                <p key={i} className="text-red-300/60">• {e.error}</p>
              ))}
            </div>
          )}

          {/* Download failed results */}
          {type === 'data_load' && failed > 0 && (
            <a
              href={`${API}/api/migrations/${job.id}/failed-results`}
              download={`failed_rows_${job.id}.csv`}
              className="inline-flex items-center gap-1.5 text-xs text-[#6366f1] hover:underline"
              onClick={e => e.stopPropagation()}
            >
              <Download size={12} /> Download failed rows CSV
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export default function History() {
  const [user, setUser]           = useState(null);
  const [jobs, setJobs]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [filter, setFilter]       = useState('all');   // all | data_load | migration | deployment
  const [statusFilter, setStatus] = useState('all');

  const loadHistory = useCallback(async (userId) => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/api/migrations`, { params: { userId } });
      setJobs(data.jobs || []);
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      setUser(u);
      if (u) loadHistory(u.id);
    });
  }, [loadHistory]);

  function jobType(job) {
    const jt = job.mapping_config?.jobType;
    if (jt === 'data_load') return 'data_load';
    if (jt === 'org_migration') return 'migration';
    if (jt === 'object_create' || jt === 'object_profile_access' || jt === 'deployment') return 'deployment';
    return 'data_load'; // fallback
  }

  const filtered = jobs.filter(j => {
    const t = jobType(j);
    const typeOk   = filter === 'all' || t === filter;
    const statusOk = statusFilter === 'all' || j.status === statusFilter;
    return typeOk && statusOk;
  });

  const counts = {
    total:     jobs.length,
    completed: jobs.filter(j => j.status === 'completed').length,
    failed:    jobs.filter(j => j.status === 'failed').length,
    running:   jobs.filter(j => j.status === 'running').length,
  };

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />

      <main className="flex-1 px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Audit History</h1>
            <p className="text-white/40 text-sm mt-1">All data loads, deployments, and migration jobs</p>
          </div>
          <button
            onClick={() => user && loadHistory(user.id)}
            className="flex items-center gap-2 text-white/40 hover:text-white text-sm transition"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>

        {/* Summary stats */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[
            { label: 'Total runs', value: counts.total, color: 'text-white' },
            { label: 'Completed',  value: counts.completed, color: 'text-green-400' },
            { label: 'Failed',     value: counts.failed,    color: 'text-red-400' },
            { label: 'Running',    value: counts.running,   color: 'text-blue-400' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-[#27272a]/20 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-xs text-white/40">{label}</p>
              <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <div className="flex gap-1 bg-white/5 rounded-xl p-1">
            {['all', 'data_load', 'migration', 'deployment'].map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  filter === f ? 'bg-[#6366f1] text-white' : 'text-white/40 hover:text-white'
                }`}
              >
                {f === 'all' ? 'All' : f === 'data_load' ? 'Data Load' : f === 'migration' ? 'Migration' : 'Deployment'}
              </button>
            ))}
          </div>
          <div className="flex gap-1 bg-white/5 rounded-xl p-1">
            {['all', 'completed', 'failed', 'running'].map(s => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition capitalize ${
                  statusFilter === s ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white'
                }`}
              >
                {s === 'all' ? 'All statuses' : s}
              </button>
            ))}
          </div>
        </div>

        {/* Job list */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-white/30">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading history…
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-white/30 border border-dashed border-white/10 rounded-2xl">
            <Clock size={32} className="mx-auto mb-4 opacity-30" />
            <p>No jobs match the current filters.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map(job => (
              <JobRow key={job.id} job={job} type={jobType(job)} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
