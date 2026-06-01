import { useEffect, useState } from 'react';
import {
  Loader2, Send, Sparkles, Wand2, Rocket, ChevronDown, ChevronUp,
  CheckSquare, AlertTriangle, FileCode, ClipboardList, BookOpen
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const ARTIFACT_TYPES = [
  { value: '', label: 'Let OrgIQ decide' },
  { value: 'flow', label: 'Flow' },
  { value: 'report', label: 'Report' },
  { value: 'apex', label: 'Apex' },
  { value: 'validationRule', label: 'Validation Rule' },
  { value: 'permissionSet', label: 'Permission Set' },
];

const INPUT_TYPES = [
  { value: 'english', label: 'Plain English' },
  { value: 'workflowRule', label: 'Workflow Rule XML' },
  { value: 'processBuilder', label: 'Process Builder XML' },
  { value: 'apexClass', label: 'Apex Class' },
  { value: 'reportXml', label: 'Report XML' },
  { value: 'metadataXml', label: 'Existing Metadata XML' },
];

// ── Lightweight markdown renderer (no extra deps) ─────────────────────────────
function inlineFormat(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**'))
      return <strong key={idx} className="text-white font-semibold">{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <code key={idx} className="bg-white/10 px-1 py-0.5 rounded text-xs font-mono text-[#2E86AB]">{part.slice(1, -1)}</code>;
    return part;
  });
}

function MarkdownBlock({ text }) {
  if (!text) return null;
  return (
    <div className="space-y-0.5">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('### '))
          return <h3 key={i} className="text-sm font-semibold text-white mt-4 mb-1">{line.slice(4)}</h3>;
        if (line.startsWith('## '))
          return <h2 key={i} className="text-sm font-bold text-[#2E86AB] mt-5 mb-2">{line.slice(3)}</h2>;
        if (line.startsWith('# '))
          return <h1 key={i} className="text-base font-bold text-white mt-4 mb-2">{line.slice(2)}</h1>;
        if (line.startsWith('- ') || line.startsWith('* '))
          return <li key={i} className="text-sm text-white/70 ml-4 list-disc">{inlineFormat(line.slice(2))}</li>;
        if (line.startsWith('---'))
          return <hr key={i} className="border-white/10 my-3" />;
        if (line.trim() === '')
          return <div key={i} className="h-1" />;
        return <p key={i} className="text-sm text-white/70 leading-relaxed">{inlineFormat(line)}</p>;
      })}
    </div>
  );
}

