import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  UserPlus, Users, UserMinus, KeyRound,
  CheckCircle, XCircle, AlertTriangle, Loader2,
  Upload, Search, X, Download, Info,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';
import LoadingButton from '../components/LoadingButton';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const TABS = [
  { key: 'create',      icon: UserPlus,  label: 'Create User' },
  { key: 'bulk',        icon: Users,     label: 'Bulk Create' },
  { key: 'deactivate',  icon: UserMinus, label: 'Deactivate' },
  { key: 'permissions', icon: KeyRound,  label: 'Assign Permissions' },
];

const TZ_OPTIONS = [
  { value: 'America/Los_Angeles', label: 'Pacific (LA)' },
  { value: 'America/Denver',      label: 'Mountain (Denver)' },
  { value: 'America/Chicago',     label: 'Central (Chicago)' },
  { value: 'America/New_York',    label: 'Eastern (New York)' },
  { value: 'Europe/London',       label: 'London (GMT/BST)' },
  { value: 'Europe/Paris',        label: 'Central Europe (Paris)' },
  { value: 'Asia/Kolkata',        label: 'India (IST)' },
  { value: 'Asia/Singapore',      label: 'Singapore (SGT)' },
  { value: 'Australia/Sydney',    label: 'Sydney (AEDT)' },
];

function readFirst(obj, keys, fallback = '') {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return fallback;
}

function inferUserTab(plan) {
  const text = `${plan?.intent_type || ''} ${plan?.original_prompt || ''}`.toLowerCase();
  if (text.includes('bulk')) return 'bulk';
  if (text.includes('deactivate') || text.includes('offboard')) return 'deactivate';
  if (text.includes('permission') || text.includes('access')) return 'permissions';
  return 'create';
}

function splitName(fullName = '') {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: '', lastName: parts[0] || '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts.at(-1) };
}

function inferEmail(prompt = '') {
  return prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
}

