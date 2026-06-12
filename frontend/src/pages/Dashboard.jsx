import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import {
  ArrowRight, Loader2, CheckCircle, XCircle, AlertTriangle,
  Sparkles, FileSpreadsheet, ShieldCheck, UserPlus,
  Box, KeyRound, FileStack, RefreshCw, Send, ShieldX, Clock,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ── Status badge ──────────────────────────────────────────────────────────────
const STATUS_CFG = {
  pending:   { label: 'Pending',   cls: 'bg-yellow-500/15 text-yellow-400' },
  running:   { label: 'Running',   cls: 'bg-[#6366f1]/15 text-[#6366f1]',  pulse: true },
  completed: { label: 'Completed', cls: 'bg-green-500/15 text-green-400' },
  failed:    { label: 'Failed',    cls: 'bg-red-500/15 text-red-400' },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-500/15 text-gray-400' },
};

function StatusBadge({ status }) {
  const cfg = STATUS_CFG[status] || STATUS_CFG.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full ${cfg.cls}`}>
      {cfg.pulse && <span className="w-1.5 h-1.5 rounded-full bg-[#6366f1] animate-pulse" />}
      {cfg.label}
    </span>
  );
}

// ── Operation type badge ──────────────────────────────────────────────────────
const OP_CFG = {
  data_load:     { label: 'Data Load',    cls: 'text-purple-400 bg-purple-500/10' },
  org_migration: { label: 'Migration',    cls: 'text-blue-400   bg-blue-500/10'   },
  deploy:        { label: 'Deploy',       cls: 'text-indigo-400 bg-indigo-500/10' },
  user_create:   { label: 'User Create',  cls: 'text-cyan-400   bg-cyan-500/10'   },
  object_create: { label: 'Object',       cls: 'text-amber-400  bg-amber-500/10'  },
  permission:    { label: 'Permission',   cls: 'text-green-400  bg-green-500/10'  },
  mapping_sheet: { label: 'Mapping',      cls: 'text-rose-400   bg-rose-500/10'   },
};

function OpBadge({ jobType, isDryRun }) {
  const cfg = OP_CFG[jobType] || OP_CFG.org_migration;
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-md ${cfg.cls}`}>
      {cfg.label}{isDryRun ? ' · Dry Run' : ''}
    </span>
  );
}

// ── OAuth error messages ──────────────────────────────────────────────────────
const CONNECT_ERRORS = {
  OAUTH_AUTHORIZATION_BLOCKED: 'Salesforce blocked this connected app. Allow the SF Copilot app in the target org, then try again.',
  oauth_missing_params: 'Salesforce returned without the expected OAuth code. Please try again.',
  token_exchange_failed: 'SF Copilot could not complete the token exchange with Salesforce.',
  oauth_failed: 'Salesforce did not authorize this org connection.',
};

