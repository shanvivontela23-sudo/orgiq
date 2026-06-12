import { useCallback, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useDropzone } from 'react-dropzone';
import LoadingButton from '../components/LoadingButton';
import {
  ChevronRight, Upload, Check, Plus, ArrowRightLeft,
  FileSpreadsheet, Loader2, Database,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ─── Steps ────────────────────────────────────────────────────────────────────
// Data load: Org → Object & Operation → Upload File → Review & Launch
// Org migration: Orgs → Mapping File → Configure → Review & Launch
const DATA_LOAD_STEPS  = ['Select Org', 'Object & Operation', 'Upload Data', 'Review & Launch'];
const MIGRATION_STEPS  = ['Select Orgs', 'Upload Mapping', 'Configure', 'Review & Launch'];

const SALESFORCE_OBJECTS = [
  'Account','Contact','Opportunity','Lead','Case','Task','Event',
  'Campaign','CampaignMember','Product2','Order','OrderItem',
  'Contract','Asset','ContentVersion','Quote','QuoteLineItem',
];

const LOAD_OPERATIONS = ['insert', 'update', 'upsert'];

// ─── Header detection for auto-suggesting object ────────────────────────────
const HEADER_TO_OBJECT = {
  firstname: 'Contact', lastname: 'Contact', email: 'Contact', mobilephone: 'Contact',
  salutation: 'Contact', title: 'Contact', department: 'Contact',
  closedate: 'Opportunity', stagename: 'Opportunity', amount: 'Opportunity',
  probability: 'Opportunity',
  leadstatus: 'Lead', leadsource: 'Lead', annualrevenue: 'Lead',
  casestatus: 'Case', casereason: 'Case', priority: 'Case', origin: 'Case',
  subject: 'Task', activitydate: 'Task',
  campaigntype: 'Campaign', startdate: 'Campaign', enddate: 'Campaign',
  productcode: 'Product2', family: 'Product2',
};

function detectSalesforceObject(fileName, headers = []) {
  const nameParts = fileName.replace(/\.\w+$/, '').toLowerCase().split(/[_\-\s]+/);
  const sfObjects = ['account','contact','opportunity','lead','case','task','event','campaign','product','order','contract','asset'];
  for (const part of nameParts) {
    const match = sfObjects.find(o => part.includes(o));
    if (match) return match.charAt(0).toUpperCase() + match.slice(1);
  }
  const scores = {};
  for (const h of headers) {
    const key = h.toLowerCase().replace(/[^a-z]/g, '');
    const obj = HEADER_TO_OBJECT[key];
    if (obj) scores[obj] = (scores[obj] || 0) + 1;
  }
  const winner = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return winner ? winner[0] : 'Account';
}

async function parseFilePreview(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        if (ext === 'csv') {
          const lines = e.target.result.trim().split('\n').filter(Boolean);
          const headers = lines[0] ? lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim()) : [];
          resolve({ rowCount: Math.max(0, lines.length - 1), headers });
        } else if (ext === 'xlsx' || ext === 'xls') {
          import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs').then(XLSX => {
            const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
            resolve({ rowCount: Math.max(0, rows.length - 1), headers: (rows[0] || []).map(String) });
          }).catch(() => resolve({ rowCount: 0, headers: [] }));
        } else {
          resolve({ rowCount: 0, headers: [] });
        }
      } catch {
        resolve({ rowCount: 0, headers: [] });
      }
    };
    if (ext === 'xlsx' || ext === 'xls') reader.readAsArrayBuffer(file);
    else reader.readAsText(file);
  });
}

