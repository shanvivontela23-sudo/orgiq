import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Box, Plus, CheckCircle, XCircle, ChevronRight, ChevronLeft,
  X, AlertTriangle, Info, Hash, Type, Calendar, ToggleLeft,
  List, Link, DollarSign, Percent, Mail, Phone, Globe, FileText,
  Shield, Search, BarChart2, Zap, Clock, GitBranch, Loader2,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const STEPS = [
  { label: 'Basics',        icon: Box },
  { label: 'Relationships', icon: GitBranch },
  { label: 'Features',      icon: Zap },
  { label: 'Profile Access',icon: Shield },
  { label: 'Fields',        icon: Hash },
  { label: 'Review',        icon: CheckCircle },
];

const FIELD_TYPES = [
  { value: 'Text',         label: 'Text',       icon: Type },
  { value: 'LongTextArea', label: 'Long Text',  icon: FileText },
  { value: 'Number',       label: 'Number',     icon: Hash },
  { value: 'Currency',     label: 'Currency',   icon: DollarSign },
  { value: 'Percent',      label: 'Percent',    icon: Percent },
  { value: 'Checkbox',     label: 'Checkbox',   icon: ToggleLeft },
  { value: 'Date',         label: 'Date',       icon: Calendar },
  { value: 'DateTime',     label: 'Date/Time',  icon: Calendar },
  { value: 'Picklist',     label: 'Picklist',   icon: List },
  { value: 'Lookup',       label: 'Lookup',     icon: Link },
  { value: 'Email',        label: 'Email',      icon: Mail },
  { value: 'Phone',        label: 'Phone',      icon: Phone },
  { value: 'URL',          label: 'URL',        icon: Globe },
  { value: 'Formula',      label: 'Formula',    icon: Hash },
];

const SHARING_MODELS = [
  { value: 'Private',            label: 'Private',             desc: 'Only owner + admins can see records' },
  { value: 'Read',               label: 'Read Only',           desc: 'Others can view but not edit' },
  { value: 'ReadWrite',          label: 'Read / Write',        desc: 'Others can view and edit' },
  { value: 'ControlledByParent', label: 'Controlled by Parent',desc: 'Inherits from master (Master-Detail only)' },
];

const STANDARD_OBJECTS = ['Account','Contact','Lead','Opportunity','Case','Order','Product2','Campaign','User','Contract','Quote'];