// ── Quick actions ─────────────────────────────────────────────────────────────
const QUICK_ACTIONS = [
  {
    icon: <Sparkles size={18} />,
    iconCls: 'text-[#6366f1]',
    bg: 'border-[#6366f1]/20 hover:border-[#6366f1]/40 hover:bg-[#6366f1]/5',
    title: 'Generate Metadata',
    desc: 'Create or update Flows, Validation Rules, Permission Sets, and Apex with AI.',
    to: '/generator',
    prompt: 'Build or update Salesforce metadata like a Flow, Report, Validation Rule, Permission Set, or Apex class.',
  },
  {
    icon: <FileSpreadsheet size={18} />,
    iconCls: 'text-purple-400',
    bg: 'border-purple-500/20 hover:border-purple-500/40 hover:bg-purple-500/5',
    title: 'CSV Data Load',
    desc: 'Insert, update, or upsert records into any Salesforce object via Bulk API v2.',
    to: '/migrations/new',
    prompt: 'Load, insert, update, or upsert CSV data into Salesforce with validation first.',
  },
  {
    icon: <FileStack size={18} />,
    iconCls: 'text-amber-400',
    bg: 'border-amber-500/20 hover:border-amber-500/40 hover:bg-amber-500/5',
    title: 'Mapping Sheet',
    desc: 'Upload a field mapping sheet, compare against your org, and create missing fields.',
    to: '/mapping-sheet',
    badge: 'New',
    prompt: 'Analyze a mapping sheet, find missing Salesforce fields, and help create the gaps safely.',
  },
  {
    icon: <UserPlus size={18} />,
    iconCls: 'text-cyan-400',
    bg: 'border-cyan-500/20 hover:border-cyan-500/40 hover:bg-cyan-500/5',
    title: 'Create Users',
    desc: 'Create individual or bulk users with profile, role, and permission set assignment.',
    to: '/users',
    badge: 'New',
    prompt: 'Create, deactivate, mirror, or permission Salesforce users.',
  },
  {
    icon: <Box size={18} />,
    iconCls: 'text-orange-400',
    bg: 'border-orange-500/20 hover:border-orange-500/40 hover:bg-orange-500/5',
    title: 'Create Object',
    desc: 'Create custom objects with tabs, search, fields, and sharing model — guided wizard.',
    to: '/objects',
    badge: 'New',
    prompt: 'Create a custom object with fields, relationships, tab, search, reports, and profile access.',
  },
  {
    icon: <KeyRound size={18} />,
    iconCls: 'text-green-400',
    bg: 'border-green-500/20 hover:border-green-500/40 hover:bg-green-500/5',
    title: 'Permissions',
    desc: 'Create permission sets, assign to users, and manage profile object/field access.',
    to: '/permissions',
    badge: 'New',
    prompt: 'Create permission sets, manage profile access, or assign permissions to users.',
  },
];

const MODULE_LABELS = {
  generator: 'Metadata Generator',
  objects: 'Objects',
  users: 'Users',
  migrations: 'CSV Data Load',
  permissions: 'Permissions',
  mapping_sheet: 'Mapping Sheet',
  reports: 'Reports',
};

const HEALTH_LABELS = {
  identity: 'Identity',
  rest_api: 'REST',
  metadata_api: 'Metadata',
  deploy_access: 'Deploy',
  token_refresh: 'Token',
  api_version: 'API',
};

function riskClass(risk) {
  if (risk === 'critical') return 'bg-red-500/15 text-red-300 border-red-500/30';
  if (risk === 'high') return 'bg-orange-500/15 text-orange-300 border-orange-500/30';
  if (risk === 'medium') return 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30';
  return 'bg-green-500/15 text-green-300 border-green-500/30';
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function jobTitle(job) {
  const type = job.mapping_config?.jobType;
  if (type === 'data_load') {
    const op = job.mapping_config?.operation || 'load';
    const obj = job.mapping_config?.objectApiName || 'Records';
    return `${obj} ${op}`;
  }
  return job.source?.org_name || 'Org migration';
}

function jobSubtitle(job) {
  const type = job.mapping_config?.jobType;
  if (type === 'data_load') return job.target?.org_name || 'Target org';
  return job.target?.org_name || '—';
}

function orgHealthStatus(org) {
  const checks = Object.values(org.health || {});
  if (!checks.length) return 'unknown';
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'warning')) return 'warning';
  if (checks.every(c => c.status === 'pass')) return 'pass';
  return 'unknown';
}

