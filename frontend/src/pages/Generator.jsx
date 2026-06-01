import { useEffect, useState } from 'react';
import { Loader2, Send, Sparkles, Wand2 } from 'lucide-react';
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
];

function Section({ title, children }) {
  return (
    <section className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl p-5">
      <h2 className="text-sm font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}

export default function Generator() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState('');
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState('');
  const [inputType, setInputType] = useState('english');
  const [artifactType, setArtifactType] = useState('');
  const [userInput, setUserInput] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [questions, setQuestions] = useState('');
  const [answer, setAnswer] = useState('');
  const [readyToGenerate, setReadyToGenerate] = useState(false);
  const [buildLog, setBuildLog] = useState([]);
  const [generated, setGenerated] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    let isMounted = true;

    supabase.auth.getSession().then(async ({ data: sessionData }) => {
      if (!isMounted) return;

      const currentUser = sessionData.session?.user || null;
      setUser(currentUser);
      setToken(sessionData.session?.access_token || '');

      if (currentUser) {
        const { data } = await axios.get(`${API}/api/orgs`, { params: { userId: currentUser.id } });
        if (!isMounted) return;
        const connectedOrgs = data.orgs || [];
        setOrgs(connectedOrgs);
        setOrgId(connectedOrgs[0]?.id || '');
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  async function startGeneration() {
    setLoading(true);
    setError('');
    setGenerated(null);
    setBuildLog([]);
    try {
      const { data } = await axios.post(`${API}/api/generate/start`, {
        orgId,
        userInput,
        inputType,
        artifactType: artifactType || null,
      }, { headers: authHeaders });

      setSessionId(data.sessionId);
      setQuestions(data.questions);
      setReadyToGenerate(false);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitAnswer() {
    setLoading(true);
    setError('');
    try {
      const { data } = await axios.post(`${API}/api/generate/answer`, {
        sessionId,
        answer,
      }, { headers: authHeaders });

      setAnswer('');
      setReadyToGenerate(Boolean(data.readyToGenerate));
      if (data.questions) setQuestions(data.questions);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }

  async function buildArtifact() {
    setLoading(true);
    setError('');
    setGenerated(null);
    setBuildLog([]);

    try {
      const response = await fetch(`${API}/api/generate/build`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: JSON.stringify({ orgId, sessionId, deploy: false }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() || '';

        for (const chunk of chunks) {
          const event = chunk.match(/^event: (.+)$/m)?.[1];
          const dataText = chunk.match(/^data: (.+)$/m)?.[1];
          if (!event || !dataText) continue;
          const payload = JSON.parse(dataText);
          if (event === 'generated') setGenerated(payload);
          else if (event === 'error') setError(payload.message);
          else setBuildLog((prev) => [...prev, { event, payload }]);
        }
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen bg-[#0f1e30] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8">
        <div className="flex items-start justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Artifact Generator</h1>
            <p className="text-white/40 text-sm mt-1">Ask, clarify, generate, and review Salesforce metadata.</p>
          </div>
          <div className="flex items-center gap-2 text-[#2E86AB] bg-[#2E86AB]/10 px-3 py-2 rounded-xl text-xs">
            <Sparkles size={14} /> Two-phase architect review
          </div>
        </div>

        {error && (
          <div className="mb-5 bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <div className="grid xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-5">
          <div className="space-y-5">
            <Section title="Request">
              <div className="grid sm:grid-cols-2 gap-3 mb-4">
                <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="bg-[#0f1e30] border border-white/15 rounded-xl px-3 py-2.5 text-sm">
                  {orgs.map((org) => <option key={org.id} value={org.id}>{org.org_name} ({org.org_type})</option>)}
                </select>
                <select value={artifactType} onChange={(e) => setArtifactType(e.target.value)} className="bg-[#0f1e30] border border-white/15 rounded-xl px-3 py-2.5 text-sm">
                  {ARTIFACT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
                <select value={inputType} onChange={(e) => setInputType(e.target.value)} className="sm:col-span-2 bg-[#0f1e30] border border-white/15 rounded-xl px-3 py-2.5 text-sm">
                  {INPUT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </div>
              <textarea
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                rows={8}
                placeholder="Example: Create a record-triggered Flow on Opportunity that creates a renewal task when Stage changes to Closed Won..."
                className="w-full bg-[#0f1e30] border border-white/15 rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#2E86AB] transition"
              />
              <button
                onClick={startGeneration}
                disabled={loading || !orgId || !userInput.trim()}
                className="mt-4 inline-flex items-center gap-2 bg-[#2E86AB] hover:bg-[#247496] disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                Start Review
              </button>
            </Section>

            {questions && (
              <Section title="Clarifying Questions">
                <pre className="whitespace-pre-wrap text-sm text-white/70 leading-relaxed">{questions}</pre>
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={5}
                  placeholder="Answer the questions here..."
                  className="mt-4 w-full bg-[#0f1e30] border border-white/15 rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#2E86AB] transition"
                />
                <div className="flex gap-3 mt-4">
                  <button
                    onClick={submitAnswer}
                    disabled={loading || !answer.trim()}
                    className="inline-flex items-center gap-2 bg-white/8 hover:bg-white/12 disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition"
                  >
                    {loading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                    Send Answer
                  </button>
                  <button
                    onClick={buildArtifact}
                    disabled={loading || !sessionId || !readyToGenerate}
                    className="inline-flex items-center gap-2 bg-[#2E86AB] hover:bg-[#247496] disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition"
                  >
                    <Wand2 size={16} />
                    Generate Artifact
                  </button>
                </div>
              </Section>
            )}
          </div>

          <div className="space-y-5">
            <Section title="Generation Output">
              {buildLog.length === 0 && !generated ? (
                <p className="text-white/35 text-sm">Generated XML, Apex, decisions, and warnings will appear here.</p>
              ) : (
                <div className="space-y-3">
                  {buildLog.map((item, idx) => (
                    <div key={`${item.event}-${idx}`} className="text-xs text-white/45 border border-white/8 rounded-lg px-3 py-2">
                      {item.payload.message || item.event}
                    </div>
                  ))}
                </div>
              )}

              {generated && (
                <div className="mt-5 space-y-4">
                  <div>
                    <p className="text-xs text-white/40 mb-1">API Name</p>
                    <p className="font-mono text-sm text-[#2E86AB]">{generated.apiName}</p>
                  </div>
                  {generated.plan && <pre className="whitespace-pre-wrap text-sm text-white/65">{generated.plan}</pre>}
                  {(generated.artifactXml || generated.artifactApex) && (
                    <pre className="max-h-[480px] overflow-auto bg-[#07111d] border border-white/8 rounded-xl p-4 text-xs text-white/75">
                      {generated.artifactXml || generated.artifactApex}
                    </pre>
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