// ─── Step indicator ───────────────────────────────────────────────────────────
function StepIndicator({ current, steps }) {
  return (
    <div className="flex items-center gap-2 mb-10">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div className={`flex items-center gap-2 ${i <= current ? 'text-[#6366f1]' : 'text-white/30'}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border ${
              i < current  ? 'bg-[#6366f1] border-[#6366f1] text-white' :
              i === current ? 'border-[#6366f1] text-[#6366f1]' :
              'border-white/20 text-white/30'
            }`}>
              {i < current ? <Check size={12} /> : i + 1}
            </div>
            <span className="text-sm hidden md:inline">{label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px w-6 md:w-10 ${i < current ? 'bg-[#6366f1]' : 'bg-white/15'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Pre-flight results panel ─────────────────────────────────────────────────
function PreflightPanel({ loading, result }) {
  if (!loading && !result) return null;
  return (
    <div className="rounded-2xl border border-white/10 overflow-hidden">
      <div className="px-4 py-3 bg-[#27272a]/40 flex items-center justify-between">
        <span className="text-xs font-semibold text-white/70 uppercase tracking-wider">Pre-flight Check</span>
        {loading
          ? <span className="text-xs text-white/40 flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Running…</span>
          : result && (
            <span className={`text-xs font-semibold ${result.passed ? 'text-green-400' : 'text-red-400'}`}>
              {result.passed ? '✓ Passed' : '✗ Failed'}
            </span>
          )
        }
      </div>
      {result && (
        <div className="divide-y divide-white/5">
          {result.errors?.map((e, i) => (
            <div key={i} className="px-4 py-3 bg-red-500/5 border-l-2 border-red-500">
              <p className="text-sm text-red-300 font-medium">{e.message}</p>
              {e.action && <p className="text-xs text-red-300/60 mt-1">{e.action}</p>}
            </div>
          ))}
          {result.warnings?.map((w, i) => (
            <div key={i} className="px-4 py-3 bg-yellow-500/5 border-l-2 border-yellow-500/50">
              <p className="text-sm text-yellow-200/80">{w.message}</p>
              {w.action && <p className="text-xs text-yellow-200/40 mt-1">{w.action}</p>}
            </div>
          ))}
          {result.info?.map((item, i) => (
            <div key={i} className="px-4 py-2">
              <p className="text-xs text-white/35">{item.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function NewMigration() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [user, setUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const [jobType, setJobType] = useState('org_migration');

  // Step 0
  const [sourceOrg, setSourceOrg] = useState('');
  const [targetOrg, setTargetOrg] = useState('');

  // Step 1 (data_load) — object + operation BEFORE file
  const [objectApiName, setObjectApiName]   = useState('Account');
  const [operation, setOperation]           = useState('insert');
  const [externalIdField, setExternalIdField] = useState('');

  // Step 2 (data_load) / Step 1 (migration) — file
  const [dataFile, setDataFile]         = useState(null);
  const [mappingFile, setMappingFile]   = useState(null);
  const [filePreview, setFilePreview]   = useState(null); // { rowCount, headers, fileName }

  // Pre-flight (only fires after object confirmed + file uploaded)
  const [preflight, setPreflight]             = useState(null);
  const [preflightLoading, setPreflightLoading] = useState(false);

  // Step 3 / Step 2 (migration) — configure
  const [isDryRun, setIsDryRun]       = useState(true);
  const [isPiiTarget, setIsPiiTarget] = useState(false);
  const [skipFiles, setSkipFiles]     = useState(false);
  const [skipEmails, setSkipEmails]   = useState(false);

  // Step 4 — launch
  const [launching, setLaunching]     = useState(false);
  const [launchError, setLaunchError] = useState('');

  const isDataLoad = jobType === 'data_load';
  const steps = isDataLoad ? DATA_LOAD_STEPS : MIGRATION_STEPS;

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

  // ── Preflight: only called explicitly, never auto-fires ───────────────────
  const runPreflight = useCallback(async () => {
    if (!targetOrg || !objectApiName || !filePreview?.headers?.length) return;
    setPreflightLoading(true);
    setPreflight(null);
    try {
      const { data } = await axios.post(`${API}/api/migrations/preflight`, {
        targetOrgId:     targetOrg,
        objectApiName,
        operation,
        externalIdField: externalIdField || '',
        csvHeaders:      filePreview.headers,
        rowCount:        filePreview.rowCount,
        dryRun:          true,
      });
      setPreflight(data);
    } catch (err) {
      setPreflight({
        passed: false,
        errors: [{ message: 'Pre-flight unavailable: ' + (err.response?.data?.error || err.message) }],
        warnings: [], info: [],
      });
    } finally {
      setPreflightLoading(false);
    }
  }, [targetOrg, objectApiName, operation, externalIdField, filePreview]);

  // ── File drop: just parse file, never trigger preflight automatically ─────
  const onDrop = useCallback(async (files) => {
    const file = files[0];
    if (!file) return;
    if (isDataLoad) {
      setDataFile(file);
    } else {
      setMappingFile(file);
    }
    setPreflight(null); // clear stale result when file changes
    const { rowCount, headers } = await parseFilePreview(file);
    setFilePreview({ rowCount, headers, fileName: file.name });
  }, [isDataLoad]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv':   ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/json': ['.json'],
    },
    maxFiles: 1,
  });

  // ── Launch ────────────────────────────────────────────────────────────────
  const handleLaunch = async () => {
    setLaunching(true);
    setLaunchError('');
    try {
      let res;
      if (isDataLoad && dataFile) {
        const formData = new FormData();
        formData.append('userId', user.id);
        formData.append('targetOrgId', targetOrg);
        formData.append('objectApiName', objectApiName);
        formData.append('operation', operation);
        formData.append('externalIdField', externalIdField || '');
        formData.append('dryRun', String(isDryRun));
        formData.append('dataFile', dataFile, dataFile.name);
        res = await axios.post(`${API}/api/migrations/upload`, formData, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      } else {
        res = await axios.post(`${API}/api/migrations`, {
          userId: user.id,
          sourceOrgId: isDataLoad ? null : sourceOrg,
          targetOrgId: targetOrg,
          mappingConfig: {
            jobType,
            objectApiName: isDataLoad ? objectApiName : undefined,
            operation:     isDataLoad ? operation : undefined,
            externalIdField: isDataLoad ? externalIdField : undefined,
            dataFile: isDataLoad && dataFile ? {
              name: dataFile.name, size: dataFile.size, type: dataFile.type,
              estimatedRows: filePreview?.rowCount || 0,
            } : undefined,
            mappingFile: mappingFile ? { name: mappingFile.name, size: mappingFile.size } : undefined,
          },
          isDryRun, isPiiTarget, skipFiles, skipEmails,
        });
      }
      navigate(`/migrations/${res.data.jobId}`);
    } catch (err) {
      setLaunchError(err.response?.data?.error || err.message);
      setLaunching(false);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 max-w-3xl">
        <h1 className="text-2xl font-bold mb-2">New Migration</h1>
        <p className="text-white/40 text-sm mb-8">Move data between orgs or load CSV data into one Salesforce org.</p>

        <StepIndicator current={step} steps={steps} />

        {/* ── STEP 0: Job type + Org selection ─────────────────────────────── */}
        {step === 0 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Choose job type</h2>
            <div className="grid md:grid-cols-2 gap-3">
              {[
                { type: 'org_migration', title: 'Source → Target Migration', desc: 'Move data between two connected Salesforce orgs.', icon: ArrowRightLeft },
                { type: 'data_load',    title: 'CSV / Data Load',            desc: 'Upload a CSV or XLSX and load records into one org.', icon: FileSpreadsheet },
              ].map(({ type, title, desc, icon: Icon }) => (
                <button
                  key={type}
                  onClick={() => {
                    setJobType(type);
                    setSourceOrg(''); setTargetOrg('');
                    setDataFile(null); setMappingFile(null);
                    setFilePreview(null); setPreflight(null);
                    setObjectApiName('Account'); setOperation('insert'); setExternalIdField('');
                  }}
                  className={`text-left border rounded-2xl p-5 transition ${
                    jobType === type ? 'border-[#6366f1] bg-[#6366f1]/10' : 'border-white/10 bg-[#27272a]/20 hover:border-white/20'
                  }`}
                >
                  <Icon size={22} className={jobType === type ? 'text-[#6366f1]' : 'text-white/35'} />
                  <p className="mt-3 font-semibold">{title}</p>
                  <p className="text-xs text-white/45 mt-1">{desc}</p>
                </button>
              ))}
            </div>

            <h2 className="text-lg font-semibold pt-2">{isDataLoad ? 'Select target org' : 'Select source and target orgs'}</h2>

            {orgsLoading ? (
              <p className="text-white/40 text-sm flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading orgs…</p>
            ) : orgs.length < (isDataLoad ? 1 : 2) ? (
              <div className="bg-[#27272a]/20 border border-white/10 rounded-xl p-5 text-sm text-white/60">
                <p className="mb-3">{isDataLoad ? 'You need at least 1 connected org.' : 'You need at least 2 connected orgs to migrate.'}</p>
                <Link to="/orgs" className="inline-flex items-center gap-2 bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                  <Plus size={15} /> Connect orgs
                </Link>
              </div>
            ) : (
              <>
                {!isDataLoad && (
                  <div>
                    <label className="block text-xs text-white/50 mb-1.5">Source Org</label>
                    <select value={sourceOrg} onChange={e => setSourceOrg(e.target.value)}
                      className="w-full bg-[#27272a]/30 border border-white/15 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#6366f1] transition">
                      <option value="">Select source org…</option>
                      {orgs.filter(o => o.org_type === 'source').map(o => <option key={o.id} value={o.id}>{o.org_name}</option>)}
                      {orgs.filter(o => o.org_type === 'source').length === 0 && <option disabled value="">No source orgs — set one in Connected Orgs</option>}
                    </select>
                  </div>
                )}
                <div>
                  <label className="block text-xs text-white/50 mb-1.5">Target Org</label>
                  <select value={targetOrg} onChange={e => setTargetOrg(e.target.value)}
                    className="w-full bg-[#27272a]/30 border border-white/15 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#6366f1] transition">
                    <option value="">Select target org…</option>
                    {orgs.filter(o => o.org_type === 'target' && o.id !== sourceOrg).map(o => <option key={o.id} value={o.id}>{o.org_name}</option>)}
                    {orgs.filter(o => o.org_type === 'target').length === 0 && <option disabled value="">No target orgs — set one in Connected Orgs</option>}
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
                disabled={!targetOrg || (!isDataLoad && !sourceOrg)}
                className="bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 1 (data_load): Choose object + operation BEFORE file ────── */}
        {step === 1 && isDataLoad && (
          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">What are you loading?</h2>
              <p className="text-white/45 text-sm mt-1">Choose the Salesforce object and operation before uploading your file. This is used to validate your data against the org's schema.</p>
            </div>

            <div className="bg-[#1e1e21] border border-[#6366f1]/30 rounded-2xl p-6 space-y-5">
              {/* Object selector */}
              <div>
                <label className="block text-sm font-medium text-white mb-2">
                  <span className="flex items-center gap-2"><Database size={14} className="text-[#6366f1]" /> Salesforce Object <span className="text-[#6366f1]">*</span></span>
                </label>
                <select
                  value={objectApiName}
                  onChange={e => setObjectApiName(e.target.value)}
                  className="w-full bg-[#27272a]/60 border border-white/20 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#6366f1] transition"
                >
                  {SALESFORCE_OBJECTS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                <p className="text-xs text-white/35 mt-1.5">The Salesforce object you want to insert/update records into.</p>
              </div>

              {/* Operation selector */}
              <div>
                <label className="block text-sm font-medium text-white mb-2">Operation <span className="text-[#6366f1]">*</span></label>
                <div className="grid grid-cols-3 gap-2">
                  {LOAD_OPERATIONS.map(op => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => { setOperation(op); if (op !== 'upsert') setExternalIdField(''); }}
                      className={`py-2.5 rounded-xl text-sm font-medium border transition capitalize ${
                        operation === op
                          ? 'bg-[#6366f1] border-[#6366f1] text-white'
                          : 'bg-white/5 border-white/15 text-white/60 hover:border-white/30 hover:text-white'
                      }`}
                    >
                      {op}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-white/35 mt-2">
                  {operation === 'insert'  && 'Creates new records. Existing records are not affected.'}
                  {operation === 'update'  && 'Updates existing records by Salesforce ID. Records must already exist.'}
                  {operation === 'upsert'  && 'Inserts new records or updates existing ones using an External ID field.'}
                </p>
              </div>

              {/* External ID (upsert only) */}
              {operation === 'upsert' && (
                <div>
                  <label className="block text-sm font-medium text-white mb-2">External ID Field <span className="text-[#6366f1]">*</span></label>
                  <input
                    value={externalIdField}
                    onChange={e => setExternalIdField(e.target.value)}
                    placeholder="e.g. External_Id__c or Id"
                    className="w-full bg-[#27272a]/60 border border-white/20 rounded-xl px-4 py-3 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition"
                  />
                  <p className="text-xs text-white/35 mt-1.5">Must be marked as an External ID in Salesforce, or use <code className="bg-white/10 px-1 rounded">Id</code> for Salesforce IDs.</p>
                </div>
              )}
            </div>

            {/* Summary of what will happen */}
            <div className="bg-[#27272a]/15 border border-white/8 rounded-xl px-5 py-4 text-sm">
              <p className="text-white/50 text-xs font-medium mb-2 uppercase tracking-wider">What happens next</p>
              <p className="text-white/70">
                You'll upload your CSV or XLSX file. SF Copilot will validate each column against the
                <span className="text-[#6366f1] font-medium"> {objectApiName}</span> schema in your org
                and run a pre-flight check before any data is written.
              </p>
            </div>

            <div className="flex gap-3 pt-2">
              <button onClick={() => setStep(0)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <button
                onClick={() => setStep(2)}
                disabled={operation === 'upsert' && !externalIdField.trim()}
                className="bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2"
              >
                Next — Upload File <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 1 (org_migration): Upload mapping file ───────────────────── */}
        {step === 1 && !isDataLoad && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Upload mapping file</h2>
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
            {filePreview && (
              <div className="bg-[#27272a]/30 border border-white/10 rounded-xl p-4 text-sm">
                <p className="text-white/60 mb-1">{filePreview.fileName}</p>
                <p className="text-white/40">{filePreview.rowCount.toLocaleString()} mapping rows</p>
              </div>
            )}
            <p className="text-xs text-white/30">No mapping file? You can skip this to run a passthrough migration.</p>

            <div className="flex gap-3 pt-2">
              <button onClick={() => setStep(0)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <button onClick={() => setStep(2)}
                className="bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2">
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2 (data_load): Upload file + run pre-flight ─────────────── */}
        {step === 2 && isDataLoad && (
          <div className="space-y-5">
            {/* Object/op summary — read only */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-xl px-5 py-3 flex items-center gap-6 text-sm">
              <div>
                <span className="text-white/35 text-xs">Object</span>
                <p className="font-semibold text-[#6366f1]">{objectApiName}</p>
              </div>
              <div>
                <span className="text-white/35 text-xs">Operation</span>
                <p className="font-semibold text-white capitalize">{operation}</p>
              </div>
              {externalIdField && (
                <div>
                  <span className="text-white/35 text-xs">External ID</span>
                  <p className="font-semibold text-white">{externalIdField}</p>
                </div>
              )}
              <button onClick={() => { setDataFile(null); setFilePreview(null); setPreflight(null); setStep(1); }}
                className="ml-auto text-xs text-white/35 hover:text-white transition">← Change</button>
            </div>

            <div>
              <h2 className="text-lg font-semibold">Upload your data file</h2>
              <p className="text-white/45 text-sm mt-1">
                Upload the CSV or XLSX containing <span className="text-[#6366f1] font-medium">{objectApiName}</span> records to load.
              </p>
            </div>

            {/* Drop zone */}
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition ${
                isDragActive ? 'border-[#6366f1] bg-[#6366f1]/5' :
                dataFile ? 'border-green-500/40 bg-green-500/5' :
                'border-white/15 hover:border-white/30'
              }`}
            >
              <input {...getInputProps()} />
              <Upload size={32} className={`mx-auto mb-3 ${dataFile ? 'text-green-400' : 'text-white/30'}`} />
              {dataFile
                ? <>
                    <p className="text-green-400 font-medium">{dataFile.name}</p>
                    {filePreview && (
                      <p className="text-white/40 text-sm mt-1">
                        {filePreview.rowCount.toLocaleString()} records · {filePreview.headers?.length} columns
                      </p>
                    )}
                  </>
                : <>
                    <p className="text-white/50 text-sm font-medium">Drag & drop your CSV or XLSX, or click to browse</p>
                    <p className="text-white/30 text-xs mt-1">Columns should match <strong>{objectApiName}</strong> field API names</p>
                  </>
              }
            </div>

            {/* Column preview */}
            {filePreview?.headers?.length > 0 && (
              <div className="bg-[#27272a]/20 border border-white/8 rounded-xl px-5 py-4">
                <p className="text-xs text-white/40 font-medium mb-2">Detected columns</p>
                <div className="flex flex-wrap gap-1.5">
                  {filePreview.headers.slice(0, 12).map(h => (
                    <span key={h} className="text-xs bg-white/8 text-white/60 px-2 py-1 rounded-lg font-mono">{h}</span>
                  ))}
                  {filePreview.headers.length > 12 && (
                    <span className="text-xs text-white/30 px-2 py-1">+{filePreview.headers.length - 12} more</span>
                  )}
                </div>
              </div>
            )}

            {/* Pre-flight: explicit button — never auto-fires */}
            {dataFile && filePreview && (
              <div className="flex items-center gap-3">
                <button
                  onClick={runPreflight}
                  disabled={preflightLoading}
                  className="inline-flex items-center gap-2 bg-[#27272a]/40 hover:bg-[#27272a]/70 border border-white/15 text-white/70 hover:text-white disabled:opacity-40 transition px-4 py-2.5 rounded-xl text-sm font-medium"
                >
                  {preflightLoading
                    ? <><Loader2 size={14} className="animate-spin" /> Running pre-flight…</>
                    : <><Check size={14} /> Run Pre-flight Check</>
                  }
                </button>
                {preflight?.passed && (
                  <span className="text-xs text-green-400 flex items-center gap-1"><Check size={12} /> Schema validated</span>
                )}
              </div>
            )}

            <PreflightPanel loading={preflightLoading} result={preflight} />

            <div className="flex gap-3 pt-2">
              <button onClick={() => setStep(1)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <button
                onClick={() => setStep(3)}
                disabled={!dataFile}
                className="bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-40 text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2"
              >
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 2 (org_migration): Configure ────────────────────────────── */}
        {step === 2 && !isDataLoad && (
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
                  <div onClick={() => set(!val)}
                    className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition ${
                      val ? 'bg-[#6366f1] border-[#6366f1]' : 'border-white/25 group-hover:border-white/50'
                    }`}>
                    {val && <Check size={12} className="text-white" />}
                  </div>
                  <span className="text-sm text-white/80">{label}</span>
                </label>
              ))}
            </div>

            <div className="flex gap-3 pt-4">
              <button onClick={() => setStep(1)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <button onClick={() => setStep(3)}
                className="bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition flex items-center gap-2">
                Next <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3 (data_load): Dry run toggle + Review & Launch ─────────── */}
        {step === 3 && isDataLoad && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Review & Launch</h2>

            {/* Summary */}
            <div className="bg-[#27272a]/20 border border-white/10 rounded-xl p-5 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-white/50">Target org</span><span>{orgs.find(o => o.id === targetOrg)?.org_name}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Object</span><span className="text-[#6366f1] font-medium">{objectApiName}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Operation</span><span className="capitalize">{operation}</span></div>
              {externalIdField && <div className="flex justify-between"><span className="text-white/50">External ID</span><span className="font-mono text-xs">{externalIdField}</span></div>}
              <div className="flex justify-between"><span className="text-white/50">Data file</span><span>{dataFile?.name}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Records</span><span>{(filePreview?.rowCount || 0).toLocaleString()}</span></div>
            </div>

            {/* Pre-flight status */}
            {preflight && (
              <div className={`rounded-xl border px-5 py-3 text-sm flex items-center gap-3 ${
                preflight.passed ? 'border-green-500/25 bg-green-500/5 text-green-300' : 'border-yellow-500/25 bg-yellow-500/5 text-yellow-300'
              }`}>
                {preflight.passed
                  ? <><Check size={14} /> Pre-flight passed — {preflight.warnings?.length || 0} warning(s)</>
                  : <><span className="font-semibold">⚠ Pre-flight issues found.</span> Review before loading.</>
                }
              </div>
            )}
            {!preflight && (
              <div className="rounded-xl border border-white/10 bg-white/3 px-5 py-3 text-sm text-white/40 flex items-center justify-between">
                <span>Pre-flight not run yet.</span>
                <button onClick={() => { setStep(2); }} className="text-[#6366f1] text-xs hover:underline">Go back to run it</button>
              </div>
            )}

            {/* Dry run toggle */}
            <div className="bg-[#27272a]/20 border border-white/8 rounded-xl p-5">
              <label className="flex items-center gap-3 cursor-pointer">
                <div onClick={() => setIsDryRun(!isDryRun)}
                  className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition ${
                    isDryRun ? 'bg-[#6366f1] border-[#6366f1]' : 'border-white/25 hover:border-white/50'
                  }`}>
                  {isDryRun && <Check size={12} className="text-white" />}
                </div>
                <div>
                  <span className="text-sm text-white/80 font-medium">Dry Run</span>
                  <p className="text-xs text-white/40 mt-0.5">Validates data structure — no records are written to Salesforce.</p>
                </div>
              </label>
            </div>

            {!isDryRun && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-5 py-4 text-sm text-amber-200">
                <strong>Live load:</strong> {(filePreview?.rowCount || 0).toLocaleString()} records will be {operation}ed into <strong>{objectApiName}</strong> in <strong>{orgs.find(o => o.id === targetOrg)?.org_name}</strong>. This cannot be undone automatically.
              </div>
            )}

            {launchError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg">{launchError}</div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={() => setStep(2)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <LoadingButton
                onClick={handleLaunch}
                loadingText={isDryRun ? 'Starting dry run…' : 'Launching load…'}
                slowText="Uploading to Salesforce — hang tight…"
                slowThreshold={15000}
                variant="primary"
                className={isDryRun ? 'bg-[#27272a] hover:bg-[#3f3f46] border border-white/15' : ''}
              >
                {isDryRun ? 'Start Dry Run' : `Load ${(filePreview?.rowCount || 0).toLocaleString()} Records`}
              </LoadingButton>
            </div>
          </div>
        )}

        {/* ── STEP 3 (org_migration): Review & Launch ──────────────────────── */}
        {step === 3 && !isDataLoad && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">Review & Launch</h2>
            <div className="bg-[#27272a]/20 border border-white/10 rounded-xl p-5 space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-white/50">Job Type</span><span>Source → Target Migration</span></div>
              <div className="flex justify-between"><span className="text-white/50">Source</span><span>{orgs.find(o => o.id === sourceOrg)?.org_name}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Target</span><span>{orgs.find(o => o.id === targetOrg)?.org_name}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Mapping</span><span>{mappingFile?.name || 'Passthrough (no file)'}</span></div>
              <div className="flex justify-between"><span className="text-white/50">Mode</span>
                <span className={isDryRun ? 'text-yellow-400' : 'text-green-400'}>{isDryRun ? 'Dry Run' : 'Live Migration'}</span>
              </div>
            </div>

            {launchError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-4 py-3 rounded-lg">{launchError}</div>
            )}

            <div className="flex gap-3 pt-2">
              <button onClick={() => setStep(2)} className="text-white/40 hover:text-white text-sm transition">← Back</button>
              <LoadingButton
                onClick={handleLaunch}
                loadingText={isDryRun ? 'Starting dry run…' : 'Launching migration…'}
                slowText="Connecting to Salesforce — this may take a moment…"
                slowThreshold={15000}
                variant="primary"
              >
                {isDryRun ? 'Start Dry Run' : 'Launch Migration'}
              </LoadingButton>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