// ── Collapsible output section ────────────────────────────────────────────────
function OutputSection({ icon: Icon, title, color = 'text-white/60', children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-white/8 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/4 transition"
      >
        <div className="flex items-center gap-2">
          <Icon size={14} className={color} />
          <span className={`text-xs font-semibold ${color}`}>{title}</span>
        </div>
        {open ? <ChevronUp size={14} className="text-white/30" /> : <ChevronDown size={14} className="text-white/30" />}
      </button>
      {open && <div className="px-4 pb-4 border-t border-white/8 pt-3">{children}</div>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl p-5">
      <h2 className="text-sm font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Generator() {
  const [user, setUser]       = useState(null);
  const [token, setToken]     = useState('');
  const [orgs, setOrgs]       = useState([]);
  const [orgId, setOrgId]     = useState('');
  const [inputType, setInputType]       = useState('english');
  const [artifactType, setArtifactType] = useState('');
  const [userInput, setUserInput]       = useState('');
  const [existingFullName, setExistingFullName] = useState('Account.Require_Phone_for_Customer_Accounts');
  const [retrieving, setRetrieving] = useState(false);
  const [retrievedArtifact, setRetrievedArtifact] = useState(null);

  // Phase 1
  const [sessionId, setSessionId]             = useState('');
  const [questions, setQuestions]             = useState('');
  const [answer, setAnswer]                   = useState('');
  const [readyToGenerate, setReadyToGenerate] = useState(false);

  // Phase 2
  const [buildLog, setBuildLog]   = useState([]);
  const [generated, setGenerated] = useState(null);

  // Deploy
  const [deploying, setDeploying]                 = useState(false);
  const [deployResult, setDeployResult]           = useState(null);
  const [deployWithActivate, setDeployWithActivate] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(async ({ data: sd }) => {
      if (!alive) return;
      const u = sd.session?.user || null;
      setUser(u);
      setToken(sd.session?.access_token || '');
      if (u) {
        const { data } = await axios.get(`${API}/api/orgs`, { params: { userId: u.id } });
        if (!alive) return;
        const list = data.orgs || [];
        setOrgs(list);
        setOrgId(list[0]?.id || '');
      }
    });
    return () => { alive = false; };
  }, []);

  async function retrieveExistingArtifact() {
    setRetrieving(true);
    setError('');
    setRetrievedArtifact(null);
    try {
      const selectedArtifactType = artifactType || 'validationRule';
      const { data } = await axios.post(`${API}/api/generate/retrieve`, {
        orgId,
        artifactType: selectedArtifactType,
        fullName: existingFullName,
      }, { headers: authHeaders });

      setArtifactType(data.artifactType);
      setInputType('metadataXml');
      setRetrievedArtifact(data);
      setUserInput(`Modify this existing Salesforce ${data.artifactType}.

Requested change:
Update the phone validation so Phone cannot be blank and cannot be an obvious placeholder. Reject all-zero phone numbers and ask me any follow-up questions needed before changing country-code, length, extension, or international-format behavior.

Existing component fullName:
${data.fullName}

Existing metadata XML:
\`\`\`xml
${data.artifactXml}
\`\`\``);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setRetrieving(false);
    }
  }

  // ── Phase 1: Start ──────────────────────────────────────────────────────────
  async function startGeneration() {
    setLoading(true);
    setError('');
    setGenerated(null);
    setDeployResult(null);
    setBuildLog([]);
    setQuestions('');
    setSessionId('');
    setReadyToGenerate(false);
    try {
      const { data } = await axios.post(`${API}/api/generate/start`, {
        orgId, userInput, inputType, artifactType: artifactType || null,
      }, { headers: authHeaders });
      setSessionId(data.sessionId);
      setQuestions(data.questions);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Phase 1: Answer ─────────────────────────────────────────────────────────
  async function submitAnswer() {
    setLoading(true);
    setError('');
    try {
      const { data } = await axios.post(`${API}/api/generate/answer`, {
        sessionId, answer,
      }, { headers: authHeaders });

      setAnswer('');
      const ready = Boolean(data.readyToGenerate);
      setReadyToGenerate(ready);

      if (data.questions) {
        setQuestions(data.questions);
      } else if (ready) {
        setQuestions('✅ All questions answered. Click **Generate Artifact** to build.');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Phase 2: Build via SSE ──────────────────────────────────────────────────
  async function buildArtifact() {
    setLoading(true);
    setError('');
    setGenerated(null);
    setDeployResult(null);
    setBuildLog([]);
    try {
      const response = await fetch(`${API}/api/generate/build`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ orgId, sessionId, deploy: false }),
      });

      const reader  = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const event    = chunk.match(/^event: (.+)$/m)?.[1];
          const dataText = chunk.match(/^data: (.+)$/m)?.[1];
          if (!event || !dataText) continue;
          const payload = JSON.parse(dataText);
          if (event === 'generated') setGenerated(payload);
          else if (event === 'error') setError(payload.message);
          else setBuildLog(prev => [...prev, { event, payload }]);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Deploy ──────────────────────────────────────────────────────────────────
  async function deployArtifact() {
    if (!generated?.artifactXml) return;
    setDeploying(true);
    setDeployResult(null);
    setError('');
    try {
      const { data } = await axios.post(`${API}/api/generate/deploy`, {
        orgId,
        artifactXml:  generated.artifactXml,
        artifactType: generated.artifactType || artifactType || 'flow',
        apiName:      generated.apiName,
        activate:     deployWithActivate,
      }, { headers: authHeaders });
      if (data.repairedArtifactXml) {
        setGenerated(prev => ({
          ...prev,
          artifactXml: data.repairedArtifactXml,
          apiName: data.repairedApiName || prev?.apiName,
        }));
      }
      setDeployResult(data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setDeploying(false);
    }
  }

  function resetAll() {
    setSessionId(''); setQuestions(''); setAnswer(''); setReadyToGenerate(false);
    setBuildLog([]); setGenerated(null); setDeployResult(null); setError(''); setUserInput('');
    setRetrievedArtifact(null);
  }

  function deploySuccessMessage() {
    if (generated?.artifactType === 'flow') {
      return deployWithActivate
        ? 'Deployed successfully and activated'
        : 'Deployed successfully as Draft — activate in Setup → Flows';
    }
    return 'Deployed successfully';
  }

  // ── UI ──────────────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen bg-[#0f1e30] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 overflow-auto">

        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Artifact Generator</h1>
            <p className="text-white/40 text-sm mt-1">Describe what you need — OrgIQ architects, questions, and builds it.</p>
          </div>
          <div className="flex items-center gap-2 text-[#2E86AB] bg-[#2E86AB]/10 px-3 py-2 rounded-xl text-xs">
            <Sparkles size={14} /> Two-phase architect review
          </div>
        </div>

        {error && (
          <div className="mb-5 bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg flex justify-between items-start">
            <span>{error}</span>
            <button onClick={() => setError('')} className="ml-4 text-red-400/60 hover:text-red-400 text-lg leading-none">×</button>
          </div>
        )}

        <div className="grid xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-5">

          {/* LEFT */}
          <div className="space-y-5">

            <Section title="1. Describe your requirement">
              <div className="grid sm:grid-cols-2 gap-3 mb-4">
                <select value={orgId} onChange={e => setOrgId(e.target.value)}
                  className="bg-[#0f1e30] border border-white/15 rounded-xl px-3 py-2.5 text-sm">
                  {orgs.length === 0
                    ? <option value="">No orgs connected</option>
                    : orgs.map(o => <option key={o.id} value={o.id}>{o.org_name} ({o.org_type})</option>)}
                </select>
                <select value={artifactType} onChange={e => setArtifactType(e.target.value)}
                  className="bg-[#0f1e30] border border-white/15 rounded-xl px-3 py-2.5 text-sm">
                  {ARTIFACT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <select value={inputType} onChange={e => setInputType(e.target.value)}
                  className="sm:col-span-2 bg-[#0f1e30] border border-white/15 rounded-xl px-3 py-2.5 text-sm">
                  {INPUT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>

              <div className="mb-4 border border-white/8 rounded-xl p-4 bg-[#07111d]/60">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <p className="text-sm font-semibold text-white/80">Edit existing metadata</p>
                    <p className="text-xs text-white/35 mt-1">Load a deployed component, then ask OrgIQ to revise it.</p>
                  </div>
                  <span className="text-[11px] text-white/35 bg-white/5 px-2 py-1 rounded">Validation rules now</span>
                </div>
                <div className="grid sm:grid-cols-[minmax(0,1fr)_auto] gap-3">
                  <input
                    value={existingFullName}
                    onChange={e => setExistingFullName(e.target.value)}
                    placeholder="Account.Require_Phone_for_Customer_Accounts"
                    className="bg-[#0f1e30] border border-white/15 rounded-xl px-3 py-2.5 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#2E86AB] transition"
                  />
                  <button
                    onClick={retrieveExistingArtifact}
                    disabled={retrieving || !orgId || !existingFullName.trim()}
                    className="inline-flex items-center justify-center gap-2 bg-white/8 hover:bg-white/12 disabled:opacity-40 text-white font-semibold px-4 py-2.5 rounded-xl text-sm transition"
                  >
                    {retrieving ? <Loader2 size={16} className="animate-spin" /> : <FileCode size={16} />}
                    Load Existing
                  </button>
                </div>
                {retrievedArtifact && (
                  <p className="mt-3 text-xs text-green-400">
                    Loaded {retrievedArtifact.fullName}. Add or adjust the requested change below, then start review.
                  </p>
                )}
              </div>

              <textarea
                value={userInput}
                onChange={e => setUserInput(e.target.value)}
                rows={7}
                placeholder="Example: Create a record-triggered Flow on Opportunity that creates a renewal task when Stage changes to Closed Won..."
                className="w-full bg-[#0f1e30] border border-white/15 rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#2E86AB] transition"
              />

              <div className="flex gap-3 mt-4">
                <button onClick={startGeneration} disabled={loading || !orgId || !userInput.trim()}
                  className="inline-flex items-center gap-2 bg-[#2E86AB] hover:bg-[#247496] disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                  {loading && !questions ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  Start Review
                </button>
                {(sessionId || generated) && (
                  <button onClick={resetAll} className="text-white/40 hover:text-white/70 text-sm px-3 transition">
                    Start over
                  </button>
                )}
              </div>
            </Section>

            {/* Q&A */}
            {questions && (
              <Section title="2. Answer the questions">
                <div className="max-h-80 overflow-y-auto pr-1 mb-4 border border-white/6 rounded-xl p-4 bg-[#07111d]">
                  <MarkdownBlock text={questions} />
                </div>

                {!readyToGenerate && (
                  <>
                    <textarea
                      value={answer}
                      onChange={e => setAnswer(e.target.value)}
                      rows={5}
                      placeholder="Answer all questions above, then click Send Answer..."
                      className="w-full bg-[#0f1e30] border border-white/15 rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#2E86AB] transition"
                    />
                    <button onClick={submitAnswer} disabled={loading || !answer.trim()}
                      className="mt-3 inline-flex items-center gap-2 bg-white/8 hover:bg-white/12 disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                      {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                      Send Answer
                    </button>
                  </>
                )}

                {readyToGenerate && (
                  <button onClick={buildArtifact} disabled={loading}
                    className="mt-3 inline-flex items-center gap-2 bg-[#2E86AB] hover:bg-[#247496] disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
                    Generate Artifact
                  </button>
                )}
              </Section>
            )}
          </div>

          {/* RIGHT */}
          <div className="space-y-5">
            <Section title="3. Generated output">

              {buildLog.length > 0 && (
                <div className="space-y-2 mb-4">
                  {buildLog.map((item, idx) => (
                    <div key={idx} className="text-xs text-white/45 flex items-center gap-2">
                      <Loader2 size={10} className="animate-spin text-[#2E86AB]" />
                      {item.payload.message || item.event}
                    </div>
                  ))}
                </div>
              )}

              {!generated && buildLog.length === 0 && (
                <p className="text-white/30 text-sm">
                  Generated artifact, decisions, and checklist will appear here after Phase 2.
                </p>
              )}

              {generated && (
                <div className="space-y-3">

                  <div className="flex items-center gap-3">
                    <span className="text-xs text-white/40">API Name</span>
                    <span className="font-mono text-sm text-[#2E86AB] bg-[#2E86AB]/10 px-2 py-0.5 rounded">
                      {generated.apiName}
                    </span>
                  </div>

                  {generated.plan && (
                    <OutputSection icon={BookOpen} title="Generation Plan" color="text-blue-400" defaultOpen>
                      <MarkdownBlock text={generated.plan} />
                    </OutputSection>
                  )}

                  {(generated.artifactXml || generated.artifactApex) && (
                    <OutputSection icon={FileCode} title="Generated Artifact" color="text-green-400" defaultOpen>
                      <pre className="max-h-96 overflow-auto bg-[#07111d] border border-white/8 rounded-xl p-4 text-xs text-white/80 font-mono leading-relaxed">
                        {generated.artifactXml || generated.artifactApex}
                      </pre>
                      <button
                        onClick={() => navigator.clipboard.writeText(generated.artifactXml || generated.artifactApex)}
                        className="mt-2 text-xs text-white/40 hover:text-white/70 transition">
                        Copy to clipboard
                      </button>
                    </OutputSection>
                  )}

                  {generated.decisions && (
                    <OutputSection icon={ClipboardList} title="Decision Log" color="text-purple-400">
                      <MarkdownBlock text={generated.decisions} />
                    </OutputSection>
                  )}

                  {generated.checklist && (
                    <OutputSection icon={CheckSquare} title="Pre-Deploy Checklist" color="text-yellow-400">
                      <MarkdownBlock text={generated.checklist} />
                    </OutputSection>
                  )}

                  {generated.warnings && (
                    <OutputSection icon={AlertTriangle} title="Warnings" color="text-orange-400">
                      <MarkdownBlock text={generated.warnings} />
                    </OutputSection>
                  )}

                  {/* Deploy strip */}
                  {generated.artifactXml && (
                    <div className="border border-white/10 rounded-xl p-4 bg-[#07111d] space-y-3 mt-2">
                      <p className="text-xs text-white/50">
                        Artifact is <strong className="text-white/70">Draft</strong>. Review above, then deploy when ready.
                      </p>

                      <label className="flex items-center gap-2 text-xs text-white/60 cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={deployWithActivate}
                          onChange={e => setDeployWithActivate(e.target.checked)}
                          className="accent-[#2E86AB]"
                        />
                        Activate immediately after deploy
                      </label>

                      <button
                        onClick={deployArtifact}
                        disabled={deploying || deployResult?.success}
                        className="inline-flex items-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                        {deploying
                          ? <><Loader2 size={16} className="animate-spin" /> Deploying…</>
                          : <><Rocket size={16} /> Deploy to Salesforce</>}
                      </button>

                      {deployResult && (
                        <div className={`text-xs px-3 py-2 rounded-lg border ${
                          deployResult.success
                            ? 'bg-green-500/10 text-green-400 border-green-500/20'
                            : 'bg-red-500/10 text-red-400 border-red-500/20'
                        }`}>
                          {deployResult.success
                            ? `✅ ${deploySuccessMessage()}${deployResult.repairAttempted ? ' after automatic repair' : ''}`
                            : `❌ ${deployResult.error?.message || 'Deploy failed'}`}
                          {deployResult.repairAttempted && deployResult.originalError && (
                            <div className="mt-2 text-white/45">
                              First attempt failed: {deployResult.originalError.message || 'Salesforce rejected the original artifact'}.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                </div>
              )}
            </Section>
          </div>

        </div>
      </main>
    </div>
  );
}
