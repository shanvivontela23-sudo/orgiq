import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { CheckCircle, Loader2, Circle, XCircle, X } from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const PHASE_NAMES = [
  'Pre-flight validation',
  'Mapping file parse',
  'Schema analysis & dependency graph',
  'Users & queues',
  'Account & hierarchy',
  'Contact & person accounts',
  'Opportunities & products',
  'Cases & service data',
  'Custom objects',
  'Files & attachments',
];

function PhaseRow({ phase, index, currentPhase, jobStatus }) {
  const isCompleted = phase?.status === 'completed' || index < currentPhase;
  const isRunning   = index === currentPhase && (jobStatus === 'running' || jobStatus === 'pending');
  const isFailed    = phase?.status === 'failed';

  return (
    <div className={`flex items-center gap-4 py-3 px-4 rounded-lg transition ${
      isRunning ? 'bg-[#6366f1]/10 border border-[#6366f1]/20' : ''
    }`}>
      <div className="w-5 shrink-0">
        {isFailed    ? <XCircle   size={18} className="text-red-400" /> :
         isCompleted ? <CheckCircle size={18} className="text-green-400" /> :
         isRunning   ? <Loader2   size={18} className="text-[#6366f1] animate-spin" /> :
                       <Circle    size={18} className="text-white/15" />}
      </div>
      <span className={`text-sm flex-1 ${
        isRunning ? 'text-white font-medium' : isCompleted ? 'text-white/60' : 'text-white/25'
      }`}>
        {phase?.phase_name || PHASE_NAMES[index]}
      </span>
      {phase?.records_succeeded > 0 && (
        <span className="text-xs text-white/30">
          {phase.records_succeeded.toLocaleString()} records
        </span>
      )}
    </div>
  );
}

export default function MigrationStatus() {
  const { id } = useParams();
  const [user, setUser] = useState(null);
  const [job, setJob]   = useState(null);
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
    const timeout = setTimeout(fetchStatus, 0);
    const interval = setInterval(() => {
      if (job?.status !== 'completed' && job?.status !== 'failed' && job?.status !== 'cancelled') {
        fetchStatus();
      }
    }, 4000);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [fetchStatus, job?.status]);

  const handleCancel = async () => {
    if (!confirm('Cancel this migration?')) return;
    setCancelling(true);
    try {
      await axios.delete(`${API}/api/migrations/${id}`);
      fetchStatus();
    } catch (err) {
      console.error('Cancel error:', err);
    } finally {
      setCancelling(false);
    }
  };

  const currentPhase = job?.currentPhase ?? 0;
  const totalPhases  = 10;
  const progress     = Math.round((currentPhase / totalPhases) * 100);
  const isRunning    = !job || job?.status === 'running' || job?.status === 'pending';
  const isCompleted  = job?.status === 'completed';
  const isFailed     = job?.status === 'failed';

  // Build phases array — fill from API data, fall back to empty
  const phaseMap = {};
  (job?.phases || []).forEach(p => { phaseMap[p.phase_number] = p; });

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8">

        {/* Header */}
        <div className="flex items-start justify-between mb-8">
          <div>
            <Link to="/dashboard" className="text-white/40 hover:text-white text-xs mb-2 inline-block transition">← Dashboard</Link>
            <h1 className="text-2xl font-bold">Migration Status</h1>
            <p className="text-white/40 text-xs mt-1 font-mono truncate max-w-sm">{id}</p>
          </div>
          <div className="flex items-center gap-3">
            {isCompleted && (
              <Link to={`/migrations/${id}/report`} className="bg-green-500/15 hover:bg-green-500/25 text-green-400 font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                View Report →
              </Link>
            )}
            {isRunning && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex items-center gap-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 font-medium px-4 py-2.5 rounded-xl text-sm transition disabled:opacity-50"
              >
                <X size={14} />
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Left — progress */}
          <div className="lg:col-span-2 space-y-4">
            {/* Progress bar */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-6">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium">
                  {isFailed ? '❌ Failed' : isCompleted ? '✅ Completed' : `Phase ${currentPhase + 1} of ${totalPhases}`}
                </span>
                <span className={`font-bold text-sm ${isFailed ? 'text-red-400' : 'text-[#6366f1]'}`}>
                  {isFailed ? 'Error' : `${progress}%`}
                </span>
              </div>
              <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${isFailed ? 'bg-red-400' : 'bg-[#6366f1]'}`}
                  style={{ width: `${isFailed ? 100 : progress}%` }}
                />
              </div>
              {job?.phaseName && <p className="text-xs text-white/40 mt-2">{job.phaseName}</p>}
            </div>

            {/* Phase list */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-4">
              {PHASE_NAMES.map((_, i) => (
                <PhaseRow
                  key={i}
                  index={i}
                  phase={phaseMap[i]}
                  currentPhase={currentPhase}
                  jobStatus={job?.status}
                />
              ))}
            </div>
          </div>

          {/* Right — stats + errors */}
          <div className="space-y-4">
            <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl p-5 space-y-4">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-white/40">Record Counts</h3>
              {[
                { label: 'Total',     val: job?.recordCounts?.total,     cls: '' },
                { label: 'Succeeded', val: job?.recordCounts?.succeeded, cls: 'text-green-400' },
                { label: 'Failed',    val: job?.recordCounts?.failed,    cls: 'text-red-400' },
              ].map(({ label, val, cls }) => (
                <div key={label} className="flex justify-between">
                  <span className="text-xs text-white/50">{label}</span>
                  <span className={`text-sm font-bold ${cls || 'text-white'}`}>
                    {val?.toLocaleString() ?? '—'}
                  </span>
                </div>
              ))}
            </div>

            {/* Error summary */}
            {job?.errorSummary && (
              <div className="bg-red-500/5 border border-red-500/20 rounded-2xl p-5">
                <h3 className="text-xs font-semibold uppercase tracking-widest text-red-400 mb-3">Error Summary</h3>
                <pre className="text-xs text-white/50 whitespace-pre-wrap">
                  {JSON.stringify(job.errorSummary, null, 2)}
                </pre>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
