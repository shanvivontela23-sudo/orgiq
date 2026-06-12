import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  Upload, CheckCircle2, XCircle, AlertTriangle, ChevronRight,
  ChevronDown, ChevronUp, Loader2, FileSpreadsheet, RefreshCw,
  ArrowRight, Pencil, Check, X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const STEPS = ['Upload', 'Gap Analysis', 'Review Fields', 'Deploy'];

const STATUS_META = {
  exists:        { label: 'Exists',        color: 'text-green-400',  bg: 'bg-green-500/10 border-green-500/20' },
  missing:       { label: 'Missing',       color: 'text-red-400',    bg: 'bg-red-500/10 border-red-500/20' },
  type_mismatch: { label: 'Type Mismatch', color: 'text-yellow-400', bg: 'bg-yellow-500/10 border-yellow-500/20' },
  object_missing:{ label: 'Object Missing',color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-500/10' },
};

const FIELD_TYPES = ['Text', 'Number', 'Date', 'DateTime', 'Checkbox', 'Picklist', 'Lookup', 'Formula', 'Currency', 'Email', 'Phone', 'Url', 'Percent', 'LongTextArea'];

// ── Step indicator ────────────────────────────────────────────────────────────
function StepBar({ step }) {
  return (
    <div className="flex items-center gap-0 mb-8">
      {STEPS.map((label, i) => (
        <div key={label} className="flex items-center">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
            i === step ? 'bg-[#6366f1]/15 text-[#6366f1]' :
            i < step   ? 'text-green-400' : 'text-white/25'
          }`}>
            {i < step
              ? <CheckCircle2 size={13} />
              : <span className={`w-4 h-4 rounded-full border text-[10px] flex items-center justify-center ${i === step ? 'border-[#6366f1] text-[#6366f1]' : 'border-white/20 text-white/25'}`}>{i + 1}</span>
            }
            {label}
          </div>
          {i < STEPS.length - 1 && <ChevronRight size={12} className="text-white/15 mx-1" />}
        </div>
      ))}
    </div>
  );
}

// ── Drop zone ─────────────────────────────────────────────────────────────────
function DropZone({ onFile }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef();

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }, [onFile]);

  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current.click()}
      className={`border-2 border-dashed rounded-2xl flex flex-col items-center justify-center py-16 cursor-pointer transition ${
        dragging ? 'border-[#6366f1] bg-[#6366f1]/5' : 'border-white/12 hover:border-white/25 hover:bg-white/[0.02]'
      }`}
    >
      <FileSpreadsheet size={36} className="text-white/20 mb-4" />
      <p className="text-sm text-white/60">Drag &amp; drop your mapping sheet, or <span className="text-[#6366f1]">browse</span></p>
      <p className="text-xs text-white/30 mt-1">Accepts .xlsx, .xls, .csv — up to 50 MB</p>
      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={e => { if (e.target.files[0]) onFile(e.target.files[0]); }} />
    </div>
  );
}

// ── Column mapping step (shown when auto-detect incomplete) ───────────────────
function ColMapStep({ headers, colMap: initial, onConfirm }) {
  const [map, setMap] = useState(initial);
  const fields = ['object', 'label', 'apiName', 'fieldType', 'required'];
  const labels = { object: 'Object API Name', label: 'Field Label', apiName: 'Field API Name', fieldType: 'Field Type', required: 'Required' };

  return (
    <div className="space-y-4 max-w-lg">
      <p className="text-sm text-white/50">We couldn't auto-detect all columns. Map each required field to a column from your sheet:</p>
      {fields.map(f => (
        <div key={f} className="flex items-center gap-3">
          <span className="text-xs text-white/50 w-36 shrink-0">{labels[f]}</span>
          <select
            value={map[f] || ''}
            onChange={e => setMap(m => ({ ...m, [f]: e.target.value }))}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#6366f1]/50"
          >
            <option value="">— Select column —</option>
            {headers.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>
      ))}
      <button
        onClick={() => onConfirm(map)}
        disabled={fields.some(f => !map[f])}
        className="px-5 py-2 rounded-lg bg-[#6366f1] text-white text-sm font-medium disabled:opacity-40 hover:bg-[#5254cc] transition"
      >
        Confirm mapping
      </button>
    </div>
  );
}

// ── Field decision card (Yes / No / Customise) ────────────────────────────────
function FieldDecisionCard({ field, decision, onDecide }) {
  const [customising, setCustomising] = useState(false);
  const [custom, setCustom] = useState({
    label:     field.label,
    apiName:   field.apiName,
    fieldType: field.fieldType,
    required:  field.required === 'true' || field.required === '1' || field.required === 'yes',
    helpText:  '',
  });

  const decide = (d) => {
    if (d === 'yes') onDecide({ action: 'create', field: { ...field, ...custom } });
    else if (d === 'no') onDecide({ action: 'skip' });
    else setCustomising(true);
  };

  const confirmCustom = () => {
    onDecide({ action: 'create', field: { ...field, ...custom } });
    setCustomising(false);
  };

  if (customising) return (
    <div className="border border-[#6366f1]/30 bg-[#6366f1]/5 rounded-xl p-4 space-y-3">
      <p className="text-xs font-medium text-[#6366f1]">Customise: {field.object}.{field.apiName}</p>
      {[
        { key: 'label',     label: 'Field Label',   type: 'text' },
        { key: 'apiName',   label: 'API Name',       type: 'text' },
        { key: 'helpText',  label: 'Help Text',      type: 'text' },
      ].map(({ key, label, type }) => (
        <div key={key} className="flex items-center gap-3">
          <span className="text-xs text-white/40 w-24 shrink-0">{label}</span>
          <input type={type} value={custom[key]} onChange={e => setCustom(c => ({ ...c, [key]: e.target.value }))}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#6366f1]/50" />
        </div>
      ))}
      <div className="flex items-center gap-3">
        <span className="text-xs text-white/40 w-24 shrink-0">Field Type</span>
        <select value={custom.fieldType} onChange={e => setCustom(c => ({ ...c, fieldType: e.target.value }))}
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#6366f1]/50">
          {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-white/40 w-24 shrink-0">Required</span>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={custom.required} onChange={e => setCustom(c => ({ ...c, required: e.target.checked }))} className="accent-[#6366f1]" />
          <span className="text-xs text-white/60">Yes</span>
        </label>
      </div>
      <div className="flex gap-2 pt-1">
        <button onClick={confirmCustom} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#6366f1] text-white text-xs font-medium">
          <Check size={12} /> Confirm
        </button>
        <button onClick={() => setCustomising(false)} className="px-3 py-1.5 rounded-lg border border-white/10 text-white/50 text-xs">Cancel</button>
      </div>
    </div>
  );

  const d = decision?.action;
  return (
    <div className={`border rounded-xl p-4 flex items-start gap-4 transition ${
      d === 'create' ? 'border-green-500/25 bg-green-500/5' :
      d === 'skip'   ? 'border-white/8 bg-white/[0.015] opacity-50' :
      'border-white/8 bg-white/[0.02]'
    }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-mono text-white/70">{field.object}</span>
          <ArrowRight size={10} className="text-white/20" />
          <span className="text-sm font-medium text-white">{field.apiName || field.label}</span>
          {field.fieldType && <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/8 text-white/40">{field.fieldType}</span>}
          {(field.required === 'true' || field.required === '1' || field.required === 'yes') && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">required</span>
          )}
        </div>
        {field.label && field.label !== field.apiName && (
          <p className="text-xs text-white/35 mt-0.5">{field.label}</p>
        )}
      </div>
      {!d ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => decide('yes')} className="px-2.5 py-1 rounded-lg bg-green-500/15 border border-green-500/25 text-green-400 text-xs font-medium hover:bg-green-500/25 transition">
            Create
          </button>
          <button onClick={() => decide('custom')} className="px-2.5 py-1 rounded-lg bg-white/8 border border-white/12 text-white/50 text-xs font-medium hover:bg-white/12 transition">
            <Pencil size={11} />
          </button>
          <button onClick={() => decide('no')} className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-white/35 text-xs font-medium hover:bg-white/10 transition">
            Skip
          </button>
        </div>
      ) : (
        <div className={`flex items-center gap-1 text-xs shrink-0 ${d === 'create' ? 'text-green-400' : 'text-white/30'}`}>
          {d === 'create' ? <><Check size={12} /> Create</> : <><X size={12} /> Skip</>}
          <button onClick={() => onDecide(null)} className="ml-1 text-white/20 hover:text-white/50 transition"><RefreshCw size={10} /></button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function MappingSheet() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState('');
  const [step, setStep] = useState(0);

  // Step 0: upload
  const [file, setFile] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState(null);
  const [colMapNeeded, setColMapNeeded] = useState(false);
  const [rows, setRows] = useState([]);

  // Step 1: compare
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');

  // Step 2: decisions
  const [decisions, setDecisions] = useState({});

  // Step 3: deploy
  const [deploying, setDeploying] = useState(false);
  const [deployResult, setDeployResult] = useState(null);
  const [deployError, setDeployError] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user;
      setUser(u || null);
      if (u) loadOrgs(u.id);
    });
  }, []);

  async function loadOrgs(userId) {
    try {
      const { data } = await axios.get(`${API}/api/orgs`, { params: { userId } });
      setOrgs(data.orgs || []);
      if (data.orgs?.length) setOrgId(data.orgs[0].id);
    } catch { /* ignore */ }
  }

  // ── Upload + parse ──────────────────────────────────────────────────────────
  async function handleFile(f) {
    setFile(f);
    setParsing(true);
    setParseResult(null);

    try {
      const form = new FormData();
      form.append('file', f);
      form.append('userId', user?.id || '');

      const { data } = await axios.post(`${API}/api/mapping/parse`, form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });

      setParseResult(data);
      if (!data.colMapComplete) {
        setColMapNeeded(true);
      } else {
        setRows(data.rows);
      }
    } catch (err) {
      setParseResult({ error: err.response?.data?.error || err.message });
    } finally {
      setParsing(false);
    }
  }

  function confirmColMap(colMap) {
    // Re-apply the new column mapping to raw rows
    const remapped = parseResult.rows.map(r => ({
      object:    String(r[colMap.object]    || '').trim(),
      label:     String(r[colMap.label]     || '').trim(),
      apiName:   String(r[colMap.apiName]   || '').trim(),
      fieldType: String(r[colMap.fieldType] || '').trim(),
      required:  String(r[colMap.required]  || '').trim().toLowerCase(),
    })).filter(r => r.object);
    setRows(remapped);
    setColMapNeeded(false);
  }

  // ── Compare ─────────────────────────────────────────────────────────────────
  async function runCompare() {
    setComparing(true);
    setCompareResult(null);
    try {
      const { data } = await axios.post(`${API}/api/mapping/compare`, { orgId, rows, userId: user?.id });
      setCompareResult(data);
      setStep(1);
    } catch (err) {
      setCompareResult({ error: err.response?.data?.error || err.message });
    } finally {
      setComparing(false);
    }
  }

  // ── Deploy ──────────────────────────────────────────────────────────────────
  async function runDeploy() {
    const toCreate = Object.entries(decisions)
      .filter(([, d]) => d?.action === 'create')
      .map(([key, d]) => {
        const field = d.field;
        return {
          object:    field.object,
          apiName:   field.apiName,
          label:     field.label,
          fieldType: field.fieldType,
          required:  field.required,
          helpText:  field.helpText || '',
        };
      });

    if (!toCreate.length) return;

    setDeploying(true);
    setDeployError(null);
    try {
      const { data } = await axios.post(`${API}/api/mapping/create-fields`, {
        orgId,
        userId: user?.id,
        fields: toCreate,
      });
      setDeployResult(data);
      setStep(3);
    } catch (err) {
      setDeployError(err.response?.data?.error || err.message);
    } finally {
      setDeploying(false);
    }
  }

  // ── Derived ─────────────────────────────────────────────────────────────────
  const missingFields = compareResult?.results?.filter(r => r.status === 'missing' || r.status === 'type_mismatch') || [];
  const decidedCount  = Object.values(decisions).filter(Boolean).length;
  const toCreateCount = Object.values(decisions).filter(d => d?.action === 'create').length;

  const filteredResults = compareResult?.results?.filter(r =>
    statusFilter === 'all' ? true : r.status === statusFilter
  ) || [];

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />

      <main className="flex-1 px-8 py-8 max-w-4xl">
        <div className="mb-7">
          <h1 className="text-2xl font-bold">Mapping Sheet</h1>
          <p className="text-white/40 text-sm mt-1">Upload a field mapping sheet, find gaps, and create missing fields.</p>
        </div>

        <StepBar step={step} />

        {/* ── Step 0: Upload ───────────────────────────────────────────────── */}
        {step === 0 && (
          <div className="space-y-6">
            {/* Org selector */}
            <div className="flex items-center gap-3">
              <label className="text-xs text-white/40 shrink-0">Target Org</label>
              <select
                value={orgId}
                onChange={e => setOrgId(e.target.value)}
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#6366f1]/50"
              >
                {orgs.map(o => <option key={o.id} value={o.id}>{o.org_name || o.instance_url}</option>)}
              </select>
            </div>

            {!file && !parsing && <DropZone onFile={handleFile} />}

            {parsing && (
              <div className="flex items-center justify-center py-20 text-white/40">
                <Loader2 size={20} className="animate-spin mr-2" /> Parsing file…
              </div>
            )}

            {parseResult?.error && (
              <div className="bg-red-500/10 border border-red-500/25 rounded-xl px-5 py-4 text-sm text-red-400">
                {parseResult.error}
                <button onClick={() => { setFile(null); setParseResult(null); }} className="ml-3 underline text-xs">Try again</button>
              </div>
            )}

            {parseResult && !parseResult.error && (
              <div className="space-y-5">
                {/* Parse summary */}
                <div className="bg-white/[0.03] border border-white/8 rounded-xl p-5 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileSpreadsheet size={16} className="text-[#6366f1]" />
                      <span className="text-sm font-medium">{file.name}</span>
                    </div>
                    <button onClick={() => { setFile(null); setParseResult(null); setColMapNeeded(false); setRows([]); }}
                      className="text-xs text-white/30 hover:text-white transition">Remove</button>
                  </div>
                  <div className="grid grid-cols-3 gap-4 pt-1">
                    {[
                      { label: 'Total rows',    value: parseResult.rowCount },
                      { label: 'Objects',       value: parseResult.objects?.length },
                      { label: 'Columns found', value: parseResult.headers?.length },
                    ].map(({ label, value }) => (
                      <div key={label}>
                        <p className="text-xs text-white/30">{label}</p>
                        <p className="text-xl font-bold text-white mt-0.5">{value}</p>
                      </div>
                    ))}
                  </div>
                  {parseResult.objects?.length > 0 && (
                    <div className="pt-1 flex flex-wrap gap-2">
                      {parseResult.objects.map(o => (
                        <span key={o} className="text-[11px] px-2 py-0.5 rounded-full bg-white/6 border border-white/10 text-white/50">{o}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Column mapping (if needed) */}
                {colMapNeeded && (
                  <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-xl p-5">
                    <div className="flex items-center gap-2 mb-4">
                      <AlertTriangle size={14} className="text-yellow-400" />
                      <span className="text-sm text-yellow-400 font-medium">Column mapping needed</span>
                    </div>
                    <ColMapStep
                      headers={parseResult.headers}
                      colMap={parseResult.colMap}
                      onConfirm={confirmColMap}
                    />
                  </div>
                )}

                {/* Next button */}
                {!colMapNeeded && rows.length > 0 && (
                  <div className="flex items-center gap-3">
                    <button
                      onClick={runCompare}
                      disabled={comparing || !orgId}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#6366f1] text-white text-sm font-medium hover:bg-[#5254cc] disabled:opacity-40 transition"
                    >
                      {comparing ? <><Loader2 size={14} className="animate-spin" /> Comparing…</> : <>Compare against org <ChevronRight size={14} /></>}
                    </button>
                    {!orgId && <span className="text-xs text-red-400">Select an org first</span>}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── Step 1: Gap Analysis ─────────────────────────────────────────── */}
        {step === 1 && compareResult && !compareResult.error && (
          <div className="space-y-5">
            {/* Summary */}
            <div className="grid grid-cols-4 gap-3">
              {[
                { label: 'Checked',      value: compareResult.summary.total,        color: 'text-white' },
                { label: 'Exist',        value: compareResult.summary.exists,       color: 'text-green-400' },
                { label: 'Missing',      value: compareResult.summary.missing,      color: 'text-red-400' },
                { label: 'Type Mismatch',value: compareResult.summary.typeMismatch, color: 'text-yellow-400' },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-white/[0.02] border border-white/8 rounded-xl px-4 py-3">
                  <p className="text-xs text-white/35">{label}</p>
                  <p className={`text-2xl font-bold mt-0.5 ${color}`}>{value}</p>
                </div>
              ))}
            </div>

            {/* Status filter */}
            <div className="flex gap-1 bg-white/5 rounded-xl p-1 w-fit">
              {['all', 'missing', 'type_mismatch', 'exists', 'object_missing'].map(s => (
                <button key={s} onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition capitalize ${statusFilter === s ? 'bg-white/12 text-white' : 'text-white/40 hover:text-white'}`}>
                  {s === 'all' ? 'All' : s === 'type_mismatch' ? 'Type Mismatch' : s === 'object_missing' ? 'Object Missing' : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>

            {/* Results table */}
            <div className="border border-white/8 rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/8 bg-white/[0.02]">
                    <th className="text-left px-4 py-3 text-xs text-white/35 font-medium">Object</th>
                    <th className="text-left px-4 py-3 text-xs text-white/35 font-medium">API Name</th>
                    <th className="text-left px-4 py-3 text-xs text-white/35 font-medium">Sheet Type</th>
                    <th className="text-left px-4 py-3 text-xs text-white/35 font-medium">SF Type</th>
                    <th className="text-left px-4 py-3 text-xs text-white/35 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredResults.map((r, i) => {
                    const meta = STATUS_META[r.status] || STATUS_META.exists;
                    return (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/[0.015] transition">
                        <td className="px-4 py-3 text-xs text-white/50 font-mono">{r.object}</td>
                        <td className="px-4 py-3 text-xs text-white font-mono">{r.apiName || '—'}</td>
                        <td className="px-4 py-3 text-xs text-white/50">{r.sheetType || r.fieldType || '—'}</td>
                        <td className="px-4 py-3 text-xs text-white/50">{r.sfType || '—'}</td>
                        <td className="px-4 py-3">
                          <span className={`text-[11px] px-2 py-0.5 rounded-full border font-medium ${meta.bg} ${meta.color}`}>
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button onClick={() => setStep(0)} className="px-4 py-2 rounded-lg border border-white/10 text-white/50 text-sm hover:text-white transition">
                ← Back
              </button>
              {missingFields.length > 0 ? (
                <button onClick={() => setStep(2)}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#6366f1] text-white text-sm font-medium hover:bg-[#5254cc] transition">
                  Review {missingFields.length} missing field{missingFields.length !== 1 ? 's' : ''} <ChevronRight size={14} />
                </button>
              ) : (
                <div className="flex items-center gap-2 text-green-400 text-sm">
                  <CheckCircle2 size={16} /> All fields exist in the org
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Step 2: Review decisions ─────────────────────────────────────── */}
        {step === 2 && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-white/60">{decidedCount} of {missingFields.length} reviewed · <span className="text-green-400">{toCreateCount} to create</span></p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const all = {};
                    missingFields.forEach((f, i) => { all[i] = { action: 'create', field: f }; });
                    setDecisions(all);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-white/10 text-white/50 text-xs hover:text-white hover:border-white/25 transition"
                >
                  Create all
                </button>
                <button
                  onClick={() => {
                    const all = {};
                    missingFields.forEach((_, i) => { all[i] = { action: 'skip' }; });
                    setDecisions(all);
                  }}
                  className="px-3 py-1.5 rounded-lg border border-white/10 text-white/50 text-xs hover:text-white hover:border-white/25 transition"
                >
                  Skip all
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {missingFields.map((f, i) => (
                <FieldDecisionCard
                  key={i}
                  field={f}
                  decision={decisions[i]}
                  onDecide={(d) => setDecisions(prev => ({ ...prev, [i]: d }))}
                />
              ))}
            </div>

            <div className="flex items-center gap-3 pt-2">
              <button onClick={() => setStep(1)} className="px-4 py-2 rounded-lg border border-white/10 text-white/50 text-sm hover:text-white transition">
                ← Back
              </button>
              <button
                onClick={runDeploy}
                disabled={deploying || toCreateCount === 0}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#6366f1] text-white text-sm font-medium hover:bg-[#5254cc] disabled:opacity-40 transition"
              >
                {deploying
                  ? <><Loader2 size={14} className="animate-spin" /> Deploying…</>
                  : <>Create {toCreateCount} field{toCreateCount !== 1 ? 's' : ''} <ChevronRight size={14} /></>
                }
              </button>
              {deployError && <p className="text-xs text-red-400">{deployError}</p>}
            </div>
          </div>
        )}

        {/* ── Step 3: Deploy result ────────────────────────────────────────── */}
        {step === 3 && deployResult && (
          <div className="space-y-5">
            {/* Summary banner */}
            <div className={`flex items-center gap-3 px-5 py-4 rounded-xl border ${
              deployResult.summary.failed === 0
                ? 'bg-green-500/8 border-green-500/20 text-green-400'
                : deployResult.summary.created > 0
                ? 'bg-yellow-500/8 border-yellow-500/20 text-yellow-400'
                : 'bg-red-500/8 border-red-500/20 text-red-400'
            }`}>
              {deployResult.summary.failed === 0
                ? <CheckCircle2 size={18} />
                : deployResult.summary.created > 0
                ? <AlertTriangle size={18} />
                : <XCircle size={18} />
              }
              <div>
                <p className="font-medium text-sm">
                  {deployResult.summary.created} field{deployResult.summary.created !== 1 ? 's' : ''} created
                  {deployResult.summary.failed > 0 && `, ${deployResult.summary.failed} failed`}
                </p>
                <p className="text-xs opacity-70 mt-0.5">
                  {deployResult.summary.failed === 0 ? 'All fields deployed successfully.' : 'See details below.'}
                </p>
              </div>
            </div>

            {/* Per-field results */}
            <div className="space-y-2">
              {deployResult.results.map((r, i) => (
                <div key={i} className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
                  r.status === 'created' ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'
                }`}>
                  {r.status === 'created'
                    ? <CheckCircle2 size={14} className="text-green-400 shrink-0" />
                    : <XCircle size={14} className="text-red-400 shrink-0" />
                  }
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-mono text-white/60">{r.object}.</span>
                    <span className="text-sm text-white">{r.apiName}</span>
                    {r.error && <p className="text-xs text-red-400/80 mt-0.5 break-words">{r.error}</p>}
                  </div>
                  <span className={`text-xs font-medium shrink-0 ${r.status === 'created' ? 'text-green-400' : 'text-red-400'}`}>
                    {r.status === 'created' ? 'Created' : 'Failed'}
                  </span>
                </div>
              ))}
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => { setStep(0); setFile(null); setParseResult(null); setRows([]); setCompareResult(null); setDecisions({}); setDeployResult(null); }}
                className="px-4 py-2 rounded-lg border border-white/10 text-white/50 text-sm hover:text-white transition">
                Upload another sheet
              </button>
              <button onClick={() => navigate('/history')}
                className="px-4 py-2 rounded-lg border border-white/10 text-white/50 text-sm hover:text-white transition">
                View audit history
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
