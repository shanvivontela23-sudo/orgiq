import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  KeyRound, Shield, Users, Search, Loader2, CheckCircle,
  XCircle, Plus, X, Info, AlertTriangle,
} from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';
import LoadingButton from '../components/LoadingButton';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const TABS = [
  { key: 'create', label: 'Create Permission Set', icon: KeyRound },
  { key: 'assign', label: 'Assign to Users', icon: Users },
];

function toApiName(label = '') {
  return label.trim().replace(/[^a-zA-Z0-9 _]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

function Field({ label, required, children, hint }) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-xs font-medium text-white/55">
        {label}{required && <span className="text-[#6366f1]">*</span>}
        {hint && (
          <span className="group relative cursor-help">
            <Info size={11} className="text-white/25" />
            <span className="hidden group-hover:block absolute left-4 top-0 z-50 w-60 bg-[#1c1c1f] border border-white/15 rounded-lg px-3 py-2 text-xs text-white/60 shadow-xl">
              {hint}
            </span>
          </span>
        )}
      </label>
      {children}
    </div>
  );
}

function Input(props) {
  return <input className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition" {...props} />;
}

function Select({ children, ...props }) {
  return <select className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#6366f1] transition" {...props}>{children}</select>;
}

function ResultBanner({ result, onClear }) {
  if (!result) return null;
  const ok = result.type === 'success';
  return (
    <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border text-sm ${
      ok ? 'bg-green-500/10 border-green-500/20 text-green-300' : 'bg-red-500/10 border-red-500/20 text-red-300'
    }`}>
      {ok ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
      <div className="flex-1">
        <p className="font-medium">{result.message}</p>
        {result.detail && <p className="text-xs opacity-70 mt-1">{result.detail}</p>}
        {result.errors?.map((e, i) => <p key={i} className="text-xs opacity-70 mt-1">{e.message || e.error || JSON.stringify(e)}</p>)}
        {result.setupUrl && (
          <a href={result.setupUrl} target="_blank" rel="noreferrer" className="inline-block mt-2 text-xs underline opacity-70 hover:opacity-100">
            View in Salesforce Setup →
          </a>
        )}
      </div>
      <button onClick={onClear} className="text-white/30 hover:text-white/70"><X size={14} /></button>
    </div>
  );
}

function PermissionToggles({ value, onChange }) {
  const options = [
    ['read', 'Read'],
    ['create', 'Create'],
    ['edit', 'Edit'],
    ['delete', 'Delete'],
    ['viewAll', 'View All'],
    ['modifyAll', 'Modify All'],
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange({ ...value, [key]: !value[key], read: key !== 'read' ? true : !value.read })}
          className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition ${
            value[key]
              ? 'bg-[#6366f1] border-[#6366f1] text-white'
              : 'border-white/10 text-white/35 hover:border-white/25 hover:text-white/60'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function PermissionsPage() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState('');
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState('');
  const [tab, setTab] = useState('create');

  const [permissionSets, setPermissionSets] = useState([]);
  const [objects, setObjects] = useState([]);
  const [fields, setFields] = useState([]);
  const [users, setUsers] = useState([]);

  const [loadingOrgData, setLoadingOrgData] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [result, setResult] = useState(null);

  const [label, setLabel] = useState('');
  const [apiName, setApiName] = useState('');
  const [description, setDescription] = useState('');
  const [license, setLicense] = useState('');
  const [selectedObject, setSelectedObject] = useState('');
  const [objectPermission, setObjectPermission] = useState({ read: true, create: false, edit: false, delete: false, viewAll: false, modifyAll: false });
  const [fieldAccess, setFieldAccess] = useState({});

  const [userQuery, setUserQuery] = useState('');
  const [selectedUsers, setSelectedUsers] = useState(new Set());
  const [selectedPermissionSets, setSelectedPermissionSets] = useState(new Set());

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      const u = data.session?.user || null;
      const t = data.session?.access_token || '';
      setUser(u); setToken(t);
      if (u) {
        const { data: od } = await axios.get(`${API}/api/orgs`, { params: { userId: u.id }, headers: { Authorization: `Bearer ${t}` } });
        const list = od.orgs || [];
        setOrgs(list);
        setOrgId(list[0]?.id || '');
      }
    });
  }, []);

  const headers = useMemo(() => token ? { Authorization: `Bearer ${token}` } : {}, [token]);

  const loadOrgData = useCallback(async () => {
    if (!orgId || !token) return;
    setLoadingOrgData(true);
    try {
      const [ps, objs] = await Promise.all([
        axios.get(`${API}/api/users/permission-sets`, { params: { orgId }, headers }),
        axios.get(`${API}/api/permissions/objects`, { params: { orgId }, headers }),
      ]);
      setPermissionSets(ps.data.permissionSets || []);
      setObjects(objs.data.objects || []);
    } finally {
      setLoadingOrgData(false);
    }
  }, [orgId, token, headers]);

  useEffect(() => { loadOrgData(); }, [loadOrgData]);
  useEffect(() => { if (label) setApiName(toApiName(label)); }, [label]);

  useEffect(() => {
    if (!selectedObject || !orgId || !token) { setFields([]); return; }
    setLoadingFields(true);
    setFieldAccess({});
    axios.get(`${API}/api/permissions/fields`, { params: { orgId, objectApiName: selectedObject }, headers })
      .then(({ data }) => setFields(data.fields || []))
      .catch(() => setFields([]))
      .finally(() => setLoadingFields(false));
  }, [selectedObject, orgId, token, headers]);

  async function createPermissionSet() {
    setResult(null);
    const fieldPermissions = Object.entries(fieldAccess)
      .filter(([, v]) => v.readable || v.editable)
      .map(([field, v]) => ({ field, readable: v.readable, editable: v.editable }));

    const objectPermissions = selectedObject ? [{ object: selectedObject, ...objectPermission }] : [];

    try {
      const { data } = await axios.post(`${API}/api/permissions/create`, {
        orgId,
        label,
        apiName,
        description,
        license,
        objectPermissions,
        fieldPermissions,
      }, { headers });
      setResult({
        type: 'success',
        message: `${data.label} created`,
        detail: `${fieldPermissions.length} field permission(s), ${objectPermissions.length} object permission block(s). Dry run passed before deploy.`,
        setupUrl: data.setupUrl,
      });
      setLabel(''); setApiName(''); setDescription(''); setLicense('');
      setSelectedObject(''); setObjectPermission({ read: true, create: false, edit: false, delete: false, viewAll: false, modifyAll: false });
      setFieldAccess({});
      loadOrgData();
    } catch (err) {
      setResult({ type: 'error', message: err.response?.data?.error || err.message, errors: err.response?.data?.errors });
    }
  }

  async function searchUsers() {
    if (!userQuery.trim()) return;
    setSearchingUsers(true);
    try {
      const { data } = await axios.get(`${API}/api/users/search`, { params: { orgId, q: userQuery, active: 'true' }, headers });
      setUsers(data.users || []);
    } catch {
      setUsers([]);
    } finally {
      setSearchingUsers(false);
    }
  }

  async function assignPermissionSets() {
    setResult(null);
    try {
      const { data } = await axios.post(`${API}/api/users/assign-permissions`, {
        orgId,
        userIds: [...selectedUsers],
        permissionSetIds: [...selectedPermissionSets],
      }, { headers });
      setResult({
        type: data.failed ? 'error' : 'success',
        message: data.message || `${data.succeeded} assignment(s) created, ${data.skipped || 0} skipped, ${data.failed || 0} failed`,
        errors: data.errors,
      });
      setSelectedUsers(new Set());
      setSelectedPermissionSets(new Set());
    } catch (err) {
      setResult({ type: 'error', message: err.response?.data?.error || err.message });
    }
  }

  const canCreate = orgId && label.trim() && apiName.trim();
  const canAssign = selectedUsers.size > 0 && selectedPermissionSets.size > 0;

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 overflow-auto">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Permission Management</h1>
            <p className="text-white/35 text-sm mt-1">Create permission sets, configure object and field access, and assign them to users.</p>
          </div>
          <div className="flex items-center gap-3">
            {loadingOrgData && <Loader2 size={14} className="animate-spin text-white/30" />}
            <Select value={orgId} onChange={e => setOrgId(e.target.value)} style={{ minWidth: 190 }}>
              {orgs.length === 0 ? <option value="">No orgs connected</option> : orgs.map(o => <option key={o.id} value={o.id}>{o.org_alias || o.org_name}</option>)}
            </Select>
          </div>
        </div>

        {result && <div className="mb-5 max-w-3xl"><ResultBanner result={result} onClear={() => setResult(null)} /></div>}

        <div className="flex gap-1 border-b border-white/8 mb-6">
          {TABS.map(({ key, icon: Icon, label: tabLabel }) => (
            <button key={key} onClick={() => setTab(key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition -mb-px ${
                tab === key ? 'border-[#6366f1] text-[#6366f1]' : 'border-transparent text-white/40 hover:text-white/70'
              }`}>
              <Icon size={14} /> {tabLabel}
            </button>
          ))}
        </div>

        {!orgId && (
          <div className="flex items-center gap-2 text-sm text-amber-400 bg-amber-500/8 border border-amber-500/15 rounded-xl px-4 py-3">
            <AlertTriangle size={14} /> Connect an org before managing permissions.
          </div>
        )}

        {orgId && tab === 'create' && (
          <div className="grid xl:grid-cols-[minmax(420px,560px)_1fr] gap-6">
            <section className="space-y-4">
              <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-wider text-white/45">Permission Set Basics</p>
                <Field label="Label" required>
                  <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Partner Onboarding Access" />
                </Field>
                <Field label="API Name" required>
                  <Input value={apiName} onChange={e => setApiName(e.target.value)} />
                </Field>
                <Field label="Description">
                  <textarea value={description} onChange={e => setDescription(e.target.value)} rows={3}
                    placeholder="What access does this permission set grant?"
                    className="w-full bg-[#111113] border border-white/12 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-[#6366f1] transition resize-none" />
                </Field>
                <Field label="License" hint="Leave blank unless this permission set must be tied to a specific Salesforce license.">
                  <Input value={license} onChange={e => setLicense(e.target.value)} placeholder="Optional" />
                </Field>
              </div>

              <div className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-white/45">Object Access</p>
                  <p className="text-xs text-white/30 mt-1">Pick one object for this first permission block. More can be added by creating another targeted set.</p>
                </div>
                <Field label="Object">
                  <Select value={selectedObject} onChange={e => setSelectedObject(e.target.value)}>
                    <option value="">No object access yet</option>
                    {objects.map(o => <option key={o.apiName} value={o.apiName}>{o.label} ({o.apiName})</option>)}
                  </Select>
                </Field>
                {selectedObject && (
                  <PermissionToggles value={objectPermission} onChange={setObjectPermission} />
                )}
              </div>

              <div className="flex items-center gap-2 text-xs text-amber-300/75 bg-amber-500/8 border border-amber-500/15 rounded-xl px-4 py-3">
                <Shield size={13} /> SF Copilot runs a Metadata API dry run before the real permission set deploy.
              </div>

              <LoadingButton onClick={createPermissionSet} disabled={!canCreate} loadingText="Dry run + deploy…" variant="primary" className="w-full justify-center">
                <><KeyRound size={15} /> Create Permission Set</>
              </LoadingButton>
            </section>

            <section className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-white/45">Field Access</p>
                  <p className="text-xs text-white/30 mt-1">Readable/editable field-level security for {selectedObject || 'the selected object'}.</p>
                </div>
                {loadingFields && <Loader2 size={14} className="animate-spin text-white/30" />}
              </div>
              {!selectedObject ? (
                <p className="text-sm text-white/25 py-10 text-center border border-dashed border-white/8 rounded-xl">Select an object to configure field permissions.</p>
              ) : fields.length === 0 ? (
                <p className="text-sm text-white/25 py-10 text-center">No fields loaded.</p>
              ) : (
                <div className="space-y-2 max-h-[620px] overflow-y-auto pr-1">
                  {fields.map(field => {
                    const key = `${selectedObject}.${field.apiName}`;
                    const access = fieldAccess[key] || { readable: false, editable: false };
                    return (
                      <div key={key} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border ${access.readable || access.editable ? 'border-[#6366f1]/25 bg-[#6366f1]/5' : 'border-white/6 bg-white/[0.02]'}`}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white/75 truncate">{field.label}</p>
                          <p className="text-xs text-white/25 truncate">{field.apiName} · {field.type}</p>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          <button type="button" onClick={() => setFieldAccess(prev => ({ ...prev, [key]: { ...access, readable: !access.readable, editable: access.editable && !access.readable ? false : access.editable } }))}
                            className={`px-2 py-1 rounded-lg border text-xs ${access.readable ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'border-white/10 text-white/35'}`}>
                            Read
                          </button>
                          <button type="button" disabled={!field.editable} onClick={() => setFieldAccess(prev => ({ ...prev, [key]: { readable: true, editable: !access.editable } }))}
                            className={`px-2 py-1 rounded-lg border text-xs disabled:opacity-25 ${access.editable ? 'bg-[#6366f1] border-[#6366f1] text-white' : 'border-white/10 text-white/35'}`}>
                            Edit
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        )}

        {orgId && tab === 'assign' && (
          <div className="grid xl:grid-cols-2 gap-6 max-w-5xl">
            <section className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/45">Users</p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" />
                  <Input value={userQuery} onChange={e => setUserQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchUsers()} placeholder="Search users by name or email…" style={{ paddingLeft: 34 }} />
                </div>
                <button onClick={searchUsers} disabled={!userQuery.trim() || searchingUsers} className="bg-white/5 hover:bg-white/10 border border-white/10 text-white/50 hover:text-white px-3 rounded-lg transition">
                  {searchingUsers ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
                </button>
              </div>
              <div className="border border-white/8 rounded-xl overflow-hidden max-h-80 overflow-y-auto">
                {users.length === 0 ? <p className="text-xs text-white/25 text-center py-10">Search active users above.</p> : users.map(u => (
                  <label key={u.id} className={`flex items-center gap-3 px-4 py-3 border-b border-white/5 last:border-0 cursor-pointer ${selectedUsers.has(u.id) ? 'bg-[#6366f1]/8' : 'hover:bg-white/3'}`}>
                    <input type="checkbox" checked={selectedUsers.has(u.id)} onChange={() => setSelectedUsers(prev => { const n = new Set(prev); n.has(u.id) ? n.delete(u.id) : n.add(u.id); return n; })} className="accent-[#6366f1]" />
                    <div className="min-w-0">
                      <p className="text-sm text-white/80 truncate">{u.name}</p>
                      <p className="text-xs text-white/35 truncate">{u.email} · {u.profile}</p>
                    </div>
                  </label>
                ))}
              </div>
            </section>

            <section className="bg-[#27272a]/15 border border-white/8 rounded-2xl p-5 space-y-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-white/45">Permission Sets</p>
              <div className="border border-white/8 rounded-xl overflow-hidden max-h-96 overflow-y-auto">
                {permissionSets.length === 0 ? <p className="text-xs text-white/25 text-center py-10">No permission sets loaded.</p> : permissionSets.map(ps => (
                  <label key={ps.id} className={`flex items-start gap-3 px-4 py-3 border-b border-white/5 last:border-0 cursor-pointer ${selectedPermissionSets.has(ps.id) ? 'bg-[#6366f1]/8' : 'hover:bg-white/3'}`}>
                    <input type="checkbox" checked={selectedPermissionSets.has(ps.id)} onChange={() => setSelectedPermissionSets(prev => { const n = new Set(prev); n.has(ps.id) ? n.delete(ps.id) : n.add(ps.id); return n; })} className="accent-[#6366f1] mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-sm text-white/80">{ps.label}</p>
                      <p className="text-xs text-white/30">{ps.name}</p>
                      {ps.description && <p className="text-xs text-white/25 mt-1 line-clamp-2">{ps.description}</p>}
                    </div>
                  </label>
                ))}
              </div>
              <LoadingButton onClick={assignPermissionSets} disabled={!canAssign} loadingText="Assigning…" variant="primary" className="w-full justify-center">
                <><Users size={15} /> Assign {selectedPermissionSets.size || ''} Permission Set(s)</>
              </LoadingButton>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
