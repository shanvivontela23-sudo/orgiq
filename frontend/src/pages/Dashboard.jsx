import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { Plus, ArrowRight, Loader2, CheckCircle } from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const STATUS_BADGE = {
  pending:   { label: 'Pending',    cls: 'bg-yellow-500/15 text-yellow-400' },
  running:   { label: 'Running',    cls: 'bg-[#2E86AB]/15 text-[#2E86AB]' },
  completed: { label: 'Completed',  cls: 'bg-green-500/15 text-green-400' },
  failed:    { label: 'Failed',     cls: 'bg-red-500/15 text-red-400' },
  cancelled: { label: 'Cancelled',  cls: 'bg-gray-500/15 text-gray-400' },
};

const CONNECT_ERROR_MESSAGES = {
  OAUTH_AUTHORIZATION_BLOCKED: 'Salesforce blocked this connected app. In the target org, allow or pre-authorize the OrgIQ connected app, then try again.',
  oauth_missing_params: 'Salesforce returned without the expected OAuth code. Please start the connection again.',
  token_exchange_failed: 'Salesforce authorized the app, but OrgIQ could not finish the token exchange.',
  oauth_failed: 'Salesforce did not authorize this org connection.',
};

function StatusBadge({ status }) {
  const cfg = STATUS_BADGE[status] || STATUS_BADGE.pending;
  return (
    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

export default function Dashboard() {
  const [user, setUser] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const loadData = useCallback(async (userId) => {
    setLoading(true);
    try {
      const { data: jobsResponse } = await axios.get(`${API}/api/migrations`, { params: { userId } });
      setJobs(jobsResponse.jobs || []);

      const { data: orgResponse } = await axios.get(`${API}/api/orgs`, { params: { userId } });
      setOrgs(orgResponse.orgs || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      setUser(u);
      if (u) loadData(u.id);
    });
  }, [loadData]);

  useEffect(() => {
    let clearToast;
    const showToast = (message) => {
      setToast(message);
      navigate('/dashboard', { replace: true });
      clearToast = setTimeout(() => setToast(null), 4000);
    };

    const timeout = setTimeout(() => {
      if (searchParams.get('connected') === 'true') {
        showToast('Salesforce org connected successfully!');
      } else if (searchParams.get('error')) {
        const detail = searchParams.get('detail');
        showToast(CONNECT_ERROR_MESSAGES[detail] || CONNECT_ERROR_MESSAGES[searchParams.get('error')] || 'Failed to connect org. Please try again.');
      }
    }, 0);

    return () => {
      clearTimeout(timeout);
      if (clearToast) clearTimeout(clearToast);
    };
  }, [navigate, searchParams]);

  const stats = [
    { label: 'Connected Orgs', value: orgs.length },
    { label: 'Total Jobs', value: jobs.length },
    { label: 'Completed', value: jobs.filter(j => j.status === 'completed').length },
    { label: 'Failed', value: jobs.filter(j => j.status === 'failed').length },
  ];

  return (
    <div className="flex min-h-screen bg-[#0f1e30] text-white">
      <Sidebar user={user} />

      <main className="flex-1 px-8 py-8">
        {/* Toast */}
        {toast && (
          <div className="fixed top-6 right-6 z-50 flex items-center gap-3 bg-green-600 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-xl animate-fade-in">
            <CheckCircle size={16} /> {toast}
          </div>
        )}
        {/* Top bar */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Migrations</h1>
            <p className="text-white/40 text-sm mt-1">All your migration jobs</p>
          </div>
          <Link
            to="/migrations/new"
            className="flex items-center gap-2 bg-[#2E86AB] hover:bg-[#247496] text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition shadow-lg shadow-[#2E86AB]/20"
          >
            <Plus size={16} /> New Migration
          </Link>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {stats.map(({ label, value }) => (
            <div key={label} className="bg-[#1E3A5F]/20 border border-white/8 rounded-xl p-4">
              <p className="text-xs text-white/40 mb-1">{label}</p>
              <p className="text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        {/* Jobs table */}
        <div className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-white/30">
              <Loader2 size={20} className="animate-spin mr-2" /> Loading jobs…
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-16 text-white/30">
              <p className="mb-2">No migrations yet.</p>
              {orgs.length === 0 ? (
                <Link to="/orgs" className="text-[#2E86AB] hover:underline text-sm">
                  Connect your first Salesforce org →
                </Link>
              ) : (
                <Link to="/migrations/new" className="text-[#2E86AB] hover:underline text-sm">
                  Start your first migration →
                </Link>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-white/40 text-xs uppercase tracking-wider">
                  <th className="text-left px-6 py-4 font-medium">Migration</th>
                  <th className="text-left px-4 py-4 font-medium">Records</th>
                  <th className="text-left px-4 py-4 font-medium">Type</th>
                  <th className="text-left px-4 py-4 font-medium">Status</th>
                  <th className="text-left px-4 py-4 font-medium">Created</th>
                  <th className="px-4 py-4" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-white/5 hover:bg-white/3 transition">
                    <td className="px-6 py-4">
                      <div className="font-medium">{job.source?.org_name || '—'}</div>
                      <div className="flex items-center gap-1 text-white/40 text-xs mt-0.5">
                        <ArrowRight size={11} />
                        {job.target?.org_name || '—'}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-white/60">
                      {job.record_counts?.total?.toLocaleString() || '—'}
                    </td>
                    <td className="px-4 py-4 text-white/50 text-xs">
                      {job.is_dry_run ? 'Dry Run' : 'Live'}
                    </td>
                    <td className="px-4 py-4">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="px-4 py-4 text-white/40 text-xs">
                      {new Date(job.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-4">
                      <Link to={`/migrations/${job.id}`} className="text-[#2E86AB] hover:underline text-xs">
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </div>
  );
}
