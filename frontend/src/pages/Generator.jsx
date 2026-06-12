import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Loader2, Send, Wand2, Rocket, ChevronDown, ChevronUp,
  CheckCircle, XCircle, AlertTriangle, FileCode, ClipboardList,
  BookOpen, CheckSquare, HelpCircle, Copy, Check,
  ShieldAlert, Zap, Edit3, PlusCircle, RotateCcw, Download,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';
import LoadingButton from '../components/LoadingButton';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ── Data ─────────────────────────────────────────────────────────────────────

const ARTIFACT_TYPES = [
  {
    value: '',
    label: 'Auto-detect',
    icon: '🔍',
    desc: 'SF Copilot figures it out from your description',
  },
  {
    value: 'validationRule',
    label: 'Validation Rule',
    icon: '✅',
    desc: 'Enforce data quality on save',
    risk: 'low',
  },
  {
    value: 'report',
    label: 'Report',
    icon: '📊',
    desc: 'Build Salesforce reports and dashboards',
    risk: 'low',
  },
  {
    value: 'flow',
    label: 'Flow',
    icon: '⚡',
    desc: 'Record-triggered or scheduled automation',
    risk: 'high',
  },
  {
    value: 'apex',
    label: 'Apex Class',
    icon: '💻',
    desc: 'Custom code — requires test coverage',
    risk: 'high',
  },
  {
    value: 'permissionSet',
    label: 'Permission Set',
    icon: '🔑',
    desc: 'Grant object/field access to users',
    risk: 'medium',
  },
];

const INPUT_TYPES = [
  { value: 'english',      label: 'Plain English',          desc: 'Describe what you need in plain language' },
  { value: 'metadataXml',  label: 'Existing Metadata XML',  desc: 'Paste or load XML from an existing component' },
  { value: 'workflowRule', label: 'Workflow Rule XML',       desc: 'Migrate a legacy Workflow Rule to Flow' },
  { value: 'processBuilder', label: 'Process Builder XML',   desc: 'Migrate a Process Builder to Flow' },
  { value: 'apexClass',    label: 'Apex Class',              desc: 'Refactor or extend an existing Apex class' },
];

const PIPELINE_STAGES = [
  { key: 'describe',  label: 'Describe' },
  { key: 'review',    label: 'Review' },
  { key: 'generate',  label: 'Generate' },
  { key: 'preflight', label: 'Preflight' },
  { key: 'dryrun',    label: 'Dry Run' },
  { key: 'deploy',    label: 'Deploy' },
  { key: 'complete',  label: 'Complete' },
];

const RISK_BADGE = {
  low:    { label: 'Low risk',    cls: 'text-green-400 bg-green-500/10 border-green-500/20' },
  medium: { label: 'Medium risk', cls: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20' },
  high:   { label: 'High risk',   cls: 'text-red-400 bg-red-500/10 border-red-500/20' },
};

function inferArtifactTypeFromPlan(plan) {
  const text = `${plan?.intent_type || ''} ${plan?.original_prompt || ''} ${JSON.stringify(plan?.extracted_data || {})}`.toLowerCase();
  if (text.includes('validation')) return 'validationRule';
  if (text.includes('report') || text.includes('dashboard')) return 'report';
  if (text.includes('permission set')) return 'permissionSet';
  if (text.includes('apex') || text.includes('class') || text.includes('trigger')) return 'apex';
  if (text.includes('flow') || text.includes('workflow') || text.includes('process builder')) return 'flow';
  return '';
}

function inferInputTypeFromPlan(plan) {
  const text = `${plan?.intent_type || ''} ${plan?.original_prompt || ''}`.toLowerCase();
  if (text.includes('workflow')) return 'workflowRule';
  if (text.includes('process builder')) return 'processBuilder';
  if (text.includes('xml')) return 'metadataXml';
  if (text.includes('apex class')) return 'apexClass';
  return 'english';
}

// ── Help tooltip definitions ──────────────────────────────────────────────────
const HELP = {
  org: {
    title: 'Target Org',
    body: 'The Salesforce org where the metadata will be deployed. Always test in a sandbox before deploying to production. SF Copilot will warn you if you select a production org.',
    tip: '💡 Best practice: validate in a sandbox, then promote to production.',
  },
  artifactType: {
    title: 'Metadata Type',
    body: 'What kind of Salesforce component to create or modify. If unsure, leave as Auto-detect — SF Copilot will infer the type from your description.',
    tip: '💡 Flows and Apex carry higher deployment risk and require a mandatory dry run.',
  },
  inputType: {
    title: 'Input Format',
    body: 'How you\'re providing your requirement. Use Plain English for new components. For existing components, load the metadata XML directly so SF Copilot modifies the real deployed version.',
    tip: '💡 Retrieve-and-modify is safer than creating from scratch — it preserves existing configuration.',
  },
  mode: {
    title: 'Create vs Edit Existing',
    body: 'Create New builds a component from scratch. Edit Existing retrieves a deployed component from your org, shows you what\'s there, and lets you describe the change — producing a targeted diff rather than a full replacement.',
    tip: '💡 Best practice: always prefer Edit Existing when the component already exists in the org.',
  },
  fullName: {
    title: 'Component API Name',
    body: 'The Salesforce API name of the existing component. Format: ObjectName.ComponentName for Validation Rules (e.g. Account.Require_Phone). Just the name for Flows, Reports, and Apex classes.',
    tip: '💡 Find the API name in Setup → Object Manager → Validation Rules, or use the Salesforce CLI.',
  },
  activate: {
    title: 'Activate After Deploy',
    body: 'For Flows: automatically activates the flow immediately after deployment. For Validation Rules: the rule becomes active on deploy regardless of this setting.',
    tip: '⚠️ Never activate directly in production without sandbox validation. SF Copilot deploys Flows as Draft by default.',
  },
  userInput: {
    title: 'Your Requirement',
    body: 'Describe what you need in plain English. Be specific: mention the object name, field names, business rule, and expected behavior. SF Copilot will ask clarifying questions before generating anything.',
    tip: '💡 Example: "Create a validation rule on Opportunity that blocks saving when CloseDate is in the past and Stage is Closed Won."',
  },
};

// ── Reusable components ───────────────────────────────────────────────────────

function Tooltip({ content }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        className="text-white/25 hover:text-white/60 transition"
        aria-label="Help"
      >
        <HelpCircle size={13} />
      </button>

      {visible && (
        <div className="absolute z-50 left-5 top-0 w-72 bg-[#1c1c1f] border border-white/15 rounded-xl p-4 shadow-2xl text-left">
          <p className="text-xs font-semibold text-white mb-1">{content.title}</p>
          <p className="text-xs text-white/55 leading-relaxed mb-2">{content.body}</p>
          {content.tip && (
            <p className="text-xs text-[#6366f1]/80 bg-[#6366f1]/10 rounded-lg px-3 py-2">{content.tip}</p>
          )}
        </div>
      )}
    </div>
  );
}

