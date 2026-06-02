import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CheckCircle,
  Database,
  FileCheck,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  UserRound,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const defaultSettings = {
  dryRunFirst: true,
  autoRepairDeploy: true,
  askFollowUps: true,
  retrieveBeforeEdit: true,
  keepArtifactsDraft: true,
  requireReports: true,
};

function ToggleRow({ title, description, checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between gap-4 rounded-xl border border-white/8 bg-[#111113]/70 px-4 py-3 text-left hover:border-white/14 transition"
    >
      <div>
        <p className="text-sm font-medium text-white/85">{title}</p>
        <p className="text-xs text-white/35 mt-1">{description}</p>
      </div>
      {checked
        ? <ToggleRight size={34} className="shrink-0 text-[#6366f1]" />
        : <ToggleLeft size={34} className="shrink-0 text-white/25" />
      }
    </button>
  );
}

function Metric({ label, value, tone = 'text-white' }) {
  return (
    <div className="rounded-xl border border-white/8 bg-[#111113]/70 px-4 py-3">
      <p className="text-xs text-white/35 mb-1">{label}</p>
      <p className={`text-xl font-semibold ${tone}`}>{value}</p>
    </div>
  );
}

function Section({ icon: Icon, iconClass, title, subtitle, children }) {
  return (
    <section className="rounded-2xl border border-white/8 bg-[#27272a]/20 p-6">
      <div className="flex items-center gap-3 mb-5">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${iconClass}`}>
          <Icon size={18} />
        </div>
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-xs text-white/40 mt-0.5">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

export default function Settings() {
  const [user, setUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState(defaultSettings);

  const loadOrgs = useCallback(async (userId) => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/api/orgs`, { params: { userId } });
      setOrgs(data.orgs || []);
    } catch (err) {
      console.error('Failed to load org settings context:', err);
      setOrgs([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      setUser(u);
      if (u) loadOrgs(u.id);
      else setLoading(false);
    });
  }, [loadOrgs]);

  const orgSummary = useMemo(() => {
    const sourceCount = orgs.filter((org) => org.org_type === 'source').length;
    const targetCount = orgs.filter((org) => org.org_type === 'target').length;
    return {
      sourceCount,
      targetCount,
      readyForWorkspace: orgs.length > 0,
      readyForMigration: sourceCount > 0 && targetCount > 0,
      connectedCount: orgs.length,
    };
  }, [orgs]);

  function updateSetting(key, value) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Settings</h1>
            <p className="text-white/40 text-sm mt-1">Workspace defaults, connected org context, and safety controls</p>
          </div>
          <button
            onClick={() => user && loadOrgs(user.id)}
            disabled={loading || !user}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white/65 hover:text-white hover:bg-white/8 disabled:opacity-40 transition"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            Refresh
          </button>
        </div>

        <div className="grid xl:grid-cols-[minmax(0,1fr)_360px] gap-5">
          <div className="space-y-5">
            <Section
              icon={UserRound}
              iconClass="bg-[#6366f1]/15 text-[#6366f1]"
              title="Account"
              subtitle="Signed-in workspace owner"
            >
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-white/35 mb-1">Email</p>
                  <p className="text-sm text-white/85 break-all">{user?.email || '-'}</p>
                </div>
                <div>
                  <p className="text-xs text-white/35 mb-1">Supabase User ID</p>
                  <p className="text-xs text-white/55 font-mono break-all">{user?.id || '-'}</p>
                </div>
              </div>
            </Section>

            <Section
              icon={Database}
              iconClass="bg-blue-500/15 text-blue-400"
              title="Salesforce Workspace"
              subtitle="Connected orgs available for generation, deployment, testing, and migrations"
            >
              <div className="grid sm:grid-cols-3 gap-3 mb-5">
                <Metric label="Connected Orgs" value={loading ? '...' : orgSummary.connectedCount} />
                <Metric label="Source Orgs" value={loading ? '...' : orgSummary.sourceCount} tone="text-blue-400" />
                <Metric label="Target Orgs" value={loading ? '...' : orgSummary.targetCount} tone="text-purple-400" />
              </div>

              <div className={`rounded-xl border px-4 py-3 text-sm ${
                orgSummary.readyForMigration
                  ? 'border-green-500/20 bg-green-500/8 text-green-300'
                  : 'border-yellow-500/20 bg-yellow-500/8 text-yellow-300'
              }`}>
                <div className="flex items-center gap-2 font-medium">
                  <CheckCircle size={15} />
                  {orgSummary.readyForWorkspace ? 'Ready for Salesforce automation work' : 'Connect a Salesforce org to begin'}
                </div>
                <p className="text-xs opacity-75 mt-1">
                  Use connected orgs to generate and deploy metadata, retrieve existing components, test changes, and run migrations.
                  Source-to-target migration needs both org types.
                </p>
              </div>
            </Section>

            <Section
              icon={Bot}
              iconClass="bg-[#6366f1]/15 text-[#6366f1]"
              title="Generator Defaults"
              subtitle="How Claude should behave before and after generation"
            >
              <div className="grid md:grid-cols-2 gap-3">
                <ToggleRow
                  title="Ask follow-up questions first"
                  description="Require clarification before building flows, rules, Apex, or reports."
                  checked={settings.askFollowUps}
                  onChange={(value) => updateSetting('askFollowUps', value)}
                />
                <ToggleRow
                  title="Retrieve before editing"
                  description="Load deployed metadata XML before Claude revises an existing component."
                  checked={settings.retrieveBeforeEdit}
                  onChange={(value) => updateSetting('retrieveBeforeEdit', value)}
                />
                <ToggleRow
                  title="Auto-repair failed deploys"
                  description="Send Salesforce deploy errors back to Claude and retry once."
                  checked={settings.autoRepairDeploy}
                  onChange={(value) => updateSetting('autoRepairDeploy', value)}
                />
                <ToggleRow
                  title="Keep flows as draft"
                  description="New flows should deploy as Draft unless activation is explicitly selected."
                  checked={settings.keepArtifactsDraft}
                  onChange={(value) => updateSetting('keepArtifactsDraft', value)}
                />
              </div>
            </Section>

            <Section
              icon={ShieldCheck}
              iconClass="bg-green-500/15 text-green-400"
              title="Migration Defaults"
              subtitle="Safety expectations for data movement"
            >
              <div className="grid md:grid-cols-2 gap-3">
                <ToggleRow
                  title="Dry run first"
                  description="Default new migration runs to validation mode before live writes."
                  checked={settings.dryRunFirst}
                  onChange={(value) => updateSetting('dryRunFirst', value)}
                />
                <ToggleRow
                  title="Require validation report"
                  description="Generate a report for every dry run or completed migration."
                  checked={settings.requireReports}
                  onChange={(value) => updateSetting('requireReports', value)}
                />
              </div>
            </Section>
          </div>

          <aside className="space-y-5">
            <section className="rounded-2xl border border-white/8 bg-[#27272a]/20 p-5">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-green-500/15 text-green-400 flex items-center justify-center">
                  <FileCheck size={18} />
                </div>
                <div>
                  <h2 className="font-semibold">Safety Profile</h2>
                  <p className="text-xs text-white/40">Active guardrails</p>
                </div>
              </div>
              <div className="space-y-3 text-sm">
                {[
                  'Governor-limit review before generation',
                  'Metadata XML sanitization before deploy',
                  'One automatic deploy repair attempt',
                  'Validation reports for migration runs',
                  'OAuth token refresh for connected orgs',
                ].map((item) => (
                  <div key={item} className="flex items-start gap-2 text-white/65">
                    <CheckCircle size={14} className="text-green-400 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-white/8 bg-[#27272a]/20 p-5">
              <h2 className="font-semibold mb-2">Environment</h2>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between gap-3">
                  <span className="text-white/35">Frontend</span>
                  <span className="text-white/70 font-mono text-xs">localhost:5173</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-white/35">Backend API</span>
                  <span className="text-white/70 font-mono text-xs">{API.replace(/^https?:\/\//, '')}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-white/35">Mode</span>
                  <span className="text-white/70">Development</span>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-white/8 bg-[#27272a]/20 p-5">
              <h2 className="font-semibold mb-2">What Is Saved?</h2>
              <p className="text-sm text-white/45 leading-relaxed">
                Account and org connection data comes from Supabase and Salesforce OAuth.
                The switches on this screen are UI defaults today; we can persist them once the workspace settings table is added.
              </p>
            </section>
          </aside>
        </div>
      </main>
    </div>
  );
}
