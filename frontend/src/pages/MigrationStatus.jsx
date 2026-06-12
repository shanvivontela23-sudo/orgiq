import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  CheckCircle, Loader2, Circle, XCircle, X,
  Download, AlertTriangle, ShieldCheck, Info,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const DATA_LOAD_PHASES = [
  'Target org selected',
  'File accepted',
  'Pre-flight validation',
  'Field validation & upload',
  'Bulk load complete',
];

const MIGRATION_PHASES = [
  'Pre-flight validation',
  'Mapping file parse',
  'Schema analysis',
  'Users & queues',
  'Accounts & hierarchy',
  'Contacts',
  'Opportunities & products',
  'Cases & service data',
  'Custom objects',
  'Files & attachments',
];

// ── Phase row ─────────────────────────────────────────────────────────────────
function PhaseRow({ index, phase, currentPhase, jobStatus, phaseNames }) {
  const isCompleted = phase?.status === 'completed' || index < currentPhase;
  const isRunning   = index === currentPhase && ['running', 'pending'].includes(jobStatus);
  const isFailed    = phase?.status === 'failed';

  return (
    <div className={`flex items-center gap-4 py-3 px-4 rounded-lg ${
      isRunning ? 'bg-[#6366f1]/10 border border-[#6366f1]/20' : ''
    }`}>
      <div className="w-5 shrink-0">
        {isFailed    ? <XCircle    size={18} className="text-red-400" /> :
         isCompleted ? <CheckCircle size={18} className="text-green-400" /> :
         isRunning   ? <Loader2    size={18} className="text-[#6366f1] animate-spin" /> :
                       <Circle     size={18} className="text-white/15" />}
      </div>
      <span className={`text-sm flex-1 ${
        isRunning ? 'text-white font-medium' : isCompleted ? 'text-white/60' : 'text-white/25'
      }`}>
        {phase?.phase_name || phaseNames[index]}
      </span>
      {(phase?.records_succeeded > 0) && (
        <span className="text-xs text-white/30">{phase.records_succeeded.toLocaleString()} records</span>
      )}
    </div>
  );
}

