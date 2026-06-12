import { useCallback, useEffect, useState } from 'react';
import {
  Link2, Plus, Trash2, Loader2, CheckCircle, RefreshCw,
  ArrowLeftRight, ShieldCheck, ShieldX, AlertTriangle,
  Activity, Clock, ChevronDown, ChevronUp, ExternalLink,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ── helpers ──────────────────────────────────────────────────────────────────

const TEST_LABELS = {
  identity:      'Identity',
  rest_api:      'REST API',
  metadata_api:  'Metadata API',
  deploy_access: 'Deploy Access',
  token_refresh: 'Token Refresh',
  api_version:   'API Version',
};

function overallHealth(health) {
  const checks = Object.values(health);
  if (!checks.length) return 'unknown';
  if (checks.some(c => c.status === 'fail'))    return 'fail';
  if (checks.some(c => c.status === 'warning')) return 'warning';
  if (checks.every(c => c.status === 'pass'))   return 'pass';
  return 'unknown';
}

function HealthBadge({ status }) {
  if (status === 'pass')    return <span className="flex items-center gap-1 text-xs text-green-400"><ShieldCheck size={12} /> Healthy</span>;
  if (status === 'fail')    return <span className="flex items-center gap-1 text-xs text-red-400"><ShieldX size={12} /> Issues found</span>;
  if (status === 'warning') return <span className="flex items-center gap-1 text-xs text-yellow-400"><AlertTriangle size={12} /> Warnings</span>;
  return <span className="text-xs text-white/30">Not tested</span>;
}

function CheckRow({ label, result }) {
  const colors = { pass: 'text-green-400', fail: 'text-red-400', warning: 'text-yellow-400' };
  const icons  = { pass: <CheckCircle size={12} />, fail: <ShieldX size={12} />, warning: <AlertTriangle size={12} /> };
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className={`${colors[result.status] || 'text-white/30'} flex items-center gap-1`}>
          {icons[result.status] || <Activity size={12} />}
          <span className="text-xs font-medium">{label}</span>
        </span>
        {result.latencyMs && (
          <span className="text-xs text-white/20">{result.latencyMs}ms</span>
        )}
      </div>
      {result.status !== 'pass' && result.errorMessage && (
        <p className="text-xs text-red-300/70 ml-4">{result.errorMessage}</p>
      )}
      {result.status !== 'pass' && result.remediation && (
        <p className="text-xs text-orange-300/60 ml-4">→ {result.remediation}</p>
      )}
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function ConnectedOrgs() {
  const [user, setUser]             = useState(null);
  const [orgs, setOrgs]             = useState([]);
  const [loading, setLoading]       = useState(true);
  const [removing, setRemoving]     = useState(null);
  const [testing, setTesting]       = useState({});        // orgId → true/false
  const [expanded, setExpanded]     = useState({});        // orgId → true/false
  const [pendingRemoval, setPendingRemoval] = useState(null);
  const [notice, setNotice]         = useState(null);
  const [error, setError]           = useState(null);

  const loadOrgs = useCallback(async (userId) => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/api/orgs`, { params: { userId } });
      setOrgs(data.orgs || []);
    } catch (err) {
      console.error('Failed to load orgs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      setUser(u);
      if (u) loadOrgs(u.id);
    });
  }, [loadOrgs]);

  async function handleDisconnect(org) {
    setRemoving(org.id);
    setError(null);
    setNotice(null);
    try {
      await axios.delete(`${API}/api/orgs/${org.id}`);
      setOrgs(prev => prev.filter(o => o.id !== org.id));
      setPendingRemoval(null);
      setNotice(`${org.org_name || 'Org'} was removed from SF Copilot.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to remove org.');
    } finally {
      setRemoving(null);
    }
  }

  function handleConnectOrg(orgType) {
    if (!user) return;
    window.location.href = `${API}/auth/salesforce?userId=${user.id}&orgType=${orgType}`;
  }

  async function handleToggleRole(org) {
    const newRole = org.org_type === 'source' ? 'target' : 'source';
    try {
      await axios.patch(`${API}/api/orgs/${org.id}`, { org_type: newRole });
      setOrgs(prev => prev.map(o => o.id === org.id ? { ...o, org_type: newRole } : o));
      setNotice(`${org.org_name} switched to ${newRole} org.`);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to update org role.');
    }
  }

  async function handleTestConnection(org) {
    if (!user) return;
    setTesting(prev => ({ ...prev, [org.id]: true }));
    setExpanded(prev => ({ ...prev, [org.id]: true })); // auto-expand on test
    try {
      const { data } = await axios.post(`${API}/api/orgs/${org.id}/test`, { userId: user.id });
      // Merge health results into org list
      setOrgs(prev => prev.map(o =>
        o.id === org.id
          ? { ...o, health: data.results || {}, last_tested_at: new Date().toISOString() }
          : o
      ));
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Connection test failed.');
    } finally {
      setTesting(prev => ({ ...prev, [org.id]: false }));
    }
  }

  function toggleExpanded(orgId) {
    setExpanded(prev => ({ ...prev, [orgId]: !prev[orgId] }));
  }

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />

      <main className="flex-1 px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Connected Orgs</h1>
            <p className="text-white/40 text-sm mt-1">Salesforce orgs connected via OAuth</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => handleConnectOrg('source')}
              className="flex items-center gap-2 bg-[#27272a]/50 hover:bg-[#27272a] border border-white/10 text-white/80 font-medium px-4 py-2.5 rounded-xl text-sm transition"
            >
              <Plus size={15} /> Source Org
            </button>
            <button
              onClick={() => handleConnectOrg('target')}
              className="flex items-center gap-2 bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-4 py-2.5 rounded-xl text-sm transition shadow-lg shadow-[#6366f1]/20"
            >
              <Plus size={15} /> Target Org
            </button>
          </div>
        </div>

        {/* Notices */}
        {notice && (
          <div className="mb-4 rounded-xl border border-green-500/20 bg-green-500/10 px-4 py-3 text-sm text-green-300 flex items-center justify-between">
            <span>{notice}</span>
            <button onClick={() => setNotice(null)} className="text-green-300/50 hover:text-green-200 text-xs">✕</button>
          </div>
        )}
        {error && (
          <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="text-red-200/70 hover:text-red-100 shrink-0">Dismiss</button>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-20 text-white/30">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading orgs…
          </div>
        ) : orgs.length === 0 ? (
          <div className="text-center py-20 text-white/30 border border-dashed border-white/10 rounded-2xl">
            <Link2 size={32} className="mx-auto mb-4 opacity-30" />
            <p className="mb-4 text-base">No orgs connected yet.</p>
            <div className="flex gap-3 justify-center">
              <button onClick={() => handleConnectOrg('source')} className="bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition">
                Connect Source Org
              </button>
              <button onClick={() => handleConnectOrg('target')} className="bg-white/5 hover:bg-white/10 text-white/70 font-medium px-6 py-2.5 rounded-xl text-sm transition border border-white/10">
                Connect Target Org
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {orgs.map((org) => {
              const health  = org.health || {};
              const status  = overallHealth(health);
              const isExpanded = expanded[org.id];
              const isTesting  = testing[org.id];
              const isProduction = org.instance_url && !org.instance_url.includes('sandbox') &&
                !org.instance_url.includes('scratch') && !org.instance_url.includes('develop') &&
                !org.instance_url.includes('orgfarm');

              return (
                <div
                  key={org.id}
                  className={`bg-[#27272a]/20 border rounded-2xl overflow-hidden transition ${
                    status === 'fail' ? 'border-red-500/30' :
                    status === 'warning' ? 'border-yellow-500/20' :
                    status === 'pass' ? 'border-green-500/20' :
                    'border-white/8'
                  }`}
                >
                  {/* Production warning banner */}
                  {isProduction && (
                    <div className="px-5 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 text-xs text-amber-300">
                      <AlertTriangle size={12} />
                      <span><strong>Production org</strong> — all writes and deploys require explicit confirmation.</span>
                    </div>
                  )}

                  {/* Main card row */}
                  <div className="px-6 py-5 flex items-center justify-between">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        status === 'fail'    ? 'bg-red-500/15' :
                        status === 'pass'    ? 'bg-green-500/15' :
                        status === 'warning' ? 'bg-yellow-500/15' :
                        'bg-[#6366f1]/20'
                      }`}>
                        {status === 'fail'    ? <ShieldX size={18} className="text-red-400" /> :
                         status === 'pass'    ? <ShieldCheck size={18} className="text-green-400" /> :
                         status === 'warning' ? <AlertTriangle size={18} className="text-yellow-400" /> :
                         <Link2 size={18} className="text-[#6366f1]" />}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-white truncate">{org.org_name}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                            org.org_type === 'source' ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'
                          }`}>
                            {org.org_type}
                          </span>
                          {isProduction && (
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-500/15 text-amber-400 shrink-0">production</span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                          <a
                            href={org.instance_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-white/40 hover:text-white/70 flex items-center gap-1 transition"
                          >
                            {org.instance_url} <ExternalLink size={10} />
                          </a>
                          {org.last_tested_at && (
                            <span className="text-xs text-white/25 flex items-center gap-1">
                              <Clock size={10} /> Tested {new Date(org.last_tested_at).toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 ml-4">
                      {/* Health summary */}
                      <HealthBadge status={status} />

                      {/* Test Connection */}
                      <button
                        onClick={() => handleTestConnection(org)}
                        disabled={isTesting}
                        className="inline-flex items-center gap-1.5 border border-[#6366f1]/30 bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1] disabled:opacity-50 transition px-3 py-2 rounded-xl text-xs font-medium"
                      >
                        {isTesting
                          ? <><Loader2 size={12} className="animate-spin" /> Testing…</>
                          : <><Activity size={12} /> Test Connection</>
                        }
                      </button>

                      {/* Expand/collapse checks */}
                      {Object.keys(health).length > 0 && (
                        <button
                          onClick={() => toggleExpanded(org.id)}
                          className="text-white/30 hover:text-white/70 transition p-1"
                        >
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      )}

                      {/* Toggle role */}
                      <button
                        onClick={() => handleToggleRole(org)}
                        className="inline-flex items-center gap-1.5 border border-white/10 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition px-3 py-2 rounded-xl text-xs font-medium"
                        title={`Switch to ${org.org_type === 'source' ? 'target' : 'source'}`}
                      >
                        <ArrowLeftRight size={12} />
                        Make {org.org_type === 'source' ? 'Target' : 'Source'}
                      </button>

                      {/* Remove */}
                      <button
                        onClick={() => { setPendingRemoval(org); setError(null); setNotice(null); }}
                        disabled={removing === org.id}
                        className="inline-flex items-center gap-1.5 border border-red-500/20 bg-red-500/5 hover:bg-red-500/10 text-red-300 hover:text-red-200 transition disabled:opacity-50 px-3 py-2 rounded-xl text-xs font-medium"
                      >
                        {removing === org.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        {removing === org.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </div>

                  {/* Expanded checks panel */}
                  {isExpanded && Object.keys(health).length > 0 && (
                    <div className="border-t border-white/6 px-6 py-4 bg-black/10">
                      <p className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-3">Connection Checks</p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {Object.entries(TEST_LABELS).map(([key, label]) => (
                          health[key] ? (
                            <CheckRow key={key} label={label} result={health[key]} />
                          ) : null
                        ))}
                      </div>
                      {/* Any remediation callout */}
                      {Object.values(health).some(c => c.status === 'fail') && (
                        <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-200/80">
                          <strong className="text-red-300">Action required:</strong> Fix the failing checks above before using this org for deploys or data loads.
                        </div>
                      )}
                    </div>
                  )}

                  {/* Loading skeleton for in-progress test */}
                  {isTesting && (
                    <div className="border-t border-white/6 px-6 py-4 bg-black/10">
                      <div className="flex items-center gap-2 text-xs text-white/40">
                        <Loader2 size={12} className="animate-spin" />
                        Running identity, REST, Metadata, deploy, token, and API version checks…
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <button
              onClick={() => user && loadOrgs(user.id)}
              className="flex items-center gap-2 text-white/30 hover:text-white text-xs transition mt-2"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        )}

        {/* Info box */}
        <div className="mt-8 bg-[#27272a]/10 border border-white/6 rounded-xl p-5 text-xs text-white/40">
          <p className="font-semibold text-white/60 mb-1">How org connections work</p>
          <p>SF Copilot uses one managed Connected App for every org you authorize. Test Connection runs six live checks against Salesforce — identity, REST API, Metadata API, deploy access, token refresh, and API version — and shows exact remediation steps if anything fails. Your token is stored encrypted and can be revoked by disconnecting the org.</p>
        </div>
      </main>

      {/* Remove confirmation modal */}
      {pendingRemoval && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#18181b] p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white">Remove connected org?</h2>
            <p className="mt-2 text-sm text-white/55">
              This removes <span className="font-medium text-white">{pendingRemoval.org_name}</span> from SF Copilot and revokes its OAuth token.
            </p>
            <div className="mt-4 rounded-xl border border-white/8 bg-white/[0.03] p-3 text-xs text-white/45 space-y-1">
              <div className="font-medium text-white/70">{pendingRemoval.org_type} org</div>
              <div className="break-all">{pendingRemoval.instance_url}</div>
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={() => setPendingRemoval(null)}
                disabled={removing === pendingRemoval.id}
                className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white/70 transition hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDisconnect(pendingRemoval)}
                disabled={removing === pendingRemoval.id}
                className="inline-flex items-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-400 disabled:opacity-60"
              >
                {removing === pendingRemoval.id && <Loader2 size={15} className="animate-spin" />}
                {removing === pendingRemoval.id ? 'Removing...' : 'Remove Org'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
