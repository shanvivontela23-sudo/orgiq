import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Loader2, ArrowRight } from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const STATUS_CLASS = {
  completed: 'bg-green-500/15 text-green-400',
  failed: 'bg-red-500/15 text-red-400',
  cancelled: 'bg-gray-500/15 text-gray-400',
  running: 'bg-[#2E86AB]/15 text-[#2E86AB]',
  pending: 'bg-yellow-500/15 text-yellow-400',
};

export default function Reports() {
  const [user, setUser] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);

  const loadReports = useCallback(async (userId) => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/api/migrations`, {
        params: { userId, statuses: 'completed,failed,cancelled' },
      });
      setJobs(data.jobs || []);
    } catch (err) {
      console.error('Failed to load reports:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      setUser(u);
      if (u) loadReports(u.id);
      else setLoading(false);
    });
  }, [loadReports]);

  return (
    <div className="flex min-h-screen bg-[#0f1e30] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Reports</h1>
            <p className="text-white/40 text-sm mt-1">Completed migration reports and run summaries</p>
            {user && (
              <p className="text-white/25 text-xs mt-2">
                Showing reports for {user.email}
              </p>
            )}
          </div>
          <Link
            to="/migrations/new"
            className="bg-[#2E86AB] hover:bg-[#247496] text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition"
          >
            New Migration
          </Link>
        </div>

        <div className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16 text-white/30">
              <Loader2 size={20} className="animate-spin mr-2" /> Loading reports...
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-20 text-white/30">
              <FileText size={34} className="mx-auto mb-4 opacity-30" />
              <p className="mb-2">No reports yet.</p>
              {user && (
                <p className="text-xs text-white/25 mb-4">
                  Reports are scoped to the signed-in account: {user.email}
                </p>
              )}
              <Link to="/migrations/new" className="text-[#2E86AB] hover:underline text-sm">
                Run a validation to generate one
              </Link>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/8 text-white/40 text-xs uppercase tracking-wider">
                  <th className="text-left px-6 py-4 font-medium">Run</th>
                  <th className="text-left px-4 py-4 font-medium">Records</th>
                  <th className="text-left px-4 py-4 font-medium">Status</th>
                  <th className="text-left px-4 py-4 font-medium">Completed</th>
                  <th className="px-4 py-4" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-white/5 hover:bg-white/3 transition">
                    <td className="px-6 py-4">
                      <div className="font-medium">{job.source?.org_name || 'Source org'}</div>
                      <div className="flex items-center gap-1 text-white/40 text-xs mt-0.5">
                        <ArrowRight size={11} />
                        {job.target?.org_name || 'Target org'} · {job.is_dry_run ? 'Dry Run' : 'Live'}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-white/60">
                      {(job.record_counts?.total ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-4">
                      <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_CLASS[job.status] || STATUS_CLASS.pending}`}>
                        {job.status}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-white/40 text-xs">
                      {job.completed_at ? new Date(job.completed_at).toLocaleString() : '-'}
                    </td>
                    <td className="px-4 py-4 text-right">
                      <Link to={`/migrations/${job.id}/report`} className="text-[#2E86AB] hover:underline text-xs">
                        View report
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