// ── Shared field component ────────────────────────────────────────────────────
function Field({ label, required, hint, children }) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-white/55">
        {label}
        {required && <span className="text-[#6366f1]">*</span>}
        {hint && (
          <span className="group relative cursor-help">
            <Info size={11} className="text-white/25" />
            <span className="hidden group-hover:block absolute left-4 top-0 z-50 w-52 bg-[#1c1c1f] border border-white/15 rounded-lg px-3 py-2 text-xs text-white/60 shadow-xl">
              {hint}
            </span>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function Input({ ...props }) {
  return (
    <input
      className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition"
      {...props}
    />
  );
}

function Select({ children, ...props }) {
  return (
    <select
      className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#6366f1] transition"
      {...props}
    >
      {children}
    </select>
  );
}

function ResultBanner({ result, onClear }) {
  if (!result) return null;
  const isSuccess = result.type === 'success';
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
      isSuccess
        ? 'bg-green-500/10 border-green-500/20 text-green-300'
        : 'bg-red-500/10 border-red-500/20 text-red-300'
    }`}>
      {isSuccess ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
      <div className="flex-1">
        <p className="font-medium">{result.message}</p>
        {result.detail && <p className="text-xs opacity-70 mt-1">{result.detail}</p>}
        {result.errors?.length > 0 && (
          <div className="mt-2 space-y-1">
            {result.errors.slice(0, 5).map((e, i) => (
              <p key={i} className="text-xs opacity-70">
                {e.row ? `Row ${e.row}: ` : ''}{e.error || e.message || JSON.stringify(e)}
              </p>
            ))}
            {result.errors.length > 5 && <p className="text-xs opacity-50">…and {result.errors.length - 5} more</p>}
          </div>
        )}
        {result.setupUrl && (
          <a href={result.setupUrl} target="_blank" rel="noreferrer"
            className="inline-block mt-2 text-xs underline opacity-70 hover:opacity-100">
            View user in Salesforce Setup →
          </a>
        )}
      </div>
      <button onClick={onClear} className="text-white/30 hover:text-white/70 mt-0.5"><X size={14} /></button>
    </div>
  );
}

// ── Tab: Create single user ───────────────────────────────────────────────────
function CreateUserTab({ orgId, token, profiles, roles, initialPlan }) {
  const appliedPlanRef = useRef(false);
  // New user fields — always visible first
  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [email,     setEmail]     = useState('');
  const [suggestedUsername, setSuggestedUsername] = useState('');

  // Mirror search state
  const [mirrorQuery,    setMirrorQuery]    = useState('');
  const [mirrorResults,  setMirrorResults]  = useState([]);
  const [mirrorSearching,setMirrorSearching]= useState(false);
  const [mirrorError,    setMirrorError]    = useState('');
  const [mirrorUser,     setMirrorUser]     = useState(null);
  const [mirrorLoading,  setMirrorLoading]  = useState(false);

  // Manual settings (shown when no mirror selected)
  const [profileId,      setProfileId]      = useState('');
  const [roleId,         setRoleId]         = useState('');
  const [timeZoneSidKey, setTimeZoneSidKey] = useState('America/Los_Angeles');

  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!initialPlan || appliedPlanRef.current) return;
    appliedPlanRef.current = true;
    const data = initialPlan.extracted_data || {};
    const prompt = initialPlan.original_prompt || '';
    const fullName = readFirst(data, ['fullName', 'full_name', 'name', 'userName', 'user_name'], '');
    const split = splitName(fullName);
    setFirstName(readFirst(data, ['firstName', 'first_name'], split.firstName));
    setLastName(readFirst(data, ['lastName', 'last_name'], split.lastName));
    setEmail(readFirst(data, ['email', 'userEmail', 'user_email'], inferEmail(prompt)));
  }, [initialPlan]);

  useEffect(() => {
    if (!initialPlan || profileId || profiles.length === 0) return;
    const text = `${initialPlan.original_prompt || ''} ${JSON.stringify(initialPlan.extracted_data || {})}`.toLowerCase();
    const wanted = profiles.find(p => text.includes(p.name.toLowerCase()));
    if (wanted) setProfileId(wanted.id);
  }, [initialPlan, profiles, profileId]);

  // Auto-suggest username from org naming convention
  useEffect(() => {
    if (!email || !orgId || !token) { setSuggestedUsername(''); return; }
    const t = setTimeout(async () => {
      try {
        const { data } = await axios.get(`${API}/api/users/suggest-username`,
          { params: { orgId, email }, headers: { Authorization: `Bearer ${token}` } });
        setSuggestedUsername(data.username || '');
      } catch { setSuggestedUsername(''); }
    }, 600);
    return () => clearTimeout(t);
  }, [email, orgId, token]);

  async function searchMirror() {
    if (!mirrorQuery.trim()) return;
    setMirrorSearching(true); setMirrorResults([]); setMirrorError('');
    try {
      const { data } = await axios.get(`${API}/api/users/mirror`,
        { params: { orgId, q: mirrorQuery }, headers: { Authorization: `Bearer ${token}` } });
      const users = data.users || [];
      setMirrorResults(users);
      if (users.length === 0) setMirrorError(`No active users found for "${mirrorQuery}"`);
    } catch (err) {
      setMirrorError(err.response?.data?.error || err.message || 'Search failed');
    } finally { setMirrorSearching(false); }
  }

  async function selectMirrorUser(user) {
    setMirrorLoading(true); setMirrorResults([]); setMirrorError('');
    try {
      const { data } = await axios.get(`${API}/api/users/mirror/${user.id}`,
        { params: { orgId }, headers: { Authorization: `Bearer ${token}` } });
      setMirrorUser(data.mirror);
      setMirrorQuery('');
    } catch (err) {
      setMirrorError(err.response?.data?.error || 'Could not load user config');
    } finally { setMirrorLoading(false); }
  }

  function clearMirror() {
    setMirrorUser(null); setMirrorQuery(''); setMirrorResults([]); setMirrorError('');
  }

  async function handleCreate() {
    setResult(null);
    try {
      const body = {
        orgId, firstName, lastName, email,
        ...(mirrorUser
          ? { mirrorUserId: mirrorUser.id }
          : { profileId, roleId: roleId || undefined, timeZoneSidKey }),
      };
      const { data } = await axios.post(`${API}/api/users/create`, body,
        { headers: { Authorization: `Bearer ${token}` } });

      const extras = [];
      if (data.permSetsAssigned) extras.push(`${data.permSetsAssigned} permission set(s) assigned`);
      if (data.groupsAdded)      extras.push(`${data.groupsAdded} group(s) added`);
      if (data.queuesAdded)      extras.push(`${data.queuesAdded} queue(s) added`);
      if (data.postErrors?.length) extras.push(...data.postErrors);

      setResult({
        type: 'success',
        message: `User created${data.mirrored ? ` — mirrored from ${mirrorUser.name}` : ''}`,
        detail: [`Username: ${data.username}`, ...extras].join(' · '),
        setupUrl: data.setupUrl,
      });
      // Reset
      setFirstName(''); setLastName(''); setEmail(''); setSuggestedUsername('');
      clearMirror(); setProfileId(''); setRoleId('');
    } catch (err) {
      setResult({ type: 'error', message: err.response?.data?.error || err.message });
    }
  }

  const canSubmit = lastName && email && (mirrorUser || profileId);

  return (
    <div className="space-y-4 max-w-lg">
      <ResultBanner result={result} onClear={() => setResult(null)} />

      {/* ── SECTION 1: New user details — always visible ── */}
      <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-4">
        <p className="text-xs font-semibold text-white/55 uppercase tracking-wider">New User</p>

        <div className="grid grid-cols-2 gap-3">
          <Field label="First Name">
            <Input placeholder="Jane" value={firstName} onChange={e => setFirstName(e.target.value)} />
          </Field>
          <Field label="Last Name" required>
            <Input placeholder="Smith" value={lastName} onChange={e => setLastName(e.target.value)} />
          </Field>
        </div>

        <Field label="Email" required hint="Login email. Username is auto-generated from org naming convention.">
          <Input type="email" placeholder="jane.smith@company.com"
            value={email} onChange={e => setEmail(e.target.value)} />
        </Field>

        {suggestedUsername && (
          <div className="flex items-center gap-2 text-xs text-white/40 bg-white/3 border border-white/8 rounded-lg px-3 py-2">
            <CheckCircle size={11} className="text-green-400 shrink-0" />
            <span>Username: <code className="text-white/65">{suggestedUsername}</code></span>
          </div>
        )}
      </div>

      {/* ── SECTION 2: Copy settings from existing user (optional) ── */}
      <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-white/55 uppercase tracking-wider">
            Copy settings from existing user
            <span className="ml-2 text-white/25 normal-case font-normal">optional</span>
          </p>
          {mirrorUser && (
            <button onClick={clearMirror} className="text-xs text-white/35 hover:text-red-400 transition flex items-center gap-1">
              <X size={11} /> Clear
            </button>
          )}
        </div>

        {/* Mirror selected — show card */}
        {mirrorUser ? (
          <div className="bg-[#6366f1]/8 border border-[#6366f1]/20 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#6366f1]/20 flex items-center justify-center text-sm font-bold text-[#6366f1] shrink-0">
                {mirrorUser.name.charAt(0)}
              </div>
              <div>
                <p className="text-sm font-medium text-white">{mirrorUser.name}</p>
                <p className="text-xs text-white/40">{mirrorUser.email}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs pt-1 border-t border-white/6">
              {[
                { label: 'Profile',         val: mirrorUser.profileName },
                { label: 'Role',            val: mirrorUser.roleName || '—' },
                { label: 'Permission Sets', val: mirrorUser.permissionSets.length ? `${mirrorUser.permissionSets.length} assigned` : 'None' },
                { label: 'Groups / Queues', val: `${mirrorUser.groups.length + mirrorUser.queues.length} memberships` },
                { label: 'Time Zone',       val: mirrorUser.timeZoneSidKey },
                { label: 'Locale',          val: mirrorUser.localeSidKey },
              ].map(({ label, val }) => (
                <div key={label}>
                  <span className="text-white/30">{label}: </span>
                  <span className="text-white/65">{val}</span>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-[#6366f1]/50">Everything above will be copied to the new user.</p>
          </div>
        ) : (
          /* Mirror search */
          <>
            <p className="text-xs text-white/35">
              Search for an existing user whose profile, role, permission sets, groups and queues you want to replicate.
            </p>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                <input
                  value={mirrorQuery}
                  onChange={e => { setMirrorQuery(e.target.value); setMirrorError(''); }}
                  onKeyDown={e => e.key === 'Enter' && searchMirror()}
                  placeholder="Name or email of existing user…"
                  className="w-full bg-[#111113] border border-white/12 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition"
                />
              </div>
              <button
                onClick={searchMirror}
                disabled={mirrorSearching || !mirrorQuery.trim()}
                className="inline-flex items-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/12 disabled:opacity-40 text-white/60 hover:text-white px-3 py-2 rounded-lg text-xs font-medium transition"
              >
                {mirrorSearching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                Search
              </button>
            </div>

            {mirrorError && (
              <p className="text-xs text-red-400/80 flex items-center gap-1.5">
                <XCircle size={11} /> {mirrorError}
              </p>
            )}

            {mirrorLoading && (
              <div className="flex items-center gap-2 text-xs text-white/40">
                <Loader2 size={12} className="animate-spin" /> Loading user config…
              </div>
            )}

            {mirrorResults.length > 0 && (
              <div className="border border-white/8 rounded-xl overflow-hidden">
                {mirrorResults.map(u => (
                  <button key={u.id} onClick={() => selectMirrorUser(u)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#6366f1]/8 border-b border-white/5 last:border-0 text-left transition group">
                    <div className="w-8 h-8 rounded-full bg-[#6366f1]/15 flex items-center justify-center text-xs font-bold text-[#6366f1] shrink-0">
                      {u.name.charAt(0)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white/80 group-hover:text-white transition">{u.name}</p>
                      <p className="text-xs text-white/35 truncate">{u.email} · {u.profile}</p>
                    </div>
                    <span className="text-xs text-[#6366f1] opacity-0 group-hover:opacity-100 transition">Use →</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── SECTION 3: Manual settings — only if no mirror ── */}
      {!mirrorUser && (
        <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-4">
          <p className="text-xs font-semibold text-white/55 uppercase tracking-wider">
            Settings <span className="text-red-400 font-normal normal-case text-[10px] ml-1">required when no mirror user</span>
          </p>
          <Field label="Profile" required>
            <Select value={profileId} onChange={e => setProfileId(e.target.value)}>
              <option value="">Select profile…</option>
              {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Role">
              <Select value={roleId} onChange={e => setRoleId(e.target.value)}>
                <option value="">No role</option>
                {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
            </Field>
            <Field label="Time Zone">
              <Select value={timeZoneSidKey} onChange={e => setTimeZoneSidKey(e.target.value)}>
                {TZ_OPTIONS.map(tz => <option key={tz.value} value={tz.value}>{tz.label}</option>)}
              </Select>
            </Field>
          </div>
        </div>
      )}

      {/* ── Create button ── */}
      <LoadingButton
        onClick={handleCreate}
        disabled={!canSubmit}
        loadingText="Creating user in Salesforce…"
        slowText="Assigning permissions — almost done…"
        slowThreshold={15000}
        className="w-full justify-center"
        variant="primary"
      >
        <><UserPlus size={15} />
        {mirrorUser ? `Create user — mirror of ${mirrorUser.name}` : 'Create User'}</>
      </LoadingButton>

      {!canSubmit && lastName && email && !profileId && !mirrorUser && (
        <p className="text-xs text-amber-400/70 text-center">
          Select a mirror user or choose a profile to continue
        </p>
      )}
    </div>
  );
}

// ── Tab: Bulk create ──────────────────────────────────────────────────────────
function BulkCreateTab({ orgId, token }) {
  const [file, setFile]     = useState(null);
  const [result, setResult] = useState(null);
  const fileRef             = useRef(null);

  async function handleBulk() {
    setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('orgId', orgId);
    try {
      const { data } = await axios.post(`${API}/api/users/bulk-create`, fd,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' } }
      );
      const allErrors = [...(data.validationErrors || []), ...(data.errors || [])];
      setResult({
        type: data.succeeded > 0 ? 'success' : 'error',
        message: `${data.succeeded} user(s) created, ${data.failed + (data.validationErrors?.length || 0)} failed`,
        errors: allErrors,
      });
    } catch (err) {
      setResult({ type: 'error', message: err.response?.data?.error || err.message });
    }
  }

  return (
    <div className="space-y-5 max-w-lg">
      <ResultBanner result={result} onClear={() => setResult(null)} />

      {/* Template download */}
      <div className="bg-[#27272a]/20 border border-white/8 rounded-xl p-4 text-xs text-white/50 space-y-2">
        <p className="text-white/70 font-medium">Expected CSV columns:</p>
        <code className="block text-[#6366f1]/80 bg-black/20 px-3 py-2 rounded-lg">
          FirstName, LastName, Email, ProfileName, RoleName, TimeZoneSidKey
        </code>
        <p>ProfileName and RoleName are resolved to IDs automatically. Usernames are auto-generated.</p>
        <button
          onClick={() => {
            const csv = 'FirstName,LastName,Email,ProfileName,RoleName,TimeZoneSidKey\nJane,Smith,jane.smith@co.com,Standard User,,America/Los_Angeles\nBob,Jones,bob.jones@co.com,Standard User,Sales Rep,America/New_York';
            const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
            a.download = 'users_template.csv'; a.click();
          }}
          className="inline-flex items-center gap-1.5 text-[#6366f1] hover:underline"
        >
          <Download size={11} /> Download template CSV
        </button>
      </div>

      {/* File upload */}
      <div
        onClick={() => fileRef.current?.click()}
        className={`border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition ${
          file ? 'border-green-500/40 bg-green-500/5' : 'border-white/15 hover:border-[#6366f1]/40 hover:bg-[#6366f1]/5'
        }`}
      >
        <Upload size={24} className="mx-auto mb-2 text-white/30" />
        {file ? (
          <p className="text-sm text-white/70">{file.name} <span className="text-white/30">({(file.size / 1024).toFixed(1)} KB)</span></p>
        ) : (
          <>
            <p className="text-sm text-white/50">Click to upload CSV or XLSX</p>
            <p className="text-xs text-white/25 mt-1">Max 10 MB</p>
          </>
        )}
        <input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden"
          onChange={e => { setFile(e.target.files?.[0] || null); setResult(null); }} />
      </div>

      {file && (
        <LoadingButton
          onClick={handleBulk}
          loadingText="Uploading to Salesforce…"
          slowText="Processing — this may take a minute for large files…"
          slowThreshold={20000}
          className="w-full justify-center"
          variant="primary"
        >
          <><Users size={15} /> Load {file.name}</>
        </LoadingButton>
      )}
    </div>
  );
}

// ── Tab: Deactivate users ─────────────────────────────────────────────────────
function DeactivateTab({ orgId, token }) {
  const [query, setQuery]     = useState('');
  const [users, setUsers]     = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected]   = useState(new Set());
  const [result, setResult]   = useState(null);

  async function search() {
    setSearching(true);
    try {
      const { data } = await axios.get(`${API}/api/users/search`,
        { params: { orgId, q: query, active: 'true' }, headers: { Authorization: `Bearer ${token}` } }
      );
      setUsers(data.users || []);
      setSelected(new Set());
    } catch (err) {
      setUsers([]);
    } finally { setSearching(false); }
  }

  function toggleUser(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleDeactivate() {
    setResult(null);
    try {
      const { data } = await axios.post(`${API}/api/users/deactivate`,
        { userIds: [...selected], orgId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setResult({
        type: data.succeeded > 0 ? 'success' : 'error',
        message: `${data.succeeded} user(s) deactivated, ${data.failed} failed`,
        errors: data.errors,
      });
      setUsers(u => u.filter(x => !selected.has(x.id)));
      setSelected(new Set());
    } catch (err) {
      setResult({ type: 'error', message: err.response?.data?.error || err.message });
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <ResultBanner result={result} onClear={() => setResult(null)} />

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Search by name, email, or username…"
            className="w-full bg-[#111113] border border-white/12 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition"
          />
        </div>
        <LoadingButton onClick={search} loadingText="Searching…" variant="ghost" className="shrink-0">
          <><Search size={13} /> Search</>
        </LoadingButton>
      </div>

      {searching && <div className="flex items-center gap-2 text-xs text-white/40"><Loader2 size={12} className="animate-spin" /> Searching org…</div>}

      {users.length > 0 && (
        <>
          <div className="text-xs text-white/40 flex items-center justify-between">
            <span>{users.length} active user(s) found · {selected.size} selected</span>
            <button onClick={() => setSelected(new Set(users.map(u => u.id)))} className="text-[#6366f1] hover:underline">Select all</button>
          </div>

          <div className="border border-white/8 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
            {users.map(u => (
              <label key={u.id}
                className={`flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-white/5 last:border-0 transition ${
                  selected.has(u.id) ? 'bg-red-500/8' : 'hover:bg-white/3'
                }`}>
                <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleUser(u.id)}
                  className="accent-red-500 w-4 h-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/80 truncate">{u.name}</p>
                  <p className="text-xs text-white/35 truncate">{u.email} · {u.profile}</p>
                </div>
                {u.lastLogin && (
                  <span className="text-xs text-white/25 shrink-0">
                    Last login {new Date(u.lastLogin).toLocaleDateString()}
                  </span>
                )}
              </label>
            ))}
          </div>

          {selected.size > 0 && (
            <div className="bg-red-500/8 border border-red-500/20 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-xs text-red-300">
                <AlertTriangle size={13} />
                Deactivating {selected.size} user(s) — this cannot be undone from this tool
              </div>
              <LoadingButton
                onClick={handleDeactivate}
                loadingText="Deactivating…"
                variant="danger"
                className="shrink-0 text-xs px-4 py-2"
              >
                <><UserMinus size={13} /> Deactivate {selected.size}</>
              </LoadingButton>
            </div>
          )}
        </>
      )}

      {!searching && users.length === 0 && query && (
        <p className="text-xs text-white/30 text-center py-6">No active users found for "{query}"</p>
      )}
    </div>
  );
}

// ── Tab: Assign permission sets ───────────────────────────────────────────────
function AssignPermissionsTab({ orgId, token, permissionSets }) {
  const [query, setQuery]         = useState('');
  const [users, setUsers]         = useState([]);
  const [searching, setSearching] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [selectedPs, setSelectedPs]       = useState(new Set());
  const [result, setResult]       = useState(null);

  async function search() {
    setSearching(true);
    try {
      const { data } = await axios.get(`${API}/api/users/search`,
        { params: { orgId, q: query, active: 'true' }, headers: { Authorization: `Bearer ${token}` } }
      );
      setUsers(data.users || []);
    } catch { setUsers([]); }
    finally { setSearching(false); }
  }

  function toggleUser(id) { setSelectedUsers(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }
  function togglePs(id)   { setSelectedPs(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  async function handleAssign() {
    setResult(null);
    try {
      const { data } = await axios.post(`${API}/api/users/assign-permissions`,
        { userIds: [...selectedUsers], permissionSetIds: [...selectedPs], orgId },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const msg = data.message ||
        `${data.succeeded} assignment(s) created${data.skipped ? `, ${data.skipped} skipped (already assigned)` : ''}, ${data.failed} failed`;
      setResult({
        type: data.succeeded > 0 || data.skipped > 0 ? 'success' : 'error',
        message: msg,
        errors: data.errors,
      });
    } catch (err) {
      setResult({ type: 'error', message: err.response?.data?.error || err.message });
    }
  }

  const canAssign = selectedUsers.size > 0 && selectedPs.size > 0;

  return (
    <div className="space-y-4 max-w-2xl">
      <ResultBanner result={result} onClear={() => setResult(null)} />

      <div className="grid grid-cols-2 gap-5">
        {/* Left: user search */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-white/50 uppercase tracking-wider">Users ({selectedUsers.size} selected)</p>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
              <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()}
                placeholder="Search users…"
                className="w-full bg-[#111113] border border-white/12 rounded-lg pl-8 pr-2 py-2 text-xs text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition" />
            </div>
            <button onClick={search} className="bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white px-2.5 rounded-lg transition">
              {searching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
            </button>
          </div>
          <div className="border border-white/8 rounded-xl overflow-hidden max-h-60 overflow-y-auto">
            {users.length === 0
              ? <p className="text-xs text-white/25 text-center py-8">Search for users above</p>
              : users.map(u => (
                <label key={u.id} className={`flex items-center gap-2.5 px-3 py-2.5 cursor-pointer border-b border-white/5 last:border-0 transition ${selectedUsers.has(u.id) ? 'bg-[#6366f1]/8' : 'hover:bg-white/3'}`}>
                  <input type="checkbox" checked={selectedUsers.has(u.id)} onChange={() => toggleUser(u.id)} className="accent-[#6366f1] w-3.5 h-3.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs text-white/80 truncate">{u.name}</p>
                    <p className="text-[10px] text-white/30 truncate">{u.profile}</p>
                  </div>
                </label>
              ))
            }
          </div>
        </div>

        {/* Right: permission set list */}
        <div className="space-y-3">
          <p className="text-xs font-semibold text-white/50 uppercase tracking-wider">Permission Sets ({selectedPs.size} selected)</p>
          <div className="border border-white/8 rounded-xl overflow-hidden max-h-72 overflow-y-auto">
            {permissionSets.length === 0
              ? <p className="text-xs text-white/25 text-center py-8">No permission sets found</p>
              : permissionSets.map(ps => (
                <label key={ps.id} className={`flex items-start gap-2.5 px-3 py-2.5 cursor-pointer border-b border-white/5 last:border-0 transition ${selectedPs.has(ps.id) ? 'bg-[#6366f1]/8' : 'hover:bg-white/3'}`}>
                  <input type="checkbox" checked={selectedPs.has(ps.id)} onChange={() => togglePs(ps.id)} className="accent-[#6366f1] w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs text-white/80">{ps.label}</p>
                    {ps.description && <p className="text-[10px] text-white/30 mt-0.5 line-clamp-1">{ps.description}</p>}
                  </div>
                </label>
              ))
            }
          </div>
        </div>
      </div>

      {canAssign && (
        <div className="bg-[#6366f1]/8 border border-[#6366f1]/20 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
          <p className="text-xs text-[#6366f1]/80">
            Assign {selectedPs.size} permission set(s) to {selectedUsers.size} user(s) — duplicates skipped automatically
          </p>
          <LoadingButton onClick={handleAssign} loadingText="Assigning…" variant="primary" className="shrink-0 text-xs px-4 py-2">
            <><KeyRound size={13} /> Assign</>
          </LoadingButton>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function UsersPage() {
  const location = useLocation();
  const copilotPlan = location.state?.copilotPlan;
  const [user, setUser]   = useState(null);
  const [token, setToken] = useState('');
  const [orgs, setOrgs]   = useState([]);
  const [orgId, setOrgId] = useState('');
  const [tab, setTab]     = useState('create');

  const [profiles, setProfiles]           = useState([]);
  const [roles, setRoles]                 = useState([]);
  const [permissionSets, setPermissionSets] = useState([]);
  const [orgDataLoading, setOrgDataLoading] = useState(false);

  useEffect(() => {
    if (copilotPlan) setTab(inferUserTab(copilotPlan));
  }, [copilotPlan]);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const u = data.session?.user || null;
      const t = data.session?.access_token || '';
      setUser(u); setToken(t);
      if (u) {
        const { data: orgsData } = await axios.get(`${API}/api/orgs`, { params: { userId: u.id }, headers: { Authorization: `Bearer ${t}` } });
        const list = orgsData.orgs || [];
        setOrgs(list);
        if (list.length) setOrgId(list[0].id);
      }
    });
  }, []);

  const loadOrgData = useCallback(async () => {
    if (!orgId || !token) return;
    setOrgDataLoading(true);
    try {
      const [pRes, rRes, psRes] = await Promise.all([
        axios.get(`${API}/api/users/profiles`,       { params: { orgId }, headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API}/api/users/roles`,           { params: { orgId }, headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API}/api/users/permission-sets`, { params: { orgId }, headers: { Authorization: `Bearer ${token}` } }),
      ]);
      setProfiles(pRes.data.profiles || []);
      setRoles(rRes.data.roles || []);
      setPermissionSets(psRes.data.permissionSets || []);
    } catch { /* show empty — user will see empty dropdowns */ }
    finally { setOrgDataLoading(false); }
  }, [orgId, token]);

  useEffect(() => { loadOrgData(); }, [loadOrgData]);

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 overflow-auto">

        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">User Management</h1>
            <p className="text-white/35 text-sm mt-1">Create, bulk-load, deactivate, and manage permissions for Salesforce users.</p>
          </div>

          {/* Org picker */}
          <div className="flex items-center gap-3">
            {orgDataLoading && <Loader2 size={14} className="animate-spin text-white/30" />}
            <select
              value={orgId}
              onChange={e => setOrgId(e.target.value)}
              className="bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#6366f1] transition min-w-[180px]"
            >
              {orgs.length === 0
                ? <option value="">No orgs connected</option>
                : orgs.map(o => <option key={o.id} value={o.id}>{o.org_name}</option>)
              }
            </select>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-white/8 mb-6">
          {TABS.map(({ key, icon: Icon, label }) => (
            <button key={key} onClick={() => setTab(key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
                tab === key
                  ? 'border-[#6366f1] text-[#6366f1]'
                  : 'border-transparent text-white/40 hover:text-white/70'
              }`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {/* No org warning */}
        {!orgId && (
          <div className="flex items-center gap-2 text-sm text-amber-400 bg-amber-500/8 border border-amber-500/15 rounded-xl px-4 py-3 mb-6">
            <AlertTriangle size={14} />
            No org connected. <a href="/orgs" className="underline ml-1">Connect an org →</a>
          </div>
        )}

        {copilotPlan && (
          <div className="mb-6 max-w-2xl bg-[#6366f1]/10 border border-[#6366f1]/25 rounded-2xl px-5 py-4">
            <div className="flex items-start gap-3">
              <UserPlus size={17} className="text-[#818cf8] shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">Copilot plan loaded</p>
                <p className="text-xs text-white/45 mt-1">{copilotPlan.interpreted_summary || copilotPlan.original_prompt}</p>
                {copilotPlan.missing_info?.length > 0 && (
                  <p className="text-xs text-yellow-300/80 mt-2">Missing details: {copilotPlan.missing_info.join(', ')}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab content */}
        {orgId && (
          <>
            {tab === 'create'      && <CreateUserTab      orgId={orgId} token={token} profiles={profiles} roles={roles} initialPlan={copilotPlan} />}
            {tab === 'bulk'        && <BulkCreateTab       orgId={orgId} token={token} />}
            {tab === 'deactivate'  && <DeactivateTab       orgId={orgId} token={token} />}
            {tab === 'permissions' && <AssignPermissionsTab orgId={orgId} token={token} permissionSets={permissionSets} />}
          </>
        )}
      </main>
    </div>
  );
}