function FieldLabel({ label, help, required }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className="text-xs font-medium text-white/60">{label}</span>
      {required && <span className="text-[#6366f1] text-xs">*</span>}
      {help && <Tooltip content={help} />}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition"
    >
      {copied ? <><Check size={12} className="text-green-400" /> Copied</> : <><Copy size={12} /> Copy</>}
    </button>
  );
}

function CollapsibleSection({ icon: Icon, title, iconColor = 'text-white/50', children, defaultOpen = false, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-white/8 rounded-xl overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition">
        <div className="flex items-center gap-2">
          <Icon size={14} className={iconColor} />
          <span className={`text-xs font-semibold ${iconColor}`}>{title}</span>
          {badge && <span className="text-xs bg-white/8 text-white/40 px-2 py-0.5 rounded-full">{badge}</span>}
        </div>
        {open ? <ChevronUp size={14} className="text-white/20" /> : <ChevronDown size={14} className="text-white/20" />}
      </button>
      {open && <div className="px-4 pb-4 border-t border-white/6 pt-3">{children}</div>}
    </div>
  );
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
function inlineFormat(text) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={i} className="text-white font-semibold">{part.slice(2,-2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={i} className="bg-white/10 px-1 py-0.5 rounded text-xs font-mono text-[#6366f1]">{part.slice(1,-1)}</code>;
    return part;
  });
}

function MarkdownBlock({ text }) {
  if (!text) return null;
  return (
    <div className="space-y-0.5">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('### ')) return <h3 key={i} className="text-sm font-semibold text-white mt-4 mb-1">{line.slice(4)}</h3>;
        if (line.startsWith('## '))  return <h2 key={i} className="text-sm font-bold text-[#6366f1] mt-5 mb-2">{line.slice(3)}</h2>;
        if (line.startsWith('# '))   return <h1 key={i} className="text-base font-bold text-white mt-4 mb-2">{line.slice(2)}</h1>;
        if (line.startsWith('- ') || line.startsWith('* '))
          return <li key={i} className="text-sm text-white/65 ml-4 list-disc">{inlineFormat(line.slice(2))}</li>;
        if (line.startsWith('---'))  return <hr key={i} className="border-white/8 my-3" />;
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <p key={i} className="text-sm text-white/65 leading-relaxed">{inlineFormat(line)}</p>;
      })}
    </div>
  );
}