// ── Preflight panel ───────────────────────────────────────────────────────────
function PreflightPanel({ preflight }) {
  if (!preflight) return null;
  const hasErrors   = preflight.errors?.length > 0;
  const hasWarnings = preflight.warnings?.length > 0;
  const hasInfo     = preflight.info?.length > 0;

  return (
    <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-white/6 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-white/50">Pre-flight Check</span>
        <span className={`text-xs font-semibold flex items-center gap-1 ${preflight.passed ? 'text-green-400' : 'text-red-400'}`}>
          {preflight.passed ? <><ShieldCheck size={12} /> Passed</> : <><XCircle size={12} /> Failed</>}
        </span>
      </div>
      <div className="divide-y divide-white/5">
        {hasErrors && preflight.errors.map((e, i) => (
          <div key={i} className="px-5 py-3 bg-red-500/5 border-l-2 border-red-500">
            <p className="text-sm text-red-300 font-medium">{e.message}</p>
            {e.action && <p className="text-xs text-red-300/55 mt-1">{e.action}</p>}
          </div>
        ))}
        {hasWarnings && preflight.warnings.map((w, i) => (
          <div key={i} className="px-5 py-3 bg-yellow-500/5 border-l-2 border-yellow-500/50">
            <p className="text-sm text-yellow-200/80">{w.message}</p>
            {w.action && <p className="text-xs text-yellow-200/40 mt-1">{w.action}</p>}
          </div>
        ))}
        {hasInfo && preflight.info.map((item, i) => (
          <div key={i} className="px-5 py-2 flex items-start gap-2">
            <Info size={11} className="text-white/20 mt-0.5 shrink-0" />
            <p className="text-xs text-white/35">{item.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Row errors panel ──────────────────────────────────────────────────────────
function RowErrorsPanel({ errors, jobId, failedCount }) {
  if (!errors?.length && !failedCount) return null;
  return (
    <div className="bg-[#27272a]/20 border border-red-500/20 rounded-2xl overflow-hidden">
      <div className="px-5 py-3 border-b border-white/6 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-red-400 flex items-center gap-2">
          <AlertTriangle size={12} /> Row Errors ({failedCount?.toLocaleString() || errors.length})
        </span>
        <a
          href={`${API}/api/migrations/${jobId}/failed-results`}
          download={`failed_rows_${jobId}.csv`}
          className="inline-flex items-center gap-1.5 text-xs text-[#6366f1] hover:underline font-medium"
        >
          <Download size={12} /> Download CSV
        </a>
      </div>
      <div className="divide-y divide-white/5 max-h-64 overflow-y-auto">
        {errors.slice(0, 20).map((e, i) => (
          <div key={i} className="px-5 py-2.5">
            {e.sf_id && <span className="text-xs font-mono text-white/25 mr-2">{e.sf_id}</span>}
            <span className="text-xs text-red-300/70">{e.error}</span>
          </div>
        ))}
        {errors.length > 20 && (
          <div className="px-5 py-2.5 text-xs text-white/30">
            …and {errors.length - 20} more — download the CSV for the full list
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function MigrationStatus() {
  const { id } = useParams();
  const [user, setUser]           = useState(null);
  const [job, setJob]             = useState(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user || null));
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API}/api/migrations/${id}`);
      setJob(data);
    } catch (err) {
      console.error('Status fetch error:', err);
    }
  }, [id]);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(() => {
      setJob(prev => {
        if (!prev || ['completed', 'failed', 'cancelled'].includes(prev.status)) {
          clearInterval(interval);
          return prev;
        }
        fetchStatus();
        return prev;
      });
    }, 4000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const handleCancel = async () => {
    if (!confirm('Cancel this job?')) return;
    setCancelling(true);
    try { await axios.delete(`${API}/api/migrations/${id}`); fetchStatus(); }
    catch (err) { console.error('Cancel error:', err); }
    finally { setCancelling(false); }
  };

  const isDataLoad  = job?.jobType === 'data_load';
  const phaseNames  = isDataLoad ? DATA_LOAD_PHASES : MIGRATION_PHASES;
  const currentPhase = job?.currentPhase ?? 0;
  const totalPhases  = job?.totalPhases || phaseNames.length;
  const progress     = Math.min(100, Math.round((currentPhase / totalPhases) * 100));
  const isRunning    = !job || ['running', 'pending'].includes(job?.status);
  const isCompleted  = job?.status === 'completed';
  const isFailed     = job?.status === 'failed';

  const phaseMap = {};
  (job?.phases || []).forEach(p => { phaseMap[p.phase_number] = p; });

  const es          = job?.errorSummary || {};
  const preflight   = es.preflight || null;
  const rowErrors   = es.errors || [];
  const failedCount = job?.recordCounts?.failed || es.failedCount || 0;
  const sfJobState  = es.sfJobState;
  const sfError     = es.sfErrorMessage;

  // Operation label for header
  const opLabel = job?.mappingConfig?.operation
    ? job.mappingConfig.operation.charAt(0).toUpperCase() + job.mappingConfig.operation.slice(1)
    : 'Load';
  const objectLabel = job?.mappingConfig?.objectApiName || 'records';

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <Link to="/dashboard" className="text-white/40 hover:text-white text-xs mb-2 inline-block transition">← Dashboard</Link>
            <h1 className="text-2xl font-bold">
              {isDataLoad ? `${opLabel} → ${objectLabel}` : 'Migration Status'}
            </h1>
            <p className="text-white/30 text-xs mt-1 font-mono">{id}</p>
            {sfJobState && (
              <p className="text-xs mt-1 text-white/40">
                SF Bulk job: <span className={sfJobState === 'JobComplete' ? 'text-green-400' : sfJobState === 'Failed' ? 'text-red-400' : 'text-yellow-400'}>{sfJobState}</span>
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isCompleted && (
              <Link to={`/migrations/${id}/report`}
                className="bg-green-500/15 hover:bg-green-500/25 text-green-400 font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                View Report →
              </Link>
            )}
            {isCompleted && isDataLoad && (
              <div className="flex gap-2 flex-wrap">
                {/* Success file — always show if records succeeded */}
                {job?.recordCounts?.succeeded > 0 && (
                  <a
                    href={`${API}/api/migrations/${id}/success-results`}
                    download={`success_${job?.mappingConfig?.objectApiName || 'records'}_${id}.csv`}
                    className="inline-flex items-center gap-2 bg-green-500/10 hover:bg-green-500/20 border border-green-500/25 text-green-300 font-medium px-4 py-2.5 rounded-xl text-sm transition"
                    title="CSV of all successfully inserted/updated records with their new Salesforce IDs"
                  >
                    <Download size={14} /> Success CSV ({job.recordCounts.succeeded.toLocaleString()} rows)
                  </a>
                )}
                {/* Failure files — show if any rows failed */}
                {failedCount > 0 && (
                  <>
                    <a href={`${API}/api/migrations/${id}/failed-results`}
                      download={`failed_${job?.mappingConfig?.objectApiName || 'records'}_${id}.csv`}
                      className="inline-flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-300 font-medium px-4 py-2.5 rounded-xl text-sm transition"
                      title="CSV of failed rows with Salesforce error messages">
                      <Download size={14} /> Failed rows CSV ({failedCount.toLocaleString()} rows)
                    </a>
                    <a href={`${API}/api/migrations/${id}/retry-failed`}
                      download={`retry_${job?.mappingConfig?.objectApiName || 'records'}_${id}.csv`}
                      className="inline-flex items-center gap-2 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/20 text-orange-300 font-medium px-4 py-2.5 rounded-xl text-sm transition"
                      title="Clean CSV of failed rows only — fix errors and re-upload">
                      <Download size={14} /> Retry-only CSV
                    </a>
                  </>
                )}
              </div>
            )}
            {isRunning && (
              <button onClick={handleCancel} disabled={cancelling}
                className="flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 font-medium px-4 py-2.5 rounded-xl text-sm transition disabled:opacity-50">
                <X size={14} /> {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left — phases */}
          <div className="lg:col-span-2 space-y-4">

            {/* Progress bar */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">
                  {isFailed ? '❌ Failed' : isCompleted ? '✅ Completed' : `Phase ${currentPhase + 1} of ${totalPhases}`}
                </span>
                <span className={`font-bold text-sm ${isFailed ? 'text-red-400' : isCompleted ? 'text-green-400' : 'text-[#6366f1]'}`}>
                  {isFailed ? 'Error' : isCompleted ? 'Done' : `${progress}%`}
                </span>
              </div>
              <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    isFailed ? 'bg-red-400' : isCompleted ? 'bg-green-500' : 'bg-[#6366f1]'
                  }`}
                  style={{ width: `${isFailed ? 100 : progress}%` }}
                />
              </div>
              {job?.phaseName && <p className="text-xs text-white/40 mt-2">{job.phaseName}</p>}
              {sfError && <p className="text-xs text-red-300/70 mt-2">SF error: {sfError}</p>}
            </div>

            {/* Phase list */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-4">
              {phaseNames.map((_, i) => (
                <PhaseRow key={i} index={i} phase={phaseMap[i]}
                  currentPhase={currentPhase} jobStatus={job?.status} phaseNames={phaseNames} />
              ))}
            </div>

            {/* Preflight results */}
            {preflight && <PreflightPanel preflight={preflight} />}

            {/* Row-level errors */}
            {(rowErrors.length > 0 || failedCount > 0) && (
              <RowErrorsPanel errors={rowErrors} jobId={id} failedCount={failedCount} />
            )}
          </div>

          {/* Right — stats */}
          <div className="space-y-4">
            {/* Record counts */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-5 space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Record Counts</h3>
              {[
                { label: 'Total',     val: job?.recordCounts?.total,     color: 'text-white' },
                { label: 'Succeeded', val: job?.recordCounts?.succeeded, color: 'text-green-400' },
                { label: 'Failed',    val: job?.recordCounts?.failed,    color: 'text-red-400' },
              ].map(({ label, val, color }) => (
                <div key={label} className="flex justify-between items-center">
                  <span className="text-xs text-white/50">{label}</span>
                  <span className={`text-lg font-bold ${color}`}>{val?.toLocaleString() ?? '—'}</span>
                </div>
              ))}
            </div>

            {/* Job details */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-5 space-y-3 text-xs">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Job Details</h3>
              {[
                { label: 'Type',      val: isDataLoad ? 'CSV Data Load' : 'Org Migration' },
                { label: 'Object',    val: job?.mappingConfig?.objectApiName },
                { label: 'Operation', val: job?.mappingConfig?.operation },
                { label: 'Dry Run',   val: job?.isDryRun ? 'Yes' : 'No' },
                { label: 'File',      val: job?.mappingConfig?.dataFile?.name },
                { label: 'Started',   val: job?.startedAt ? new Date(job.startedAt).toLocaleString() : null },
                { label: 'Completed', val: job?.completedAt ? new Date(job.completedAt).toLocaleString() : null },
              ].filter(r => r.val).map(({ label, val }) => (
                <div key={label} className="flex justify-between gap-2">
                  <span className="text-white/40 shrink-0">{label}</span>
                  <span className="text-white/70 text-right break-all">{val}</span>
                </div>
              ))}
            </div>

            {/* Download files — sidebar shortcuts */}
            {isCompleted && isDataLoad && (
              <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-4 space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-white/40 mb-3">Download Results</p>
                {job?.recordCounts?.succeeded > 0 && (
                  <a href={`${API}/api/migrations/${id}/success-results`}
                    download={`success_${job?.mappingConfig?.objectApiName || 'records'}_${id}.csv`}
                    className="flex items-center justify-between gap-2 bg-green-500/8 hover:bg-green-500/15 border border-green-500/20 text-green-300 px-3 py-2.5 rounded-xl text-xs font-medium transition w-full">
                    <span className="flex items-center gap-2"><Download size={12} /> Success CSV</span>
                    <span className="text-green-400/60">{job.recordCounts.succeeded.toLocaleString()} rows</span>
                  </a>
                )}
                {failedCount > 0 && (
                  <>
                    <a href={`${API}/api/migrations/${id}/failed-results`}
                      download={`failed_${id}.csv`}
                      className="flex items-center justify-between gap-2 bg-red-500/8 hover:bg-red-500/15 border border-red-500/20 text-red-300 px-3 py-2.5 rounded-xl text-xs font-medium transition w-full">
                      <span className="flex items-center gap-2"><Download size={12} /> Failed rows CSV</span>
                      <span className="text-red-400/60">{failedCount.toLocaleString()} rows</span>
                    </a>
                    <a href={`${API}/api/migrations/${id}/retry-failed`}
                      download={`retry_${id}.csv`}
                      className="flex items-center gap-2 bg-orange-500/8 hover:bg-orange-500/15 border border-orange-500/20 text-orange-300 px-3 py-2.5 rounded-xl text-xs font-medium transition w-full">
                      <Download size={12} /> Retry-only CSV (clean)
                    </a>
                  </>
                )}
                {job?.recordCounts?.succeeded === 0 && failedCount === 0 && (
                  <p className="text-xs text-white/30">No results — dry run or preflight blocked</p>
                )}
              </div>
            )}

            {/* Preflight quick summary (sidebar) */}
            {preflight && (
              <div className={`rounded-2xl border p-4 text-xs ${
                preflight.passed ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'
              }`}>
                <p className={`font-semibold mb-1 ${preflight.passed ? 'text-green-400' : 'text-red-400'}`}>
                  {preflight.passed ? '✓ Pre-flight passed' : '✗ Pre-flight failed'}
                </p>
                <p className="text-white/40">
                  {preflight.errors?.length || 0} error(s) · {preflight.warnings?.length || 0} warning(s)
                </p>
                {preflight.orgType && (
                  <p className="text-white/30 mt-1">Org type: {preflight.orgType}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