function toApiName(label = '') {
  return label.trim().replace(/[^a-zA-Z0-9 _]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

// ── Shared components ─────────────────────────────────────────────────────────

function Fld({ label, required, hint, children }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-white/55">
        {label}{required && <span className="text-[#6366f1]">*</span>}
        {hint && (
          <span className="group relative cursor-help">
            <Info size={11} className="text-white/25" />
            <span className="hidden group-hover:block absolute left-4 top-0 z-50 w-56 bg-[#1c1c1f] border border-white/15 rounded-lg px-3 py-2 text-xs text-white/60 shadow-xl normal-case font-normal">{hint}</span>
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Inp({ ...p }) {
  return <input className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition" {...p} />;
}

function Sel({ children, ...p }) {
  return <select className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#6366f1] transition" {...p}>{children}</select>;
}

// Question card — Yes / No with optional extra content when Yes
function Question({ q, hint, value, onChange, yesLabel = 'Yes', noLabel = 'No', children }) {
  return (
    <div className="bg-[#1c1c1f] border border-white/8 rounded-2xl p-5 space-y-4">
      <div>
        <p className="text-sm font-medium text-white">{q}</p>
        {hint && <p className="text-xs text-white/35 mt-1">{hint}</p>}
      </div>
      <div className="flex gap-2">
        {[{ v: true, label: yesLabel }, { v: false, label: noLabel }].map(opt => (
          <button key={String(opt.v)} type="button"
            onClick={() => onChange(opt.v)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium border transition ${
              value === opt.v
                ? 'bg-[#6366f1] border-[#6366f1] text-white'
                : 'border-white/12 text-white/45 hover:border-white/25 hover:text-white/70'
            }`}>
            {opt.label}
          </button>
        ))}
      </div>
      {value === true && children && (
        <div className="pt-1 space-y-3 border-t border-white/6">{children}</div>
      )}
    </div>
  );
}

function ResultBanner({ result, onClear }) {
  if (!result) return null;
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
      result.type === 'success' ? 'bg-green-500/10 border-green-500/20 text-green-300' : 'bg-red-500/10 border-red-500/20 text-red-300'
    }`}>
      {result.type === 'success' ? <CheckCircle size={16} className="shrink-0 mt-0.5" /> : <XCircle size={16} className="shrink-0 mt-0.5" />}
      <div className="flex-1">
        <p className="font-medium">{result.message}</p>
        {result.detail && <p className="text-xs opacity-70 mt-1">{result.detail}</p>}
        {result.errors?.map((e, i) => <p key={i} className="text-xs opacity-70 mt-0.5">{e}</p>)}
        {result.setupUrl && (
          <a href={result.setupUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 text-xs underline opacity-70 hover:opacity-100">
            View in Salesforce Setup →
          </a>
        )}
      </div>
      <button onClick={onClear}><X size={14} className="text-white/30 hover:text-white/60" /></button>
    </div>
  );
}

// ── Field builder row ─────────────────────────────────────────────────────────
function FieldRow({ field, onChange, onRemove, objects }) {
  const [pvInput, setPvInput] = useState('');
  const addPv = () => { const v = pvInput.trim(); if (!v) return; onChange({ ...field, picklistValues: [...(field.picklistValues || []), v] }); setPvInput(''); };
  return (
    <div className="bg-[#111113] border border-white/8 rounded-xl p-4 space-y-3">
      <div className="flex gap-3">
        <div className="grid grid-cols-2 gap-3 flex-1">
          <Fld label="Label" required>
            <Inp placeholder="Field label" value={field.label}
              onChange={e => onChange({ ...field, label: e.target.value, apiName: toApiName(e.target.value) + '__c' })} />
          </Fld>
          <Fld label="API Name">
            <Inp value={field.apiName} onChange={e => onChange({ ...field, apiName: e.target.value })} />
          </Fld>
        </div>
        <button onClick={onRemove} className="text-white/20 hover:text-red-400 transition mt-5 shrink-0"><X size={14} /></button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FIELD_TYPES.map(t => (
          <button key={t.value} type="button" onClick={() => onChange({ ...field, type: t.value })}
            className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${field.type === t.value ? 'border-[#6366f1] bg-[#6366f1]/15 text-[#6366f1]' : 'border-white/8 text-white/40 hover:border-white/20 hover:text-white'}`}>
            <t.icon size={10} /> {t.label}
          </button>
        ))}
      </div>
      {field.type === 'Text' && <Fld label="Max Length"><Inp type="number" value={field.length || 255} min={1} max={255} onChange={e => onChange({ ...field, length: Number(e.target.value) })} /></Fld>}
      {(field.type === 'Number' || field.type === 'Currency' || field.type === 'Percent') && (
        <div className="grid grid-cols-2 gap-3">
          <Fld label="Precision"><Inp type="number" value={field.precision || 18} onChange={e => onChange({ ...field, precision: Number(e.target.value) })} /></Fld>
          <Fld label="Decimal Places"><Inp type="number" value={field.scale || 0} min={0} max={10} onChange={e => onChange({ ...field, scale: Number(e.target.value) })} /></Fld>
        </div>
      )}
      {field.type === 'Picklist' && (
        <Fld label="Values">
          <div className="flex gap-2 mb-2">
            <Inp placeholder="Add value…" value={pvInput} onChange={e => setPvInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addPv()} />
            <button onClick={addPv} className="bg-white/8 hover:bg-white/15 text-white/60 hover:text-white px-3 rounded-lg text-xs transition">Add</button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(field.picklistValues || []).map((v, i) => (
              <span key={i} className="inline-flex items-center gap-1 bg-white/8 text-white/60 text-xs px-2 py-1 rounded-md">
                {v}<button onClick={() => onChange({ ...field, picklistValues: field.picklistValues.filter((_, j) => j !== i) })}><X size={10} /></button>
              </span>
            ))}
            {!field.picklistValues?.length && <span className="text-xs text-white/25 italic">No values yet</span>}
          </div>
        </Fld>
      )}
      {field.type === 'Lookup' && (
        <Fld label="Related Object" required>
          <Sel value={field.referenceTo || ''} onChange={e => onChange({ ...field, referenceTo: e.target.value })}>
            <option value="">Select object…</option>
            {[...STANDARD_OBJECTS, ...(objects || []).map(o => o.apiName)].map(o => <option key={o} value={o}>{o}</option>)}
          </Sel>
        </Fld>
      )}
      {field.type === 'Formula' && (
        <div className="space-y-2">
          <Fld label="Return Type">
            <Sel value={field.formulaReturnType || 'Text'} onChange={e => onChange({ ...field, formulaReturnType: e.target.value })}>
              {['Text','Number','Currency','Date','DateTime','Checkbox','Percent'].map(t => <option key={t} value={t}>{t}</option>)}
            </Sel>
          </Fld>
          <Fld label="Formula">
            <textarea rows={2} value={field.formula || ''} onChange={e => onChange({ ...field, formula: e.target.value })}
              placeholder="e.g. FirstName & ' ' & LastName"
              className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-xs text-white font-mono placeholder-white/20 focus:outline-none focus:border-[#6366f1] transition resize-none" />
          </Fld>
        </div>
      )}
      <div className="flex items-center gap-4">
        {field.type !== 'Checkbox' && field.type !== 'Formula' && (
          <label className="flex items-center gap-1.5 text-xs text-white/45 cursor-pointer shrink-0">
            <input type="checkbox" checked={!!field.required} onChange={e => onChange({ ...field, required: e.target.checked })} className="accent-[#6366f1] w-3.5 h-3.5" />
            Required
          </label>
        )}
        <Inp placeholder="Help text (optional)" value={field.helpText || ''} onChange={e => onChange({ ...field, helpText: e.target.value })} />
      </div>
    </div>
  );
}

// ── Summary row ───────────────────────────────────────────────────────────────
function SummaryRow({ label, value }) {
  return (
    <div className="flex gap-4 py-1.5 border-b border-white/5 last:border-0 text-sm">
      <span className="text-white/35 w-36 shrink-0">{label}</span>
      <span className="text-white/75">{value}</span>
    </div>
  );
}

function getFieldIssue(field) {
  if (!field.label?.trim()) return 'Field label is required.';
  if (!field.apiName?.trim()) return `${field.label}: API name is required.`;
  if (field.type === 'Picklist' && !field.picklistValues?.length) return `${field.label}: add at least one picklist value.`;
  if (field.type === 'Lookup' && !field.referenceTo) return `${field.label}: select a related object.`;
  if (field.type === 'Formula' && !field.formula?.trim()) return `${field.label}: formula is required.`;
  return null;
}

function readFirst(obj, keys, fallback = '') {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return fallback;
}

function inferObjectLabelFromPrompt(prompt = '') {
  const quoted = prompt.match(/(?:called|named)\s+["']?([A-Z][A-Za-z0-9 ]{2,60}?)(?:["']?\s+(?:with|that|for|and|$))/i);
  if (quoted?.[1]) return quoted[1].trim();
  const objectPhrase = prompt.match(/(?:object|custom object)\s+(?:called|named)?\s*["']?([A-Z][A-Za-z0-9 ]{2,60}?)(?:["']?\s+(?:with|that|for|and|$))/i);
  return objectPhrase?.[1]?.trim() || '';
}

function inferFieldType(label = '') {
  const lower = label.toLowerCase();
  if (/\b(date|due|deadline|birthday|renewal)\b/.test(lower)) return 'Date';
  if (/\b(notes?|comments?|description|summary)\b/.test(lower)) return 'LongTextArea';
  if (/\b(email)\b/.test(lower)) return 'Email';
  if (/\b(phone|mobile)\b/.test(lower)) return 'Phone';
  if (/\b(url|website|link)\b/.test(lower)) return 'URL';
  if (/\b(amount|price|cost|revenue|budget)\b/.test(lower)) return 'Currency';
  if (/\b(percent|rate|ratio)\b/.test(lower)) return 'Percent';
  if (/\bcount|number|score|quantity\b/.test(lower)) return 'Number';
  if (/\bactive|approved|flag|is\s+|has\s+/i.test(label)) return 'Checkbox';
  if (/\b(status|stage|type|category|priority|approval)\b/.test(lower)) return 'Picklist';
  return 'Text';
}

function fieldFromHint(hint) {
  const raw = typeof hint === 'string' ? { label: hint } : hint || {};
  const label = readFirst(raw, ['label', 'fieldLabel', 'field_label', 'name', 'apiName'], '').replace(/__c$/i, '').replace(/_/g, ' ').trim();
  if (!label) return null;
  if (/^owner$/i.test(label)) return { builtInOwner: true };

  const type = readFirst(raw, ['type', 'fieldType', 'field_type'], inferFieldType(label));
  const base = {
    label,
    apiName: readFirst(raw, ['apiName', 'api_name'], `${toApiName(label)}__c`),
    type,
    required: Boolean(raw.required),
    helpText: readFirst(raw, ['helpText', 'help_text', 'description'], ''),
    length: Number(raw.length || 255),
    picklistValues: Array.isArray(raw.picklistValues || raw.values) ? (raw.picklistValues || raw.values) : [],
    referenceTo: readFirst(raw, ['referenceTo', 'reference_to', 'targetObject'], ''),
    formula: readFirst(raw, ['formula'], ''),
    formulaReturnType: readFirst(raw, ['formulaReturnType', 'formula_return_type'], 'Text'),
    precision: Number(raw.precision || 18),
    scale: Number(raw.scale || 0),
  };

  if (base.type === 'Picklist' && base.picklistValues.length === 0) {
    if (/stage/i.test(label)) base.picklistValues = ['New', 'In Progress', 'Complete'];
    else if (/approval/i.test(label)) base.picklistValues = ['Pending', 'Approved', 'Rejected'];
    else if (/status/i.test(label)) base.picklistValues = ['New', 'Active', 'Inactive'];
  }
  return base;
}

function extractFieldHints(plan) {
  const data = plan?.extracted_data || {};
  const direct = data.fields || data.customFields || data.custom_fields || data.field_definitions;
  if (Array.isArray(direct)) return direct;

  const prompt = plan?.original_prompt || '';
  const match = prompt.match(/fields?\s+(?:for\s+)?(.+?)(?:\.|Enable|Give|Ask|$)/i);
  if (!match) return [];
  return match[1]
    .replace(/\band\b/g, ',')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

function profilePresetFromPlan(plan) {
  const text = `${plan?.original_prompt || ''} ${JSON.stringify(plan?.extracted_data || {})}`.toLowerCase();
  if (text.includes('standard') && text.includes('read')) return 'standard-read';
  if (text.includes('standard') && (text.includes('edit') || text.includes('full'))) return 'standard-edit';
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function ObjectsPage() {
  const location = useLocation();
  const copilotPlan = location.state?.copilotPlan;
  const appliedPlanRef = useRef(false);
  const appliedProfilePlanRef = useRef(false);
  const [user, setUser]     = useState(null);
  const [token, setToken]   = useState('');
  const [orgs, setOrgs]     = useState([]);
  const [orgId, setOrgId]   = useState('');
  const [objects, setObjects] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [tabStyles, setTabStyles] = useState([]);
  const [step, setStep]     = useState(0);
  const [result, setResult] = useState(null);
  const [copilotNotes, setCopilotNotes] = useState([]);
  const [deploying, setDeploying] = useState(false);
  const [deployPhase, setDeployPhase] = useState('');
  const [confirmDeploy, setConfirmDeploy] = useState(false);
  const deployAbortRef = useRef(null);

  // ── Step 0: Basics ───────────────────────────────────────────────────────
  const [label,         setLabel]         = useState('');
  const [pluralLabel,   setPluralLabel]   = useState('');
  const [apiSuffix,     setApiSuffix]     = useState('');
  const [description,   setDescription]  = useState('');
  const [nameFieldType, setNameFieldType] = useState('Text');
  const [sharingModel,  setSharingModel]  = useState('ReadWrite');
  const [autoApi,       setAutoApi]       = useState(true);

  // ── Step 1: Relationships ────────────────────────────────────────────────
  const [hasRelationship,    setHasRelationship]    = useState(null); // null=unanswered
  const [relType,            setRelType]            = useState('Lookup');
  const [relParentObject,    setRelParentObject]    = useState('Account');
  const [relFieldLabel,      setRelFieldLabel]      = useState('');
  const [relFieldApiName,    setRelFieldApiName]    = useState('');

  // ── Step 2: Features ─────────────────────────────────────────────────────
  const [createTab,      setCreateTab]      = useState(true);
  const [tabStyle,       setTabStyle]       = useState('Custom34: Handshaking');
  const [enableSearch,   setEnableSearch]   = useState(true);
  const [enableReports,  setEnableReports]  = useState(true);
  const [enableActivities,setEnableActivities] = useState(true);
  const [enableHistory,  setEnableHistory]  = useState(false);
  const [enableFeeds,    setEnableFeeds]    = useState(false);

  // ── Step 3: Profile access ───────────────────────────────────────────────
  const [profileAccess, setProfileAccess] = useState({}); // { profileId: 'read'|'edit'|'full'|null }

  // ── Step 4: Fields ───────────────────────────────────────────────────────
  const [fields, setFields] = useState([]);

  useEffect(() => {
    if (!copilotPlan || appliedPlanRef.current) return;
    appliedPlanRef.current = true;

    const data = copilotPlan.extracted_data || {};
    const prompt = copilotPlan.original_prompt || '';
    const inferredLabel = readFirst(data, ['objectLabel', 'object_label', 'label', 'name'], '') || inferObjectLabelFromPrompt(prompt);
    const notes = [];

    if (inferredLabel) {
      setLabel(inferredLabel);
      setPluralLabel(readFirst(data, ['pluralLabel', 'plural_label'], `${inferredLabel}s`));
      setApiSuffix(toApiName(readFirst(data, ['apiName', 'api_name'], inferredLabel).replace(/__c$/i, '')));
      setAutoApi(false);
    }

    setDescription(prev => prev || copilotPlan.interpreted_summary || prompt);

    const text = `${prompt} ${JSON.stringify(data)}`.toLowerCase();
    if (text.includes('enable reports') || text.includes('reports')) setEnableReports(true);
    if (text.includes('enable search') || text.includes('search')) setEnableSearch(true);
    if (text.includes('enable activities') || text.includes('activities')) setEnableActivities(true);
    if (text.includes('create a tab') || text.includes('add a tab') || text.includes('tab')) setCreateTab(true);
    if (text.includes('chatter')) setEnableFeeds(true);
    if (text.includes('history')) setEnableHistory(true);

    const builtFields = [];
    for (const hint of extractFieldHints(copilotPlan)) {
      const field = fieldFromHint(hint);
      if (!field) continue;
      if (field.builtInOwner) {
        notes.push('Owner is built into every custom object, so SF Copilot will use the standard Owner field instead of creating a duplicate custom Owner field.');
        continue;
      }
      builtFields.push(field);
    }
    if (builtFields.length) setFields(builtFields);

    setHasRelationship(false);
    setCopilotNotes(notes);
  }, [copilotPlan]);

  useEffect(() => {
    if (!copilotPlan || appliedProfilePlanRef.current || profiles.length === 0) return;
    const preset = profilePresetFromPlan(copilotPlan);
    if (!preset) return;
    appliedProfilePlanRef.current = true;
    applyAdminProfilePreset(preset);
  }, [copilotPlan, profiles]);

  useEffect(() => {
    let alive = true;
    async function loadOrgs(u, t) {
      try {
        const { data: od } = await axios.get(`${API}/api/orgs`, {
          params: { userId: u.id },
          headers: { Authorization: `Bearer ${t}` },
        });
        if (!alive) return;
        const list = od.orgs || [];
        setOrgs(list);
        setOrgId(prev => prev || list[0]?.id || '');
      } catch {
        if (alive) setOrgs([]);
      }
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      const u = data.session?.user || null;
      const t = data.session?.access_token || '';
      setUser(u); setToken(t);
      if (u && t) loadOrgs(u, t);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      const u = session?.user || null;
      const t = session?.access_token || '';
      setUser(u); setToken(t);
      if (u && t) loadOrgs(u, t);
    });

    return () => {
      alive = false;
      subscription?.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!orgId || !token) return;
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      axios.get(`${API}/api/objects/list`,       { params: { orgId }, headers: h }),
      axios.get(`${API}/api/objects/tab-styles`, { params: { orgId }, headers: h }),
      axios.get(`${API}/api/users/profiles`,     { params: { orgId }, headers: h }),
    ]).then(([objR, tabR, profR]) => {
      setObjects(objR.data.objects || []);
      setTabStyles(tabR.data.tabStyles || []);
      setProfiles(profR.data.profiles || []);
    }).catch(() => {});
  }, [orgId, token]);

  useEffect(() => { if (autoApi) setApiSuffix(toApiName(label)); }, [label, autoApi]);

  function addField() {
    setFields(f => [...f, { label: '', apiName: '', type: 'Text', required: false, helpText: '', length: 255, picklistValues: [], referenceTo: '', formula: '', formulaReturnType: 'Text', precision: 18, scale: 0 }]);
  }

  function setProfileLevel(profileId, level) {
    setProfileAccess(prev => ({ ...prev, [profileId]: prev[profileId] === level ? null : level }));
  }

  function applyAdminProfilePreset(preset) {
    if (preset === 'clear') {
      setProfileAccess({});
      return;
    }
    const next = {};
    profiles.forEach(profile => {
      const name = profile.name.toLowerCase();
      if (name.includes('system administrator')) next[profile.id] = 'full';
      else if (preset === 'standard-edit' && name.includes('standard')) next[profile.id] = 'edit';
      else if (preset === 'standard-read' && name.includes('standard')) next[profile.id] = 'read';
    });
    setProfileAccess(next);
  }

  const step0Valid = label && apiSuffix;
  const step1Valid = hasRelationship === false || (hasRelationship === true && relParentObject && relFieldLabel);
  const step2Valid = createTab !== null && enableSearch !== null && enableReports !== null && enableActivities !== null && enableHistory !== null && enableFeeds !== null;
  const fieldIssues = fields.map(getFieldIssue).filter(Boolean);
  const step4Valid = fieldIssues.length === 0;
  const canGoNext =
    (step === 0 && step0Valid) ||
    (step === 1 && step1Valid) ||
    (step === 2 && step2Valid) ||
    step === 3 ||
    (step === 4 && step4Valid);

  async function handleDeploy() {
    setResult(null);
    setDeploying(true);
    const h = { Authorization: `Bearer ${token}` };

    try {
      // ── Enqueue the full deploy sequence as one BullMQ job ─────────────────
      // Returns immediately with { jobId } — no waiting for Metadata API polls.
      const { data: queued } = await axios.post(`${API}/api/objects/deploy-full`, {
        orgId,
        label,
        pluralLabel: pluralLabel || `${label}s`,
        apiNameSuffix: apiSuffix,
        nameFieldType,
        nameFieldLabel,
        sharingModel,
        description,
        enableActivities: enableActivities !== false,
        enableFeeds,
        enableReports: enableReports !== false,
        enableSearch: enableSearch !== false,
        enableHistory: enableHistory === true,
        createTab: createTab === true,
        tabStyle,
        hasRelationship,
        relType,
        relParentObject,
        relFieldLabel,
        relFieldApiName,
        fields: fields.filter(f => f.label && f.type),
        profileAccess,
      }, { headers: h });

      const { jobId } = queued;

      // ── Poll /api/jobs/:jobId every 3 seconds until done ───────────────────
      await new Promise((resolve, reject) => {
        const poll = setInterval(async () => {
          try {
            const { data: job } = await axios.get(`${API}/api/jobs/${jobId}`, { headers: h });
            // Update progress label while running
            if (job.phase && job.status === 'running') {
              setDeployPhase(job.phase);
            }
            if (job.status === 'completed') {
              clearInterval(poll);
              const res = job.result || {};
              setResult({
                success: true,
                apiName: res.apiName,
                setupUrl: res.setupUrl,
                tabCreated: res.tabCreated || false,
                repaired: res.repaired || false,
                warnings: [
                  res.tabWarning,
                  res.fieldsWarning,
                  res.repaired ? 'Object metadata was auto-repaired before deploy.' : null,
                ].filter(Boolean),
              });
              resolve();
            } else if (job.status === 'failed') {
              clearInterval(poll);
              reject(new Error(job.error || 'Deploy failed'));
            }
          } catch (pollErr) {
            clearInterval(poll);
            reject(pollErr);
          }
        }, 3000);
      });

    } catch (err) {
      setResult({ success: false, error: err.response?.data?.error || err.message });
    } finally {
      setDeploying(false);
      setDeployPhase('');
    }
  }

  // Legacy sequential deploy kept for single-field and tab-only operations
  async function handleLegacyDeploy() {
    setResult(null);
    setDeploying(true);
    const controller = new AbortController();
    deployAbortRef.current = controller;
    const h = { Authorization: `Bearer ${token}` };
    const postWarnings = [];
    try {
      const { data: obj } = await axios.post(`${API}/api/objects/create`, {
        orgId, label, pluralLabel: pluralLabel || `${label}s`, apiNameSuffix: apiSuffix,
        nameFieldType, sharingModel, description,
        enableActivities: enableActivities !== false,
        enableFeeds, enableReports: enableReports !== false,
        enableSearch: enableSearch !== false,
        enableHistory: enableHistory === true,
        createTab: false,
      }, { headers: h, signal: controller.signal });
      const objectApiName = obj.apiName;
      let tabCreated = false;
      if (obj.repaired) postWarnings.push('Object metadata was auto-repaired.');
      if (createTab === true) {
        try {
          const { data: tabResult } = await axios.post(`${API}/api/objects/create-tab`, { orgId, objectApiName, tabStyle }, { headers: h, signal: controller.signal });
          tabCreated = true;
          if (tabResult.repaired) postWarnings.push(tabResult.repairReason || 'Tab style was auto-repaired.');
        } catch (err) {
          if (axios.isCancel?.(err) || err.name === 'CanceledError') throw err;
          postWarnings.push(`Tab was not created: ${err.response?.data?.error || err.message}`);
        }
      }

      // Grant profile access
      const accessEntries = Object.entries(profileAccess).filter(([, level]) => level);
      if (accessEntries.length > 0) {
        try {
          const { data: accessResult } = await axios.post(`${API}/api/objects/grant-access`, {
            orgId, objectApiName,
            profileAccess: Object.fromEntries(accessEntries),
          }, { headers: h, signal: controller.signal });
          if (accessResult.repaired) postWarnings.push('Profile access metadata was auto-repaired before deploy.');
        } catch (err) {
          if (axios.isCancel?.(err) || err.name === 'CanceledError') throw err;
          throw new Error(`Object${tabCreated ? ', tab' : ''} and fields were created, but profile access failed. ${err.response?.data?.error || err.message}`);
        }
      }

      const successMsg = [
        `${objectApiName} created`,
        tabCreated ? 'tab added' : null,
        hasRelationship ? `${relType} to ${relParentObject} added` : null,
        fields.length ? `${fields.length} field(s) added` : null,
        accessEntries.length ? `access granted to ${accessEntries.length} profile(s)` : null,
      ].filter(Boolean).join(' · ');

      setResult({ type: 'success', message: successMsg, errors: postWarnings, setupUrl: obj.setupUrl });

      // Reset wizard
      setStep(0); setLabel(''); setPluralLabel(''); setApiSuffix(''); setDescription('');
      setNameFieldType('Text'); setSharingModel('ReadWrite');
      setHasRelationship(null); setRelType('Lookup'); setRelParentObject('Account'); setRelFieldLabel('');
      setCreateTab(true); setEnableSearch(true); setEnableReports(true); setEnableActivities(true); setEnableHistory(false); setEnableFeeds(false);
      setProfileAccess({}); setFields([]); setConfirmDeploy(false);
    } catch (err) {
      if (axios.isCancel?.(err) || err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
        setResult({ type: 'error', message: 'Deploy cancelled from the app. If Salesforce already received a Metadata API request, check Setup before retrying.' });
      } else {
        setResult({ type: 'error', message: err.response?.data?.error || err.message, errors: err.response?.data?.errors });
      }
    } finally {
      deployAbortRef.current = null;
      setDeploying(false);
    }
  }

  function cancelDeploy() {
    deployAbortRef.current?.abort();
    setDeploying(false);
    setResult({ type: 'error', message: 'Deploy cancelled. No further app-side steps will run.' });
  }

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 overflow-auto">

        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Custom Object Builder</h1>
            <p className="text-white/35 text-sm mt-1">Guided wizard — every decision explained.</p>
          </div>
          <Sel value={orgId} onChange={e => setOrgId(e.target.value)} style={{ width: 200 }}>
            {orgs.length === 0 ? <option value="">No orgs connected</option> : orgs.map(o => <option key={o.id} value={o.id}>{o.org_name}</option>)}
          </Sel>
        </div>

        {result && <div className="mb-5 max-w-2xl"><ResultBanner result={result} onClear={() => setResult(null)} /></div>}

        {copilotPlan && (
          <div className="mb-5 max-w-2xl bg-[#6366f1]/10 border border-[#6366f1]/25 rounded-2xl px-5 py-4">
            <div className="flex items-start gap-3">
              <Sparkles size={17} className="text-[#818cf8] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">Copilot plan loaded</p>
                <p className="text-xs text-white/45 mt-1">{copilotPlan.interpreted_summary || copilotPlan.original_prompt}</p>
                {copilotPlan.missing_info?.length > 0 && (
                  <p className="text-xs text-yellow-300/80 mt-2">Missing details: {copilotPlan.missing_info.join(', ')}</p>
                )}
                {copilotNotes.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {copilotNotes.map((note, i) => (
                      <p key={i} className="text-xs text-[#a5b4fc]">{note}</p>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step indicator */}
        <div className="flex items-center gap-1 mb-7 overflow-x-auto pb-1">
          {STEPS.map((s, i) => (
            <div key={i} className="flex items-center gap-1 shrink-0">
              <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition cursor-default ${
                i === step ? 'bg-[#6366f1] text-white' : i < step ? 'bg-green-500/15 text-green-400' : 'bg-white/5 text-white/25'
              }`}>
                {i < step ? <CheckCircle size={10} /> : <span className="w-3.5 text-center font-bold">{i + 1}</span>}
                {s.label}
              </div>
              {i < STEPS.length - 1 && <ChevronRight size={12} className="text-white/15 shrink-0" />}
            </div>
          ))}
        </div>

        <div className="max-w-2xl space-y-4">

          {/* ── STEP 0: Basics ── */}
          {step === 0 && (
            <div className="bg-[#1c1c1f] border border-white/8 rounded-2xl p-6 space-y-5">
              <div>
                <p className="text-xs font-semibold text-white/50 uppercase tracking-wider">Object Basics</p>
                <p className="text-xs text-white/30 mt-1">Start with the names and record visibility an admin would normally choose in Object Manager.</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Fld label="Object Label" required hint="Singular display name, e.g. 'Work Order'">
                  <Inp placeholder="e.g. Work Order" value={label} onChange={e => setLabel(e.target.value)} />
                </Fld>
                <Fld label="Plural Label">
                  <Inp placeholder="e.g. Work Orders" value={pluralLabel} onChange={e => setPluralLabel(e.target.value)} />
                </Fld>
              </div>

              <Fld label="API Name" required hint="No spaces. __c added automatically.">
                <div className="flex items-center gap-2">
                  <Inp value={apiSuffix} onChange={e => { setApiSuffix(e.target.value); setAutoApi(false); }} />
                  <span className="text-white/30 text-sm shrink-0">__c</span>
                </div>
                <p className="text-xs text-white/25 mt-1">Full name: <code className="text-white/50">{apiSuffix}__c</code></p>
              </Fld>

              <Fld label="Name Field — how is each record identified?">
                <div className="flex gap-2">
                  {[{ v: 'Text', l: 'Text name (user types it)' }, { v: 'AutoNumber', l: 'Auto number (AN-0001, 0002…)' }].map(o => (
                    <button key={o.v} type="button" onClick={() => setNameFieldType(o.v)}
                      className={`flex-1 py-2 rounded-xl text-xs font-medium border transition ${nameFieldType === o.v ? 'border-[#6366f1] bg-[#6366f1]/10 text-[#6366f1]' : 'border-white/10 text-white/40 hover:border-white/20'}`}>
                      {o.l}
                    </button>
                  ))}
                </div>
              </Fld>

              <Fld label="Sharing Model — who can see records by default?">
                <div className="space-y-2">
                  {SHARING_MODELS.map(m => (
                    <label key={m.value} className="flex items-start gap-3 cursor-pointer group">
                      <input type="radio" name="sharing" value={m.value} checked={sharingModel === m.value} onChange={() => setSharingModel(m.value)} className="accent-[#6366f1] mt-0.5 shrink-0" />
                      <div>
                        <p className="text-sm text-white/70 group-hover:text-white transition">{m.label}</p>
                        <p className="text-xs text-white/30">{m.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </Fld>

              <Fld label="Description (optional)">
                <textarea rows={2} value={description} onChange={e => setDescription(e.target.value)}
                  placeholder="What is this object used for?"
                  className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white placeholder-white/20 focus:outline-none focus:border-[#6366f1] transition resize-none" />
              </Fld>
            </div>
          )}

          {/* ── STEP 1: Relationships ── */}
          {step === 1 && (
            <div className="space-y-4">
              <Question
                q="Is this object related to another Salesforce object?"
                hint="A relationship lets you link records together. E.g. a Work Order belongs to an Account."
                value={hasRelationship}
                onChange={setHasRelationship}
              >
                <Fld label="Relationship type">
                  <div className="flex gap-2">
                    {[{ v: 'Lookup', l: 'Lookup', d: 'Optional link — parent can be deleted' },
                      { v: 'MasterDetail', l: 'Master-Detail', d: 'Required link — child deleted with parent' }].map(o => (
                      <button key={o.v} type="button" onClick={() => setRelType(o.v)}
                        className={`flex-1 p-2.5 rounded-xl text-xs font-medium border text-left transition ${relType === o.v ? 'border-[#6366f1] bg-[#6366f1]/10 text-[#6366f1]' : 'border-white/10 text-white/45 hover:border-white/20'}`}>
                        <p>{o.l}</p>
                        <p className="text-[10px] opacity-60 mt-0.5">{o.d}</p>
                      </button>
                    ))}
                  </div>
                </Fld>
                <Fld label="Parent object" required>
                  <Sel value={relParentObject} onChange={e => setRelParentObject(e.target.value)}>
                    {[...STANDARD_OBJECTS, ...(objects || []).map(o => o.apiName)].map(o => <option key={o} value={o}>{o}</option>)}
                  </Sel>
                </Fld>
                <Fld label="Relationship field label" required hint="This is the field name on the new object that points to the parent">
                  <Inp placeholder={`e.g. ${relParentObject}`}
                    value={relFieldLabel}
                    onChange={e => { setRelFieldLabel(e.target.value); setRelFieldApiName(toApiName(e.target.value) + '__c'); }} />
                </Fld>
              </Question>
            </div>
          )}

          {/* ── STEP 2: Features ── */}
          {step === 2 && (
            <div className="space-y-4">
              <Question
                q="Should users see a Tab for this object in the navigation?"
                hint="Recommended for user-facing objects. Skip for behind-the-scenes junction/config objects."
                value={createTab} onChange={setCreateTab}
                yesLabel="Yes, add a tab" noLabel="No tab"
              >
                <Fld label="Tab icon">
                  <div className="grid grid-cols-4 gap-1.5">
                    {tabStyles.map(ts => (
                      <button key={ts.value} type="button" onClick={() => setTabStyle(ts.value)}
                        className={`px-2 py-1.5 rounded-lg border text-xs transition ${tabStyle === ts.value ? 'border-[#6366f1] bg-[#6366f1]/10 text-[#6366f1]' : 'border-white/8 text-white/40 hover:border-white/20'}`}>
                        {ts.label}
                      </button>
                    ))}
                  </div>
                </Fld>
              </Question>

              <Question
                q="Should records from this object appear in global search results?"
                hint="Recommended when users need to find records by name. Disable for high-volume technical objects or private audit/config records."
                value={enableSearch} onChange={setEnableSearch}
                yesLabel="Searchable" noLabel="Hide from search"
              />

              <Question
                q="Should this object be available in Reports and Dashboards?"
                hint="Recommended for business-owned objects. Disable only for internal/system objects that should not be analyzed."
                value={enableReports} onChange={setEnableReports}
                yesLabel="Allow reporting" noLabel="No reports"
              />

              <Question
                q="Should users be able to log Activities (Tasks and Events) on these records?"
                hint="Recommended when people call, email, meet, or follow up around these records."
                value={enableActivities} onChange={setEnableActivities}
                yesLabel="Enable activities" noLabel="No activities"
              />

              <Question
                q="Enable Field History Tracking?"
                hint="Useful for compliance and important status fields. It can add storage/noise, so keep it intentional."
                value={enableHistory} onChange={setEnableHistory}
                yesLabel="Track history" noLabel="Skip history"
              />

              <Question
                q="Enable Chatter feed on records?"
                hint="Useful when teams collaborate on records. Skip if the object is transactional or should stay quiet."
                value={enableFeeds} onChange={setEnableFeeds}
                yesLabel="Enable Chatter" noLabel="No Chatter"
              />
            </div>
          )}

          {/* ── STEP 3: Profile access ── */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="bg-[#1c1c1f] border border-white/8 rounded-2xl p-5 space-y-4">
                <div>
                  <p className="text-sm font-medium text-white">Which profiles should have access to this object?</p>
                  <p className="text-xs text-white/35 mt-1">
                    Least privilege first: give admins full access, then choose whether business users need read-only or edit access.
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => applyAdminProfilePreset('standard-edit')}
                    className="text-xs bg-[#6366f1]/15 hover:bg-[#6366f1]/25 text-[#6366f1] border border-[#6366f1]/20 px-3 py-1.5 rounded-lg transition">
                    Admin full + Standard edit
                  </button>
                  <button type="button" onClick={() => applyAdminProfilePreset('standard-read')}
                    className="text-xs bg-white/5 hover:bg-white/10 text-white/45 hover:text-white/70 border border-white/10 px-3 py-1.5 rounded-lg transition">
                    Admin full + Standard read
                  </button>
                  <button type="button" onClick={() => applyAdminProfilePreset('clear')}
                    className="text-xs bg-white/5 hover:bg-white/10 text-white/35 hover:text-white/65 border border-white/10 px-3 py-1.5 rounded-lg transition">
                    Configure later
                  </button>
                </div>

                {profiles.length === 0 && (
                  <p className="text-xs text-white/30 py-4 text-center">No profiles loaded — skip this step and configure access in Salesforce Setup</p>
                )}

                <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                  {profiles.map(p => {
                    const level = profileAccess[p.id];
                    return (
                      <div key={p.id} className={`flex items-center gap-3 px-3 py-3 rounded-xl border transition ${level ? 'border-[#6366f1]/30 bg-[#6366f1]/5' : 'border-white/6 bg-white/[0.02]'}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white/75 truncate">{p.name}</p>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {[
                            { v: 'read',  l: 'Read',       title: 'Can view records but not create or edit' },
                            { v: 'edit',  l: 'Read + Edit', title: 'Can view and edit records' },
                            { v: 'full',  l: 'Full',        title: 'Can view, create, edit, and delete records' },
                          ].map(opt => (
                            <button key={opt.v} type="button"
                              title={opt.title}
                              onClick={() => setProfileLevel(p.id, opt.v)}
                              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                                level === opt.v ? 'border-[#6366f1] bg-[#6366f1] text-white' : 'border-white/10 text-white/35 hover:border-white/25 hover:text-white/60'
                              }`}>
                              {opt.l}
                            </button>
                          ))}
                          {level && (
                            <button onClick={() => setProfileLevel(p.id, level)} className="text-white/20 hover:text-red-400 transition px-1">
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {Object.values(profileAccess).filter(Boolean).length > 0 && (
                  <p className="text-xs text-[#6366f1]/70">
                    {Object.values(profileAccess).filter(Boolean).length} profile(s) will be granted access after deployment.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── STEP 4: Fields ── */}
          {step === 4 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between bg-[#1c1c1f] border border-white/8 rounded-2xl p-4">
                <div>
                  <p className="text-sm font-medium text-white/70">Custom Fields</p>
                  <p className="text-xs text-white/30 mt-0.5">Optional — you can add fields from Setup later too</p>
                </div>
                <button onClick={addField}
                  className="inline-flex items-center gap-1.5 bg-[#6366f1]/15 hover:bg-[#6366f1]/25 border border-[#6366f1]/20 text-[#6366f1] text-xs font-medium px-3 py-2 rounded-lg transition">
                  <Plus size={12} /> Add Field
                </button>
              </div>
              {fields.length === 0 && (
                <div className="text-center py-8 text-xs text-white/20 border border-dashed border-white/8 rounded-2xl">
                  No fields yet — click "Add Field" or skip to Review
                </div>
              )}
              {fields.map((f, i) => (
                <FieldRow key={i} field={f} objects={objects}
                  onChange={u => setFields(fs => fs.map((x, j) => j === i ? u : x))}
                  onRemove={() => setFields(fs => fs.filter((_, j) => j !== i))} />
              ))}
              {fieldIssues.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 text-xs text-red-300 space-y-1">
                  {fieldIssues.map((issue, i) => <p key={i}>• {issue}</p>)}
                </div>
              )}
            </div>
          )}

          {/* ── STEP 5: Review & deploy ── */}
          {step === 5 && (
            <div className="bg-[#1c1c1f] border border-white/8 rounded-2xl p-6 space-y-4">
              <p className="text-xs font-semibold text-white/50 uppercase tracking-wider">Review & Deploy</p>
              <div className="space-y-0.5">
                <SummaryRow label="Object Label"    value={label} />
                <SummaryRow label="Plural Label"    value={pluralLabel || `${label}s`} />
                <SummaryRow label="API Name"        value={`${apiSuffix}__c`} />
                <SummaryRow label="Name Field"      value={nameFieldType === 'AutoNumber' ? 'Auto Number' : 'Text'} />
                <SummaryRow label="Sharing"         value={SHARING_MODELS.find(m => m.value === sharingModel)?.label} />
                <SummaryRow label="Relationship"    value={hasRelationship ? `${relType} → ${relParentObject} (${relFieldLabel})` : 'None'} />
                <SummaryRow label="Tab"             value={createTab ? `Yes — ${tabStyles.find(t => t.value === tabStyle)?.label || tabStyle}` : 'No'} />
                <SummaryRow label="Search"          value={enableSearch !== false ? 'Enabled' : 'Disabled'} />
                <SummaryRow label="Reports"         value={enableReports !== false ? 'Enabled' : 'Disabled'} />
                <SummaryRow label="Activities"      value={enableActivities !== false ? 'Enabled' : 'Disabled'} />
                <SummaryRow label="Field History"   value={enableHistory ? 'Enabled' : 'Disabled'} />
                <SummaryRow label="Chatter"         value={enableFeeds ? 'Enabled' : 'Disabled'} />
                <SummaryRow label="Profile Access"  value={(() => { const e = Object.entries(profileAccess).filter(([,v]) => v); return e.length ? e.map(([id, lvl]) => `${profiles.find(p => p.id === id)?.name || id} (${lvl})`).join(', ') : 'None configured'; })()} />
                <SummaryRow label="Custom Fields"   value={fields.length ? `${fields.length}: ${fields.map(f => f.label || '(unnamed)').join(', ')}` : 'None'} />
              </div>

              <div className="flex items-center gap-2 text-xs text-amber-400/70 bg-amber-500/8 border border-amber-500/12 rounded-lg px-3 py-2">
                <AlertTriangle size={11} />
                Object deploy runs first, then tab, fields, and profile access. Failed metadata steps are repaired once and retried, then the flow resumes from that step.
              </div>

              <label className="flex items-start gap-2 text-xs text-white/55 bg-white/[0.03] border border-white/8 rounded-xl px-3 py-2">
                <input
                  type="checkbox"
                  checked={confirmDeploy}
                  onChange={e => setConfirmDeploy(e.target.checked)}
                  className="accent-[#6366f1] mt-0.5 shrink-0"
                  disabled={deploying}
                />
                <span>I reviewed this configuration and want to deploy metadata to Salesforce.</span>
              </label>

              <div className="flex gap-2">
                <button
                  onClick={handleDeploy}
                  disabled={deploying || !confirmDeploy}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold px-5 py-3 rounded-xl text-sm transition shadow-lg shadow-[#6366f1]/20"
                >
                  {deploying ? <Loader2 size={15} className="animate-spin" /> : <Box size={15} />}
                  {deploying ? (deployPhase || 'Queuing deploy…') : `Deploy ${apiSuffix}__c to ${orgs.find(o => o.id === orgId)?.org_name || 'Salesforce'}`}
                </button>
                {deploying && (
                  <button
                    onClick={cancelDeploy}
                    className="inline-flex items-center justify-center gap-2 bg-red-500/15 hover:bg-red-500/25 text-red-300 border border-red-500/25 font-semibold px-4 py-3 rounded-xl text-sm transition"
                  >
                    <X size={14} /> Cancel
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Navigation */}
          <div className="flex items-center justify-between pt-1">
            {step > 0 ? (
              <button onClick={() => setStep(s => s - 1)}
                className="flex items-center gap-1.5 text-sm text-white/40 hover:text-white transition">
                <ChevronLeft size={14} /> Back
              </button>
            ) : <div />}

            {step < STEPS.length - 1 && (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!canGoNext}
                className="flex items-center gap-1.5 bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-40 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition">
                {step === 3 && Object.values(profileAccess).filter(Boolean).length === 0 ? 'Skip' :
                 step === 4 && fields.length === 0 ? 'Skip — Review' : 'Next'}
                <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