// ── Pipeline bar ──────────────────────────────────────────────────────────────
function PipelineBar({ stage }) {
  const stageIndex = PIPELINE_STAGES.findIndex(s => s.key === stage);
  return (
    <div className="flex items-center gap-0 mb-8 bg-[#27272a]/20 border border-white/8 rounded-2xl p-1.5 overflow-x-auto">
      {PIPELINE_STAGES.map((s, i) => {
        const done    = i < stageIndex;
        const active  = i === stageIndex;
        const pending = i > stageIndex;
        return (
          <div key={s.key} className="flex items-center flex-1 min-w-0">
            <div className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-medium transition ${
              active  ? 'bg-[#6366f1] text-white' :
              done    ? 'text-green-400' :
              'text-white/25'
            }`}>
              {done ? <CheckCircle size={11} /> : active ? <Zap size={11} /> : <div className="w-1.5 h-1.5 rounded-full bg-current opacity-40" />}
              <span className="hidden lg:inline">{s.label}</span>
            </div>
            {i < PIPELINE_STAGES.length - 1 && (
              <div className={`w-px h-4 mx-1 shrink-0 ${done ? 'bg-green-500/40' : 'bg-white/8'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Deploy stage log ──────────────────────────────────────────────────────────
function DeployStageLog({ log, questions, success, stage, claudeRepaired, artifactType, deployWithActivate }) {
  const stageIcons = { passed: '✅', fixed: '🔧', failed: '❌', error: '💥', skipped: '⏭' };
  const stageColors = { passed: 'text-green-400', fixed: 'text-blue-400', failed: 'text-red-400', error: 'text-red-400' };
  const steps = [
    { label: 'Preflight (local)', key: 'preflight' },
    { label: 'Dry Run (checkOnly)', key: 'dryrun' },
    { label: 'Auto-repair', key: 'repair' },
    { label: 'Deploy', key: 'deploy' },
  ];

  return (
    <div className="space-y-2">
      {/* Stage steps */}
      <div className="space-y-1.5 text-xs">
        {steps.map(({ label, key }) => {
          const entry = log?.find(l => l.step?.toLowerCase().includes(key));
          const status = entry?.status;
          return (
            <div key={label} className={`flex items-center gap-2 ${stageColors[status] || 'text-white/30'}`}>
              <span className="w-4 shrink-0">{stageIcons[status] || '○'}</span>
              <span>{label}</span>
              {entry?.detail && <span className="text-white/30 truncate">— {entry.detail}</span>}
            </div>
          );
        })}
      </div>

      {/* User input needed */}
      {questions?.length > 0 && (
        <div className="mt-3 border border-yellow-500/25 bg-yellow-500/5 rounded-xl p-4">
          <p className="text-xs font-semibold text-yellow-400 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={12} /> Action required
          </p>
          {questions.map((q, i) => <p key={i} className="text-xs text-yellow-200/75 mb-1">• {q}</p>)}
        </div>
      )}

      {/* Final verdict */}
      <div className={`text-xs font-medium px-4 py-3 rounded-xl flex items-center gap-2 ${
        success ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
      }`}>
        {success ? <CheckCircle size={14} /> : <XCircle size={14} />}
        <span>
          {success
            ? artifactType === 'flow'
              ? (deployWithActivate ? 'Deployed and activated' : 'Deployed as Draft — activate in Setup → Flows')
              : 'Deployed successfully'
            : `Blocked at ${stage || 'deploy'} stage`
          }
        </span>
        {claudeRepaired && <span className="text-white/35 ml-auto">auto-repaired</span>}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Generator() {
  const location = useLocation();
  const copilotPlan = location.state?.copilotPlan;
  const appliedPlanRef = useRef(false);
  const [user, setUser]   = useState(null);
  const [token, setToken] = useState('');
  const [orgs, setOrgs]   = useState([]);
  const [orgId, setOrgId] = useState('');

  // Mode
  const [mode, setMode]         = useState('create'); // 'create' | 'edit'
  const [inputType, setInputType]       = useState('english');
  const [artifactType, setArtifactType] = useState('');

  // Edit mode
  const [fullName, setFullName]       = useState('');
  const [retrieving, setRetrieving]   = useState(false);
  const [retrieved, setRetrieved]     = useState(null);

  // Input
  const [userInput, setUserInput] = useState('');

  // Phase 1
  const [sessionId, setSessionId]         = useState('');
  const [questions, setQuestions]         = useState('');
  const [answer, setAnswer]               = useState('');
  const [readyToGenerate, setReadyToGenerate] = useState(false);

  // Phase 2
  const [buildLog, setBuildLog]   = useState([]);
  const [generated, setGenerated] = useState(null);

  // Deploy
  const [deploying, setDeploying]         = useState(false);
  const [deployResult, setDeployResult]   = useState(null);
  const [activateOnDeploy, setActivateOnDeploy] = useState(false);

  // Report folders (auto-loaded when artifact type = report)
  const [reportFolders, setReportFolders]   = useState([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [foldersLoading, setFoldersLoading] = useState(false);

  const [questionsExpanded, setQuestionsExpanded] = useState(false);
  const [questionsFlash, setQuestionsFlash] = useState(false);
  const questionsRef = useRef(null);
  const deployRef = useRef(null);
  const outputRef = useRef(null);
  const answerRef = useRef(null);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    if (!copilotPlan || appliedPlanRef.current) return;
    appliedPlanRef.current = true;
    setMode('create');
    setInputType(inferInputTypeFromPlan(copilotPlan));
    setArtifactType(inferArtifactTypeFromPlan(copilotPlan));
    setUserInput(copilotPlan.original_prompt || copilotPlan.interpreted_summary || '');
    setQuestions('');
    setReadyToGenerate(false);
    setGenerated(null);
    setDeployResult(null);
    setError('');
  }, [copilotPlan]);

  // Derived state for pipeline
  const pipelineStage =
    deployResult?.success ? 'complete' :
    deployResult ? 'deploy' :
    deploying ? 'deploy' :
    generated ? 'preflight' :
    readyToGenerate ? 'generate' :
    questions ? 'review' :
    'describe';

  const selectedOrg = orgs.find(o => o.id === orgId);
  const isProduction = selectedOrg && !selectedOrg.instance_url?.match(/sandbox|scratch|develop|orgfarm|\.cs\d/i);
  const selectedArtifact = ARTIFACT_TYPES.find(t => t.value === artifactType);

  useEffect(() => {
    let alive = true;
    async function loadOrgs(u, t) {
      try {
        const { data } = await axios.get(`${API}/api/orgs`, { params: { userId: u.id }, headers: { Authorization: `Bearer ${t}` } });
        if (!alive) return;
        const list = data.orgs || [];
        setOrgs(list);
        setOrgId(prev => prev || list[0]?.id || '');
      } catch {}
    }
    supabase.auth.getSession().then(({ data: sd }) => {
      if (!alive) return;
      const u = sd.session?.user || null;
      const t = sd.session?.access_token || '';
      setUser(u); setToken(t);
      if (u) loadOrgs(u, t);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_e, session) => {
      if (!alive) return;
      const u = session?.user || null; const t = session?.access_token || '';
      setUser(u); setToken(t);
      if (u) loadOrgs(u, t);
    });
    return () => { alive = false; subscription?.unsubscribe(); };
  }, []);

  // Auto-scroll to output panel when generation completes
  useEffect(() => {
    if (generated && outputRef.current) {
      outputRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [generated]);

  useEffect(() => {
    if (!questions || !questionsRef.current) return;
    questionsRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!readyToGenerate) {
      window.setTimeout(() => answerRef.current?.focus(), 350);
    }
  }, [questions, readyToGenerate]);

  useEffect(() => {
    if (!deployResult?.success || !outputRef.current) return;
    outputRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [deployResult]);

  // Auto-load report folders when artifact type switches to 'report'
  useEffect(() => {
    if (artifactType !== 'report' || !orgId || !token) return;
    setFoldersLoading(true);
    axios.get(`${API}/api/generate/folders`, { headers: { Authorization: `Bearer ${token}` }, params: { orgId } })
      .then(({ data }) => { setReportFolders(data.folders || []); })
      .catch(() => {})
      .finally(() => setFoldersLoading(false));
  }, [artifactType, orgId, token]);

  async function handleRetrieve() {
    if (!fullName.trim() || !orgId) return;
    if (!artifactType) {
      setError('Select a metadata type before loading an existing component.');
      return;
    }
    setRetrieving(true); setError(''); setRetrieved(null);
    try {
      const type = artifactType;
      const { data } = await axios.post(`${API}/api/generate/retrieve`, { orgId, artifactType: type, fullName }, { headers: authHeaders });
      setRetrieved(data);
      setArtifactType(data.artifactType);
      setInputType('metadataXml');
      setUserInput(`Modify this existing ${data.artifactType}.

Component: ${data.fullName}

Current metadata:
\`\`\`${data.artifactType === 'apex' ? 'apex' : 'xml'}
${data.artifactXml}
\`\`\`

Requested change:
`);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally { setRetrieving(false); }
  }

  async function startGeneration() {
    if (mode === 'edit' && !artifactType) {
      setError('Select the metadata type before editing an existing component.');
      return;
    }
    if (mode === 'edit' && !retrieved) {
      setError('Load the existing component from the org before starting review.');
      return;
    }
    setLoading(true); setError('');
    setGenerated(null); setDeployResult(null); setBuildLog([]);
    setQuestions(''); setSessionId(''); setReadyToGenerate(false);
    try {
      const { data } = await axios.post(`${API}/api/generate/start`, {
        orgId, userInput, inputType, artifactType: artifactType || null,
        reportFolder: selectedFolder || undefined,
      }, { headers: authHeaders });
      setSessionId(data.sessionId);
      setQuestions(data.questions);
      setReadyToGenerate(!!data.readyToGenerate);
      setQuestionsExpanded(false);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally { setLoading(false); }
  }

  async function submitAnswer() {
    setLoading(true); setError('');
    try {
      const { data } = await axios.post(`${API}/api/generate/answer`, { sessionId, answer }, { headers: authHeaders });
      setAnswer('');
      setReadyToGenerate(!!data.readyToGenerate);
      if (data.readyToGenerate) {
        setQuestions('✅ All questions answered. Ready to generate.');
        setTimeout(() => questionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
      } else if (data.questions) {
        // New follow-up questions came back — scroll to them and flash
        setQuestions(data.questions);
        setQuestionsExpanded(true);
        setTimeout(() => {
          questionsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          setQuestionsFlash(true);
          setTimeout(() => setQuestionsFlash(false), 1500);
        }, 100);
      } else {
        // No questions and not ready — something unexpected, prompt to start over
        setError('SF Copilot needs more information but could not generate follow-up questions. Please try starting over.');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to send answer. Please try again.');
    } finally { setLoading(false); }
  }

  async function buildArtifact() {
    setLoading(true); setError('');
    setGenerated(null); setDeployResult(null); setBuildLog([]);
    try {
      const response = await fetch(`${API}/api/generate/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ orgId, sessionId, deploy: false }),
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const chunks = buf.split('\n\n'); buf = chunks.pop() || '';
        for (const chunk of chunks) {
          const event = chunk.match(/^event: (.+)$/m)?.[1];
          const raw   = chunk.match(/^data: (.+)$/m)?.[1];
          if (!event || !raw) continue;
          const payload = JSON.parse(raw);
          if (event === 'generated') setGenerated(payload);
          else if (event === 'error') setError(payload.message);
          else setBuildLog(prev => [...prev, { event, payload }]);
        }
      }
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  async function runDeploy() {
    if (!generated?.artifactXml) return;
    setDeploying(true); setDeployResult(null); setError('');
    try {
      const { data } = await axios.post(`${API}/api/generate/deploy`, {
        orgId,
        artifactXml:  generated.artifactXml,
        artifactType: generated.artifactType || artifactType || 'flow',
        apiName:      generated.apiName,
        activate:     activateOnDeploy,
        orgSchema:    generated.orgSchema || {},
      }, { headers: authHeaders });
      if (data.finalXml && data.finalXml !== generated.artifactXml) {
        setGenerated(prev => ({ ...prev, artifactXml: data.finalXml, apiName: data.finalName || prev?.apiName }));
      }
      setDeployResult(data);
    } catch (err) { setError(err.response?.data?.error || err.message); }
    finally { setDeploying(false); }
  }

  function reset() {
    setSessionId(''); setQuestions(''); setAnswer(''); setReadyToGenerate(false);
    setBuildLog([]); setGenerated(null); setDeployResult(null); setError('');
    setUserInput(''); setRetrieved(null); setMode('create'); setInputType('english');
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 overflow-auto">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Metadata Generator</h1>
            <p className="text-white/40 text-sm mt-1">Generate, validate, dry-run, and deploy Salesforce metadata safely.</p>
          </div>
          {(sessionId || generated) && (
            <button onClick={reset} className="inline-flex items-center gap-2 text-sm text-white/40 hover:text-white transition border border-white/10 px-4 py-2 rounded-xl">
              <RotateCcw size={14} /> Start over
            </button>
          )}
        </div>

        {/* Pipeline */}
        <PipelineBar stage={pipelineStage} />

        {/* Error */}
        {error && (
          <div className="mb-5 bg-red-500/10 border border-red-500/25 text-red-300 text-sm px-4 py-3 rounded-xl flex justify-between items-start gap-4">
            <div>
              {error.toLowerCase().includes('session') ? (
                <>
                  <p className="font-semibold text-red-200">Your review session expired.</p>
                  <p className="text-red-300/70 text-xs mt-1">This can happen if the page was open for a while or refreshed. Click <strong>Start over</strong> and run the architect review again — it only takes a moment.</p>
                </>
              ) : (
                <span>{error}</span>
              )}
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {error.toLowerCase().includes('session') && (
                <button onClick={reset} className="text-xs bg-white/10 hover:bg-white/20 text-white px-3 py-1.5 rounded-lg transition font-medium">
                  Start over
                </button>
              )}
              <button onClick={() => setError('')} className="text-red-400/50 hover:text-red-300 text-lg leading-none">×</button>
            </div>
          </div>
        )}

        {copilotPlan && (
          <div className="mb-5 bg-[#6366f1]/10 border border-[#6366f1]/25 rounded-2xl px-5 py-4">
            <div className="flex items-start gap-3">
              <Wand2 size={17} className="text-[#818cf8] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">Copilot plan loaded</p>
                <p className="text-xs text-white/45 mt-1">{copilotPlan.interpreted_summary || copilotPlan.original_prompt}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  <span className="text-[11px] bg-white/5 border border-white/10 text-white/45 px-2 py-0.5 rounded-md">
                    {ARTIFACT_TYPES.find(t => t.value === artifactType)?.label || 'Auto-detect'}
                  </span>
                  <span className="text-[11px] bg-white/5 border border-white/10 text-white/45 px-2 py-0.5 rounded-md">
                    {INPUT_TYPES.find(t => t.value === inputType)?.label || 'Plain English'}
                  </span>
                  {copilotPlan.risk_level && (
                    <span className="text-[11px] bg-amber-500/10 border border-amber-500/20 text-amber-300 px-2 py-0.5 rounded-md">
                      {copilotPlan.risk_level} risk
                    </span>
                  )}
                </div>
                {copilotPlan.missing_info?.length > 0 && (
                  <p className="text-xs text-yellow-300/80 mt-2">Missing details: {copilotPlan.missing_info.join(', ')}</p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="grid xl:grid-cols-[1fr_1fr] gap-6">

          {/* ── LEFT PANEL ─────────────────────────────────────────────────── */}
          <div className="space-y-4">

            {/* === COMPACT CONFIG BAR === */}
            <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-4 space-y-3">

              {/* Row 1: Org + Mode toggle */}
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <select
                    value={orgId}
                    onChange={e => setOrgId(e.target.value)}
                    className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#6366f1] transition"
                  >
                    {orgs.length === 0
                      ? <option value="">⚠ No orgs connected — go to Connected Orgs first</option>
                      : orgs.map(o => <option key={o.id} value={o.id}>{o.org_name}</option>)
                    }
                  </select>
                  {orgs.length === 0 && (
                    <a href="/orgs" className="mt-1.5 inline-flex items-center gap-1 text-xs text-[#6366f1] hover:underline">
                      Connect an org →
                    </a>
                  )}
                </div>
                {/* Mode toggle — compact with tooltip on Edit */}
                <div className="flex rounded-lg border border-white/12 overflow-hidden shrink-0" title="Create: build from scratch · Edit: load a deployed component and modify it">
                  {[
                    { key: 'create', icon: PlusCircle, label: 'Create new' },
                    { key: 'edit',   icon: Edit3,      label: 'Edit existing' },
                  ].map(({ key, icon: Icon, label }) => (
                    <button key={key} type="button"
                      onClick={() => { setMode(key); setRetrieved(null); setUserInput(''); }}
                      className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition whitespace-nowrap ${
                        mode === key
                          ? 'bg-[#6366f1] text-white'
                          : 'bg-[#111113] text-white/40 hover:text-white hover:bg-white/5'
                      }`}>
                      <Icon size={12} /> {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Row 2: Metadata type pills */}
              <div className="flex flex-wrap gap-1.5">
                {ARTIFACT_TYPES.map(t => {
                  const isSelected = artifactType === t.value;
                  const isDisabledItem = mode === 'edit' && !t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => { if (!isDisabledItem) setArtifactType(t.value); }}
                      disabled={isDisabledItem}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                        isSelected
                          ? 'bg-[#6366f1] border-[#6366f1] text-white'
                          : isDisabledItem
                          ? 'opacity-25 cursor-not-allowed border-white/8 text-white/30'
                          : 'border-white/12 text-white/50 hover:text-white hover:border-white/30 bg-white/3'
                      }`}
                    >
                      <span>{t.icon}</span> {t.label}
                      {t.risk === 'high' && isSelected && <span className="text-[9px] text-amber-300 ml-0.5">⚠</span>}
                    </button>
                  );
                })}
              </div>

              {/* Edit mode explainer */}
              {mode === 'edit' && (
                <div className="flex items-start gap-2 text-xs text-[#6366f1]/80 bg-[#6366f1]/8 border border-[#6366f1]/15 rounded-lg px-3 py-2">
                  <Edit3 size={11} className="mt-0.5 shrink-0" />
                  <span>
                    <strong className="text-[#6366f1]">Edit existing</strong> — retrieves a component already deployed in your org so you can describe a change. SF Copilot modifies the real XML rather than building from scratch.
                    <br /><span className="text-white/40">Enter the component's API name in the panel below to load it.</span>
                  </span>
                </div>
              )}

              {/* Warnings — only shown when relevant */}
              {isProduction && (
                <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/8 border border-amber-500/15 rounded-lg px-3 py-1.5">
                  <ShieldAlert size={11} /> Production org — dry run runs before every deploy.
                </div>
              )}
              {selectedArtifact?.risk === 'high' && (
                <div className="flex items-center gap-2 text-xs text-amber-300/70 bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-1.5">
                  <Zap size={11} /> {selectedArtifact.label} changes are high-risk — SF Copilot always dry-runs before deploying.
                </div>
              )}
            </div>

            {/* === SECTION: Edit existing — load component === */}
            {mode === 'edit' && (
              <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-6 space-y-4">
                <h2 className="text-sm font-semibold text-white/80 flex items-center gap-2">
                  <FileCode size={14} className="text-[#6366f1]" />
                  Load existing component from org
                </h2>
                <div>
                  <FieldLabel label="Component API Name" help={HELP.fullName} required />
                  <div className="flex gap-2">
                    <input
                      value={fullName}
                      onChange={e => setFullName(e.target.value)}
                      placeholder={artifactType === 'validationRule' ? 'Account.Require_Phone_for_Customers' : 'MyFlow or MyApexClass'}
                      className="flex-1 bg-[#111113] border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition"
                    />
                    <button
                      onClick={handleRetrieve}
                      disabled={retrieving || !orgId || !fullName.trim()}
                      className="inline-flex items-center gap-2 bg-[#6366f1]/20 hover:bg-[#6366f1]/30 border border-[#6366f1]/30 disabled:opacity-40 text-[#6366f1] font-medium px-4 py-2.5 rounded-xl text-sm transition"
                    >
                      {retrieving ? <Loader2 size={14} className="animate-spin" /> : <FileCode size={14} />}
                      Load
                    </button>
                  </div>
                </div>

                {retrieved && (
                  <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-4">
                    <div className="flex items-center gap-2 text-green-400 text-xs font-semibold mb-2">
                      <CheckCircle size={12} /> Loaded from org
                    </div>
                    <p className="text-xs text-white/60 font-mono">{retrieved.fullName}</p>
                    <CollapsibleSection icon={FileCode} title="Current XML" iconColor="text-white/40" defaultOpen={false}>
                      <pre className="text-xs font-mono text-white/60 bg-black/20 rounded-lg p-3 overflow-auto max-h-48">
                        {retrieved.artifactXml}
                      </pre>
                    </CollapsibleSection>
                  </div>
                )}
              </div>
            )}

            {/* === SECTION: Describe requirement — main action === */}
            <div className="bg-[#27272a]/15 border border-[#6366f1]/20 rounded-2xl p-6 space-y-4">
              <h2 className="text-sm font-semibold text-white/80 flex items-center gap-2">
                <Wand2 size={14} className="text-[#6366f1]" />
                What do you need?
              </h2>

              {/* Report folder picker — only shown when artifact type = report */}
              {artifactType === 'report' && (
                <div>
                  <FieldLabel
                    label="Report Folder"
                    required
                    help={{ title: 'Report Folder', body: 'Salesforce requires every report to belong to a folder. Select the folder where this report will be saved. You must have at least Viewer access to the folder.', tip: '💡 Use a team-specific folder for shared reports. Never deploy to the "My Personal Custom Reports" folder.' }}
                  />
                  {foldersLoading ? (
                    <div className="flex items-center gap-2 text-xs text-white/40 py-2">
                      <Loader2 size={12} className="animate-spin" /> Loading folders from org…
                    </div>
                  ) : reportFolders.length === 0 ? (
                    <p className="text-xs text-red-300/70">No report folders found. Ensure the org is connected and the user has access to at least one folder.</p>
                  ) : (
                    <select
                      value={selectedFolder}
                      onChange={e => setSelectedFolder(e.target.value)}
                      className="w-full bg-[#111113] border border-white/12 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#6366f1] transition"
                    >
                      <option value="">Select report folder…</option>
                      {reportFolders.map(f => (
                        <option key={f.id} value={f.developerName}>{f.name}</option>
                      ))}
                    </select>
                  )}
                  {!selectedFolder && !foldersLoading && reportFolders.length > 0 && (
                    <p className="text-xs text-amber-400/70 mt-1.5">⚠ You must select a folder before generating a report.</p>
                  )}
                </div>
              )}

              <div>
                <textarea
                  value={userInput}
                  onChange={e => setUserInput(e.target.value)}
                  rows={6}
                  placeholder={
                    mode === 'edit' && retrieved
                      ? `Describe the change you want to make to ${retrieved.fullName}…`
                      : inputType === 'metadataXml'
                      ? 'Paste the API name (e.g. Account.My_Rule) or the full XML — SF Copilot will retrieve the metadata automatically.'
                      : 'Be specific: mention the Salesforce object, field names, business rule, and expected behavior.\n\nExample: "Create a validation rule on Opportunity that prevents saving when CloseDate is in the past and Stage is Closed Won."'
                  }
                  className="w-full bg-[#111113] border border-white/12 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-[#6366f1] transition resize-none"
                />
                <div className="flex items-center justify-between mt-1.5">
                  <p className="text-xs text-white/25">SF Copilot will ask clarifying questions before generating anything.</p>
                  <span className="text-xs text-white/20">{userInput.length} chars</span>
                </div>
              </div>

              {/* Gray out once review is in progress */}
              {questions || readyToGenerate || generated ? (
                <div className="w-full flex items-center justify-center gap-2 bg-[#27272a]/40 border border-white/8 text-white/25 font-semibold px-5 py-3 rounded-xl text-sm cursor-not-allowed select-none">
                  <CheckCircle size={16} className="text-green-500/60" />
                  {readyToGenerate ? 'Review complete — generate when ready' : 'Review in progress'}
                </div>
              ) : (
                <LoadingButton
                  onClick={startGeneration}
                  disabled={!orgId || !userInput.trim() || (artifactType === 'report' && !selectedFolder)}
                  loadingText="Starting review…"
                  slowText="Analysing your org — almost there…"
                  slowThreshold={12000}
                  className="w-full justify-center"
                  variant="primary"
                >
                  <><Send size={16} /> Start Architect Review</>
                </LoadingButton>
              )}
            </div>

            {/* === SECTION: Q&A === */}
            {questions && (
              <div ref={questionsRef} className={`bg-[#27272a]/15 border rounded-2xl p-6 space-y-4 transition-all duration-300 ${questionsFlash ? 'border-[#6366f1] shadow-lg shadow-[#6366f1]/20' : 'border-[#6366f1]/20'}`}>
                <h2 className="text-sm font-semibold text-[#6366f1] flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-[#6366f1] text-white text-xs flex items-center justify-center font-bold">Q</span>
                  SF Copilot's Questions
                </h2>

                <div className={`bg-[#07111d] border border-white/8 rounded-xl p-4 overflow-y-auto transition-all ${questionsExpanded ? 'max-h-[70vh]' : 'max-h-72'}`}>
                  <MarkdownBlock text={questions} />
                </div>
                <button
                  onClick={() => setQuestionsExpanded(e => !e)}
                  className="text-xs text-white/30 hover:text-white/60 transition flex items-center gap-1 mt-1"
                >
                  {questionsExpanded
                    ? <><ChevronUp size={12} /> Collapse</>
                    : <><ChevronDown size={12} /> Expand for easier reading</>
                  }
                </button>

                {!readyToGenerate ? (
                  <>
                    <div>
                      <FieldLabel label="Your answers" />
                      <textarea
                        ref={answerRef}
                        value={answer}
                        onChange={e => setAnswer(e.target.value)}
                        rows={4}
                        placeholder="Answer each question above, then click Send Answer…"
                        className="w-full bg-[#111113] border border-white/12 rounded-xl px-4 py-3 text-sm text-white placeholder-white/20 focus:outline-none focus:border-[#6366f1] transition resize-none"
                      />
                    </div>
                    <LoadingButton
                      onClick={submitAnswer}
                      disabled={!answer.trim()}
                      loadingText="Sending answer…"
                      slowText="Still thinking…"
                      variant="ghost"
                    >
                      <><Send size={14} /> Send Answer</>
                    </LoadingButton>
                  </>
                ) : generated && generated.artifactXml ? (
                  // Generated with XML — show deploy CTA
                  <div className="w-full flex items-center justify-between bg-green-500/10 border border-green-500/25 px-4 py-3 rounded-xl">
                    <span className="text-sm text-green-300 flex items-center gap-2"><CheckCircle size={14}/> Artifact ready</span>
                    <button
                      onClick={() => deployRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                      className="text-sm font-semibold text-white bg-[#6366f1] hover:bg-[#4f46e5] px-4 py-1.5 rounded-lg transition flex items-center gap-1.5"
                    >
                      Next: Deploy <Rocket size={13}/>
                    </button>
                  </div>
                ) : generated && !generated.artifactXml ? (
                  // Generated but no XML — parsing failed
                  <div className="w-full bg-amber-500/10 border border-amber-500/25 px-4 py-3 rounded-xl space-y-2">
                    <p className="text-sm text-amber-300 font-medium">⚠ Plan generated but XML not produced — click Re-generate</p>
                    <LoadingButton
                      onClick={buildArtifact}
                      loadingText="Re-generating…"
                      slowText="Still generating…"
                      className="text-xs px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 rounded-lg"
                      variant="ghost"
                    >
                      <><RotateCcw size={12}/> Re-generate</>
                    </LoadingButton>
                  </div>
                ) : (
                  <LoadingButton
                    onClick={buildArtifact}
                    loadingText="Generating artifact…"
                    slowText="Still generating — Claude is being thorough…"
                    slowThreshold={15000}
                    className="w-full justify-center bg-green-600 hover:bg-green-700"
                    variant="primary"
                  >
                    <><Wand2 size={16} /> Generate Artifact</>
                  </LoadingButton>
                )}
              </div>
            )}
          </div>

          {/* ── RIGHT PANEL ────────────────────────────────────────────────── */}
          <div className="space-y-5" ref={outputRef}>

            {/* === NEXT STEP BANNER — appears after generation === */}
            {generated?.artifactXml && !deployResult && (
              <div className="bg-green-500/10 border border-green-500/25 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <CheckCircle size={18} className="text-green-400 shrink-0" />
                  <div>
                    <p className="text-sm font-semibold text-green-300">Artifact generated successfully</p>
                    <p className="text-xs text-green-300/60 mt-0.5">Review the XML below, then deploy to Salesforce when ready.</p>
                  </div>
                </div>
                <button
                  onClick={() => deployRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="shrink-0 inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition"
                >
                  <Rocket size={14} /> Go to Deploy →
                </button>
              </div>
            )}

            {deployResult?.success && (
              <div className="bg-green-500/10 border border-green-500/25 rounded-2xl px-5 py-4 flex items-center gap-3">
                <CheckCircle size={18} className="text-green-400 shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-green-300">Deployed to Salesforce ✓</p>
                  <p className="text-xs text-green-300/60 mt-0.5">Deployment completed. No extra verify page is required.</p>
                </div>
              </div>
            )}

            {/* === SECTION: Output === */}
            <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-6">
              <h2 className="text-sm font-semibold text-white/80 mb-4 flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-[#27272a] border border-white/15 text-white/40 text-xs flex items-center justify-center font-bold">G</span>
                Generated Output
              </h2>

              {/* Build progress */}
              {buildLog.length > 0 && !generated && (
                <div className="space-y-2 mb-4">
                  {buildLog.map((item, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs text-white/40">
                      <Loader2 size={10} className="animate-spin text-[#6366f1] shrink-0" />
                      {item.payload.message || item.event}
                    </div>
                  ))}
                </div>
              )}

              {!generated && buildLog.length === 0 && (
                <div className="text-center py-12 text-white/20 border border-dashed border-white/8 rounded-xl">
                  <Wand2 size={24} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Generated artifact will appear here</p>
                  <p className="text-xs mt-1">Complete the steps on the left to generate</p>
                </div>
              )}

              {generated && (
                <div className="space-y-4">
                  {/* API name + metadata type */}
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="font-mono text-sm text-[#6366f1] bg-[#6366f1]/10 border border-[#6366f1]/20 px-3 py-1 rounded-lg">
                      {generated.apiName}
                    </span>
                    {(generated.artifactType || artifactType) && (
                      <span className="text-xs text-white/40 bg-white/5 border border-white/10 px-3 py-1 rounded-lg capitalize">
                        {generated.artifactType || artifactType}
                      </span>
                    )}
                  </div>

                  {/* Plan */}
                  {generated.plan && (
                    <CollapsibleSection icon={BookOpen} title="Architect Plan" iconColor="text-blue-400" defaultOpen>
                      <MarkdownBlock text={generated.plan} />
                    </CollapsibleSection>
                  )}

                  {/* Artifact XML */}
                  {(generated.artifactXml || generated.artifactApex) && (
                    <CollapsibleSection icon={FileCode} title="Generated Artifact" iconColor="text-green-400" defaultOpen>
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-white/30 font-mono">
                          {(generated.artifactXml || generated.artifactApex)?.split('\n').length} lines
                        </span>
                        <div className="flex gap-3">
                          <CopyButton text={generated.artifactXml || generated.artifactApex} />
                          <button
                            onClick={() => {
                              const blob = new Blob([generated.artifactXml || generated.artifactApex], { type: 'text/xml' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a'); a.href = url;
                              a.download = `${generated.apiName || 'artifact'}.xml`; a.click();
                            }}
                            className="inline-flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition"
                          >
                            <Download size={12} /> Download
                          </button>
                        </div>
                      </div>
                      <pre className="max-h-80 overflow-auto bg-[#07111d] border border-white/8 rounded-xl p-4 text-xs text-white/75 font-mono leading-relaxed">
                        {generated.artifactXml || generated.artifactApex}
                      </pre>
                    </CollapsibleSection>
                  )}

                  {/* Decisions */}
                  {generated.decisions && (
                    <CollapsibleSection icon={ClipboardList} title="Decision Log" iconColor="text-purple-400">
                      <MarkdownBlock text={generated.decisions} />
                    </CollapsibleSection>
                  )}

                  {/* Checklist */}
                  {generated.checklist && (
                    <CollapsibleSection icon={CheckSquare} title="Pre-Deploy Checklist" iconColor="text-yellow-400">
                      <MarkdownBlock text={generated.checklist} />
                    </CollapsibleSection>
                  )}

                  {/* Warnings */}
                  {generated.warnings && (
                    <CollapsibleSection icon={AlertTriangle} title="Warnings" iconColor="text-orange-400">
                      <MarkdownBlock text={generated.warnings} />
                    </CollapsibleSection>
                  )}
                </div>
              )}
            </div>

            {/* === SECTION: Pipeline Steps (Preflight → Dry Run → Deploy) === */}
            {generated?.artifactXml && (
              <div ref={deployRef} className="space-y-3">

                {/* Step indicator */}
                {!deploying && !deployResult && (
                  <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5">
                    <p className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-4">Next steps</p>
                    <div className="flex items-center gap-2">
                      {[
                        { label: 'Preflight', desc: 'Local validation' },
                        { label: 'Dry Run', desc: 'Salesforce checkOnly' },
                        { label: 'Auto-repair', desc: 'If issues found' },
                        { label: 'Deploy', desc: 'Write to org' },
                      ].map((s, i) => (
                        <div key={s.label} className="flex items-center gap-2 flex-1">
                          <div className="flex-1 text-center">
                            <div className="w-7 h-7 rounded-full bg-[#27272a] border border-white/15 text-white/40 text-xs flex items-center justify-center mx-auto mb-1">{i + 1}</div>
                            <p className="text-xs font-medium text-white/50">{s.label}</p>
                            <p className="text-[10px] text-white/25">{s.desc}</p>
                          </div>
                          {i < 3 && <div className="w-6 h-px bg-white/10 shrink-0" />}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Options */}
                {!deployResult && !deploying && (
                  <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl px-5 py-4">
                    <FieldLabel label="Options" help={HELP.activate} />
                    <label className="flex items-center gap-2 cursor-pointer text-sm text-white/60 hover:text-white/80 transition mt-1">
                      <input type="checkbox" checked={activateOnDeploy} onChange={e => setActivateOnDeploy(e.target.checked)} className="accent-[#6366f1] w-4 h-4" />
                      Activate immediately after deploy
                    </label>
                    {isProduction && (
                      <p className="text-xs text-amber-400/70 mt-2 flex items-center gap-1"><AlertTriangle size={11} /> Production org — preflight and dry run are mandatory.</p>
                    )}
                  </div>
                )}

                {/* Running — live stage log */}
                {deploying && (
                  <div className="bg-[#27272a]/15 border border-[#6366f1]/20 rounded-2xl p-5 space-y-3">
                    <p className="text-xs font-semibold text-[#6366f1] uppercase tracking-wider">Running pipeline…</p>
                    {[
                      { label: 'Preflight — checking XML structure and field names', icon: '🔍' },
                      { label: 'Salesforce dry run — checkOnly deploy (no writes)', icon: '🧪' },
                      { label: 'Auto-repair — patching any issues found', icon: '🔧' },
                      { label: 'Deploying to Salesforce', icon: '🚀' },
                    ].map((s, i) => (
                      <div key={i} className="flex items-center gap-3 text-sm text-white/50">
                        <Loader2 size={12} className="animate-spin text-[#6366f1] shrink-0" />
                        <span>{s.icon} {s.label}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Result */}
                {deployResult && !deploying && (
                  <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5">
                    <DeployStageLog
                      log={deployResult.log}
                      questions={deployResult.questions}
                      success={deployResult.success}
                      stage={deployResult.stage}
                      claudeRepaired={deployResult.claudeRepairAttempted}
                      artifactType={generated?.artifactType || artifactType}
                      deployWithActivate={activateOnDeploy}
                    />
                  </div>
                )}

                {/* CTA button */}
                {!deployResult?.success && (
                  <LoadingButton
                    onClick={runDeploy}
                    loadingText="Running preflight, dry run & deploy…"
                    slowText="Waiting on Salesforce — this can take up to 2 min…"
                    slowThreshold={20000}
                    className={`w-full min-h-[56px] justify-center font-bold px-5 py-4 rounded-2xl border shadow-sm ${
                      isProduction
                        ? 'bg-amber-600 hover:bg-amber-700 text-white border-amber-400/30'
                        : 'bg-[#6366f1] hover:bg-[#4f46e5] text-white border-[#818cf8]/30'
                    }`}
                    variant="primary"
                  >
                    <><Rocket size={16} />
                    {deployResult ? 'Retry Full Pipeline' : isProduction ? 'Run Preflight + Dry Run + Deploy' : 'Run Preflight, Dry Run, Deploy'}</>
                  </LoadingButton>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
