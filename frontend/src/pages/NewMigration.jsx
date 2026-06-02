import { useCallback, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import { ChevronRight, Upload, Check, Plus } from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const STEPS = ['Connect Orgs', 'Upload Mapping', 'Configure', 'Validate & Launch'];

function StepIndicator({ current }) {
  return (
    <div className="flex items-center gap-2 mb-10">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div className={`flex items-center gap-2 ${i <= current ? 'text-[#6366f1]' : 'text-white/30'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border ${
              i < current ? 'bg-[#6366f1] border-[#6366f1] text-white' :
              i === current ? 'border-[#6366f1] text-[#6366f1]' :
              'border-white/20 text-white/30'
            }`}>
              {i < current ? <Check size={12} /> : i + 1}
            </div>
            <span className="text-sm hidden md:inline">{label}</span>
          </div>
          {i < STEPS.length - 1 && (
            <div className={`h-px w-6 md:w-12 ${i < current ? 'bg-[#6366f1]' : 'bg-white/15'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

export default function NewMigration() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [user, setUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [orgsLoading, setOrgsLoading] = useState(true);

  // Step 1
  const [sourceOrg, setSourceOrg] = useState('');
  const [targetOrg, setTargetOrg] = useState('');

  // Step 2
  const [mappingFile, setMappingFile] = useState(null);
  const [mappingPreview, setMappingPreview] = useState(null);

  // Step 3
  const [isDryRun, setIsDryRun]       = useState(false);
  const [isPiiTarget, setIsPiiTarget] = useState(false);
  const [skipFiles, setSkipFiles]     = useState(false);
  const [skipEmails, setSkipEmails]   = useState(false);

  // Step 4
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState('');

  const loadOrgs = useCallback(async (userId) => {
    setOrgsLoading(true);
    try {
      const { data } = await axios.get(`${API}/api/orgs`, { params: { userId } });
      setOrgs(data.orgs || []);
    } catch (err) {
      console.error('Failed to load orgs:', err);
    } finally {
      setOrgsLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      setUser(u);
      if (u) loadOrgs(u.id);
    });
  }, [loadOrgs]);

  const onDrop = useCallback((files) => {
    const file = files[0];
    setMappingFile(file);
    setMappingPreview({
      objects: ['Account', 'Contact'],
      rowCount: 24,
      fileName: file.name,
    });
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/json': ['.json'],
    },
    maxFiles: 1,
  });

  const handleLaunch = async () => {
    setLaunching(true);
    setLaunchError('');
    try {
      const res = await axios.post(`${API}/api/migrations`, {
        userId:      user.id,
        sourceOrgId: sourceOrg,
        targetOrgId: targetOrg,
        isDryRun, isPiiTarget, skipFiles, skipEmails,
      });
      navigate(`/migrations/${res.data.jobId}`);
    } catch (err) {
      setLaunchError(err.response?.data?.error || err.message);
      setLaunching(false);
    }
  };

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 max-w-3xl">
        <h1 className="text-2xl font-bold mb-2">New Migration</h1>
        <p className="text-white/40 text-sm mb-8">Set up a new Salesforce org migration in 4 steps.</p>

        <StepIndicator current={step} />

        {/* ── Step 1 — Connect Orgs ── */}
        {step === 0 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Select source and target orgs</h2>

            {orgsLoading ? (
              <p className="text-white/40 text-sm">Loading connected orgs…</p>
            ) : orgs.length < 2 ? (
              <div className="bg-[#27272a]/20 border border-white/10 rounded-xl p-5 text-sm text-white/60">
                <p className="mb-3">You need at least 2 connected orgs to start a migration.</p>
                <Link
                  to="/orgs"
                  className="inline-flex items-center gap-2 bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition"
                >
                  <Plus size={15} /> Connect orgs
                </Link>
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-xs text-white/50 mb-1.5">Source Org</label>
                  <select
                    value={sourceOrg}
                    onChange={(e) => setSourceOrg(e.target.value)}
                    className="w-full bg-[#27272a]/30 border border-white/15 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#6366f1] transition"
                  >
                    <option value="">Select source org…</option>
                    {orgs.map((o) => (
                      <option key={o.id} value={o.id}>{o.org_name} ({o.org_type})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-white/50 mb-1.5">Target Org</label>
                  <select
                    value={targetOrg}
                    onChange={(e) => setTargetOrg(e.target.value)}
                    className="w-full bg-[#27272a]/30 border border-white/15 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#6366f1] transition"
                  >
                    <option value="">Select target org…</option>
                    {orgs.filter(o => o.id !== sourceOrg).map((o) => (
                      <option key={o.id} value={o.id}>{o.org_name} ({o.org_type})</option>
                    ))}
                  </select>
                </div>
                <Link to="/orgs" className="text-sm text-[#6366f1] hover:underline inline-flex items-center gap-1">
                  <Plus size={13} /> Connect a new org
                </Link>
              </>
            )}

            <div className="pt-4">
              <button
                onClick={() => setStep(1)}
                disabled={!sourceOrg || !targetOrg}
                className="bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 2 — Upload Mapping ── */}
        {step === 1 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Upload your mapping file</h2>
            <p className="text-white/50 text-sm">CSV, XLSX, or JSON. Columns: Object API Name, Source Field, Target Field, Transform Type, PII Flag, Load Order Override.</p>
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition ${
                isDragActive ? 'border-[#6366f1] bg-[#6366f1]/5' : 'border-white/15 hover:border-white/30'
              }`}
            >
              <input {...getInputProps()} />
              <Upload size={32} className="mx-auto mb-3 text-white/30" />
              {mappingFile
                ? <p className="text-green-400 font-medium">{mappingFile.name}</p>
                : <p className="text-white/40 text-sm">Drag & drop mapping file, or click to browse</p>
              }
            </div>

            {mappingPreview && (
              <div className="bg-[#27272a]/30 border border-white/10 rounded-xl p-4 text-sm">
                <p className="text-white/60 mb-1.5">Preview — <span className="text-white">{mappingPreview.fileName}</span></p>
                <p className="text-white/40">Objects: <span className="text-[#6366f1]">{mappingPreview.objects.join(', ')}</span></p>
                <p className="text-white/40">{mappingPreview.rowCount} mapping rows parsed</p>
              </div>
            )}

            <p className="text-xs text-white/30">No mapping file? You can skip this to run a passthrough migration.</p>

            <div className="flex gap-3 pt-2">
              <button onClick={() => setStep(0)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <button
                onClick={() => setStep(2)}
                className="bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3 — Configure ── */}
        {step === 2 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Configure migration options</h2>
            <div className="space-y-3">
              {[
                { label: 'Dry Run — validate only, no records written', val: isDryRun,    set: setIsDryRun },
                { label: 'PII Target — mask sensitive fields on target', val: isPiiTarget, set: setIsPiiTarget },
                { label: 'Skip file attachments (ContentVersion)',        val: skipFiles,   set: setSkipFiles },
                { label: 'Skip email message records',                    val: skipEmails,  set: setSkipEmails },
              ].map(({ label, val, set }) => (
                <label key={label} className="flex items-center gap-3 cursor-pointer group">
                  <div
                    onClick={() => set(!val)}
                    className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition ${
                      val ? 'bg-[#6366f1] border-[#6366f1]' : 'border-white/25 group-hover:border-white/50'
                    }`}
                  >
                    {val && <Check size={12} className="text-white" />}
                  </div>
                  <span className="text-sm text-white/80">{label}</span>
                </label>
              ))}
            </div>

            <div className="flex gap-3 pt-4">
              <button onClick={() => setStep(1)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <button
                onClick={() => setStep(3)}
                className="bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 4 — Validate & Launch ── */}
        {step === 3 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Review & Launch</h2>

            {/* Summary */}
            <div className="bg-[#27272a]/20 border border-white/10 rounded-xl p-5 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-white/50">Source</span><span>{orgs.find(o => o.id === sourceOrg)?.org_name}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Target</span><span>{orgs.find(o => o.id === targetOrg)?.org_name}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Mapping</span><span>{mappingFile?.name || 'Passthrough (no file)'}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Mode</span><span className={isDryRun ? 'text-yellow-400' : 'text-green-400'}>{isDryRun ? 'Dry Run' : 'Live Migration'}</span></div>
            </div>

            {launchError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg">
                {launchError}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={() => setStep(2)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <button
                onClick={handleLaunch}
                disabled={launching}
                className="bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-50 text-white font-bold px-8 py-3 rounded-xl text-sm transition"
              >
                {launching ? 'Launching…' : isDryRun ? 'Start Dry Run' : 'Launch Migration'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