function healthBadge(status) {
  if (status === 'pass') return { label: 'Healthy', cls: 'text-green-400 bg-green-500/10 border-green-500/20', icon: ShieldCheck };
  if (status === 'fail') return { label: 'Error', cls: 'text-red-400 bg-red-500/10 border-red-500/20', icon: ShieldX };
  if (status === 'warning') return { label: 'Warning', cls: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20', icon: AlertTriangle };
  return { label: 'Not tested', cls: 'text-white/35 bg-white/5 border-white/10', icon: AlertTriangle };
}

function jobMatchesOrg(job, orgId) {
  if (!orgId) return true;
  return job.source_org_id === orgId || job.target_org_id === orgId ||
    job.source?.id === orgId || job.target?.id === orgId;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [user, setUser]       = useState(null);
  const [jobs, setJobs]       = useState([]);
  const [orgs, setOrgs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast]     = useState(null);
  const [command, setCommand] = useState('');
  const [plan, setPlan]       = useState(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState('');
  const [operationFilter, setOperationFilter] = useState('');
  const [orgFilter, setOrgFilter] = useState('');
  const [searchParams]        = useSearchParams();
  const navigate              = useNavigate();

  const loadData = useCallback(async (userId) => {
    setLoading(true);
    try {
      const [jobsRes, orgsRes] = await Promise.all([
        axios.get(`${API}/api/migrations`, { params: { userId } }),
        axios.get(`${API}/api/orgs`,       { params: { userId } }),
      ]);
      setJobs(jobsRes.data.jobs || []);
      setOrgs(orgsRes.data.orgs || []);
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

  // Auto-refresh while any job is running
  useEffect(() => {
    if (!user) return;
    const hasRunning = jobs.some(j => ['running', 'pending'].includes(j.status));
    if (!hasRunning) return;
    const t = setInterval(() => loadData(user.id), 10000);
    return () => clearInterval(t);
  }, [jobs, user, loadData]);

  // OAuth toast
  useEffect(() => {
    let clearToast;
    const showToast = (message, type = 'success') => {
      navigate('/dashboard', { replace: true });
      setToast({ message, type });
      clearToast = setTimeout(() => setToast(null), 5000);
    };
    const timeout = setTimeout(() => {
      if (searchParams.get('connected') === 'true') {
        showToast('Salesforce org connected successfully!');
      } else if (searchParams.get('error')) {
        const detail = searchParams.get('detail');
        showToast(
          CONNECT_ERRORS[detail] || CONNECT_ERRORS[searchParams.get('error')] || 'Failed to connect org. Please try again.',
          'error'
        );
      }
    }, 0);
    return () => { clearTimeout(timeout); if (clearToast) clearTimeout(clearToast); };
  }, [navigate, searchParams]);

  const stats = [
    { label: 'Connected Orgs', value: orgs.length },
    { label: 'Total Operations', value: jobs.length },
    { label: 'Completed', value: jobs.filter(j => j.status === 'completed').length },
    { label: 'Failed', value: jobs.filter(j => j.status === 'failed').length },
  ];

  const hasRunning = jobs.some(j => ['running', 'pending'].includes(j.status));
  const operationTypes = [...new Set(jobs.map(j => j.mapping_config?.jobType || 'org_migration'))];
  const filteredJobs = jobs.filter(job => {
    const type = job.mapping_config?.jobType || 'org_migration';
    return (!operationFilter || type === operationFilter) && jobMatchesOrg(job, orgFilter);
  });
  const healthCounts = orgs.reduce((acc, org) => {
    acc[orgHealthStatus(org)] += 1;
    return acc;
  }, { pass: 0, warning: 0, fail: 0, unknown: 0 });

  const createPlan = async (event) => {
    event?.preventDefault();
    const prompt = command.trim();
    if (!prompt) return;

    setPlanning(true);
    setPlanError('');
    setPlan(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const { data } = await axios.post(
        `${API}/api/copilot/intent`,
        { prompt },
        token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
      );
      setPlan(data.plan);
    } catch (err) {
      setPlanError(err.response?.data?.error || err.message || 'Could not create a Copilot plan.');
    } finally {
      setPlanning(false);
    }
  };

  const continuePlan = () => {
    if (!plan?.suggested_route) return;
    navigate(plan.suggested_route, { state: { copilotPlan: plan } });
  };

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />

      <main className="flex-1 px-8 py-8 overflow-auto">

        {/* Toast */}
        {toast && (
          <div className={`fixed top-6 right-6 z-50 flex items-center gap-3 text-white text-sm font-medium px-5 py-3 rounded-xl shadow-xl ${
            toast.type === 'error' ? 'bg-red-600' : 'bg-green-600'
          }`}>
            {toast.type === 'error' ? <XCircle size={16} /> : <CheckCircle size={16} />}
            <span>{toast.message}</span>
            <button onClick={() => setToast(null)} className="ml-2 text-white/70 hover:text-white text-lg leading-none">×</button>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Workspace</h1>
            <p className="text-white/35 text-sm mt-1">Your Salesforce admin command centre</p>
          </div>
          <div className="flex items-center gap-3">
            {hasRunning && (
              <span className="text-xs text-[#6366f1] flex items-center gap-1.5">
                <RefreshCw size={11} className="animate-spin" /> Live
              </span>
            )}
            <button
              onClick={() => user && loadData(user.id)}
              className="flex items-center gap-2 bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 hover:text-white font-medium px-4 py-2 rounded-xl text-sm transition"
            >
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
        </div>

        {/* Command layer */}
        <section className="mb-8 border border-[#6366f1]/25 bg-[#18181c] rounded-2xl overflow-hidden shadow-2xl shadow-[#6366f1]/5">
          <div className="px-6 py-5 border-b border-white/8">
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="flex items-center gap-2 text-[#818cf8] text-xs font-semibold uppercase tracking-widest mb-2">
                  <Sparkles size={14} /> Copilot Command
                </div>
                <h2 className="text-xl font-bold tracking-tight">Start with a Salesforce request</h2>
                <p className="text-sm text-white/40 mt-1">
                  It will create a draft plan, choose the right workspace, and ask for only the missing details.
                </p>
              </div>
              <div className="hidden lg:flex items-center gap-2 text-xs text-white/35">
                <ShieldCheck size={15} className="text-green-400" />
                Draft plan first. No deploy from this prompt.
              </div>
            </div>

            <form onSubmit={createPlan} className="mt-5">
              <div className="flex flex-col xl:flex-row gap-3">
                <textarea
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  rows={3}
                  className="flex-1 resize-none rounded-xl bg-[#111113] border border-white/10 focus:border-[#6366f1] outline-none px-4 py-3 text-sm text-white placeholder:text-white/25 leading-relaxed"
                  placeholder="Example: Create a Partner Onboarding object with Stage, Due Date, Owner, and Approval Status. Give admins full access and standard users read access."
                />
                <button
                  type="submit"
                  disabled={planning || command.trim().length < 8}
                  className="w-full xl:w-40 min-h-12 rounded-xl bg-[#6366f1] hover:bg-[#5558e8] disabled:bg-white/10 disabled:text-white/30 text-white font-semibold text-sm transition flex items-center justify-center gap-2"
                >
                  {planning ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />}
                  Plan
                </button>
              </div>
            </form>

            {planError && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                <XCircle size={15} /> {planError}
              </div>
            )}

            {plan && (
              <div className="mt-4 rounded-xl border border-white/10 bg-[#111113] p-4">
                <div className="flex items-start justify-between gap-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className="text-sm font-semibold text-white">
                        {MODULE_LABELS[plan.target_module] || 'Workspace'} plan
                      </span>
                      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-md border ${riskClass(plan.risk_level)}`}>
                        {plan.risk_level} risk
                      </span>
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-white/5 text-white/45">
                        {Math.round((plan.confidence || 0) * 100)}% confidence
                      </span>
                      {plan.needs_confirmation && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md bg-yellow-500/10 text-yellow-300">
                          <AlertTriangle size={11} /> confirm
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-white/75">{plan.interpreted_summary}</p>
                    <p className="text-xs text-white/35 mt-1">{plan.reason}</p>
                    {plan.missing_info?.length > 0 && (
                      <p className="text-xs text-white/45 mt-3">
                        Missing details: {plan.missing_info.join(', ')}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={continuePlan}
                    className="shrink-0 rounded-xl bg-white text-[#111113] hover:bg-white/85 px-4 py-2 text-sm font-semibold transition flex items-center gap-2"
                  >
                    Continue <ArrowRight size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-3 p-4">
            {QUICK_ACTIONS.map(({ icon, iconCls, bg, title, desc, to, badge, prompt }) => (
              <div key={to}
                className={`bg-[#111113]/70 border ${bg} rounded-xl px-4 py-3 transition flex items-start gap-3 group`}>
                <div className={`mt-0.5 shrink-0 ${iconCls}`}>{icon}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-white">{title}</p>
                    {badge && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-[#6366f1]/20 text-[#6366f1]">
                        {badge}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-white/35 mt-0.5 leading-relaxed">{desc}</p>
                  <div className="flex items-center gap-3 mt-3">
                    <button
                      type="button"
                      aria-label={`Use ${title} prompt`}
                      onClick={() => {
                        setCommand(prompt);
                        setPlan(null);
                        setPlanError('');
                      }}
                      className="text-xs text-[#818cf8] hover:text-white transition"
                    >
                      Use prompt
                    </button>
                    <Link to={to} className="text-xs text-white/35 hover:text-white transition">
                      Open workspace
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Org health summary */}
        <section className="mb-8 bg-[#27272a]/20 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/6 flex items-center justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-white/35">Org Health</p>
              <p className="text-xs text-white/30 mt-1">Six live checks: identity, REST, Metadata, deploy access, token refresh, and API version.</p>
            </div>
            <Link to="/orgs" className="text-xs text-[#818cf8] hover:text-white transition">
              Manage orgs →
            </Link>
          </div>

          {orgs.length === 0 ? (
            <div className="px-5 py-6 text-sm text-white/35">
              No connected orgs yet. <Link to="/orgs" className="text-[#818cf8] hover:text-white">Connect an org</Link> to unlock Salesforce operations.
            </div>
          ) : (
            <>
              <div className="grid grid-cols-4 border-b border-white/6">
                {[
                  { label: 'Healthy', value: healthCounts.pass, cls: 'text-green-400' },
                  { label: 'Warnings', value: healthCounts.warning, cls: 'text-yellow-400' },
                  { label: 'Errors', value: healthCounts.fail, cls: 'text-red-400' },
                  { label: 'Not tested', value: healthCounts.unknown, cls: 'text-white/35' },
                ].map(item => (
                  <div key={item.label} className="px-5 py-3 border-r border-white/6 last:border-r-0">
                    <p className="text-xs text-white/30">{item.label}</p>
                    <p className={`text-xl font-bold ${item.cls}`}>{item.value}</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3 p-4">
                {orgs.slice(0, 4).map(org => {
                  const status = orgHealthStatus(org);
                  const badge = healthBadge(status);
                  const Icon = badge.icon;
                  const failed = Object.entries(org.health || {}).filter(([, r]) => r.status === 'fail');
                  return (
                    <Link key={org.id} to="/orgs" className="bg-[#111113]/70 border border-white/8 hover:border-white/18 rounded-xl px-4 py-3 transition">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{org.org_alias || org.org_name}</p>
                            <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/5 text-white/35 shrink-0">{org.org_type}</span>
                          </div>
                          <p className="text-xs text-white/30 truncate mt-0.5">{org.username || org.instance_url}</p>
                          {org.last_tested_at ? (
                            <p className="text-[11px] text-white/25 mt-2 flex items-center gap-1">
                              <Clock size={10} /> Tested {new Date(org.last_tested_at).toLocaleString()}
                            </p>
                          ) : (
                            <p className="text-[11px] text-yellow-300/70 mt-2">Run health test before deploying or loading data.</p>
                          )}
                          {failed.length > 0 && (
                            <p className="text-[11px] text-red-300/75 mt-1">
                              Failed: {failed.map(([key]) => HEALTH_LABELS[key] || key).join(', ')}
                            </p>
                          )}
                        </div>
                        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-lg border ${badge.cls}`}>
                          <Icon size={12} /> {badge.label}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {/* Stats */}
        <div className="grid grid-cols-2 2xl:grid-cols-4 gap-4 mb-8">
          {stats.map(({ label, value }) => (
            <div key={label} className="bg-[#27272a]/20 border border-white/8 rounded-xl px-5 py-4">
              <p className="text-xs text-white/35 mb-1">{label}</p>
              <p className="text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        {/* Activity feed */}
        <div className="bg-[#27272a]/20 border border-white/8 rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/6 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-widest text-white/35">
              Recent Activity
            </span>
            <div className="flex items-center gap-2">
              <select
                value={operationFilter}
                onChange={e => setOperationFilter(e.target.value)}
                className="bg-[#111113] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/55 focus:outline-none focus:border-[#6366f1]"
              >
                <option value="">All types</option>
                {operationTypes.map(type => <option key={type} value={type}>{OP_CFG[type]?.label || type}</option>)}
              </select>
              <select
                value={orgFilter}
                onChange={e => setOrgFilter(e.target.value)}
                className="bg-[#111113] border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white/55 focus:outline-none focus:border-[#6366f1]"
              >
                <option value="">All orgs</option>
                {orgs.map(org => <option key={org.id} value={org.id}>{org.org_alias || org.org_name}</option>)}
              </select>
              <Link to="/history" className="text-xs text-[#6366f1] hover:underline">
                View all →
              </Link>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16 text-white/30">
              <Loader2 size={20} className="animate-spin mr-2" /> Loading…
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="text-center py-16 text-white/30">
              <p className="mb-3 text-sm">{jobs.length === 0 ? 'No operations yet.' : 'No operations match these filters.'}</p>
              {jobs.length === 0 && orgs.length === 0 ? (
                <Link to="/orgs" className="text-[#6366f1] hover:underline text-sm">
                  Connect your first Salesforce org →
                </Link>
              ) : jobs.length === 0 ? (
                <p className="text-xs">Pick an action above to get started.</p>
              ) : (
                <button onClick={() => { setOperationFilter(''); setOrgFilter(''); }} className="text-xs text-[#818cf8] hover:text-white">
                  Clear filters
                </button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-white/6 text-white/30 text-xs uppercase tracking-wider">
                    <th className="text-left px-6 py-3 font-medium">Operation</th>
                    <th className="text-left px-4 py-3 font-medium">Records</th>
                    <th className="text-left px-4 py-3 font-medium">Type</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Created</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs.map((job) => (
                    <tr key={job.id} className="border-b border-white/4 hover:bg-white/[0.02] transition">
                      <td className="px-6 py-3.5">
                        <div className="font-medium text-white/85">{jobTitle(job)}</div>
                        <div className="flex items-center gap-1 text-white/30 text-xs mt-0.5">
                          <ArrowRight size={10} />
                          {jobSubtitle(job)}
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-white/50 text-sm">
                        {job.record_counts?.total?.toLocaleString() || '—'}
                      </td>
                      <td className="px-4 py-3.5">
                        <OpBadge
                          jobType={job.mapping_config?.jobType || 'org_migration'}
                          isDryRun={job.is_dry_run}
                        />
                      </td>
                      <td className="px-4 py-3.5">
                        <StatusBadge status={job.status} />
                      </td>
                      <td className="px-4 py-3.5 text-white/30 text-xs">
                        <div>{new Date(job.created_at).toLocaleDateString()}</div>
                        <div className="text-white/20">{new Date(job.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                      </td>
                      <td className="px-4 py-3.5">
                        <Link to={`/migrations/${job.id}`}
                          className="text-xs text-[#6366f1] hover:text-[#818cf8] transition">
                          View →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Bottom spacer */}
        <div className="h-8" />
      </main>
    </div>
  );
}
