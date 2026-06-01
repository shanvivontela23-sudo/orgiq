import { useCallback, useEffect, useState } from 'react';
import { Link2, Plus, Trash2, Loader2, CheckCircle, RefreshCw } from 'lucide-react';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export default function ConnectedOrgs() {
  const [user, setUser]       = useState(null);
  const [orgs, setOrgs]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(null);

  const loadOrgs = useCallback(async (userId) => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}/api/orgs`, { params: { userId } });
      setOrgs(data.orgs || []);
    } catch (err) {
      console.error('Failed to load orgs:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user);
      if (data.user) loadOrgs(data.user.id);
    });
  }, [loadOrgs]);

  async function handleDisconnect(orgId) {
    if (!confirm('Disconnect this org? Any pending migrations using it will be affected.')) return;
    setRemoving(orgId);
    try {
      await axios.delete(`${API}/api/orgs/${orgId}`);
      setOrgs(prev => prev.filter(o => o.id !== orgId));
    } catch (err) {
      console.error('Failed to disconnect org:', err);
    } finally {
      setRemoving(null);
    }
  }

  function handleConnectOrg(orgType) {
    if (!user) return;
    window.location.href = `${API}/auth/salesforce?userId=${user.id}&orgType=${orgType}`;
  }

  return (
    <div className="flex min-h-screen bg-[#0f1e30] text-white">
      <Sidebar user={user} />

      <main className="flex-1 px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold">Connected Orgs</h1>
            <p className="text-white/40 text-sm mt-1">Salesforce orgs connected via OAuth</p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => handleConnectOrg('source')}
              className="flex items-center gap-2 bg-[#1E3A5F]/50 hover:bg-[#1E3A5F] border border-white/10 text-white/80 font-medium px-4 py-2.5 rounded-xl text-sm transition"
            >
              <Plus size={15} /> Source Org
            </button>
            <button
              onClick={() => handleConnectOrg('target')}
              className="flex items-center gap-2 bg-[#2E86AB] hover:bg-[#247496] text-white font-semibold px-4 py-2.5 rounded-xl text-sm transition shadow-lg shadow-[#2E86AB]/20"
            >
              <Plus size={15} /> Target Org
            </button>
          </div>
        </div>

        {/* Orgs list */}
        {loading ? (
          <div className="flex items-center justify-center py-20 text-white/30">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading orgs…
          </div>
        ) : orgs.length === 0 ? (
          <div className="text-center py-20 text-white/30 border border-dashed border-white/10 rounded-2xl">
            <Link2 size={32} className="mx-auto mb-4 opacity-30" />
            <p className="mb-4 text-base">No orgs connected yet.</p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={() => handleConnectOrg('source')}
                className="bg-[#2E86AB] hover:bg-[#247496] text-white font-semibold px-6 py-2.5 rounded-xl text-sm transition"
              >
                Connect Source Org
              </button>
              <button
                onClick={() => handleConnectOrg('target')}
                className="bg-white/5 hover:bg-white/10 text-white/70 font-medium px-6 py-2.5 rounded-xl text-sm transition border border-white/10"
              >
                Connect Target Org
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {orgs.map((org) => (
              <div
                key={org.id}
                className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl px-6 py-5 flex items-center justify-between hover:border-white/15 transition"
              >
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-[#2E86AB]/20 flex items-center justify-center">
                    <Link2 size={18} className="text-[#2E86AB]" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{org.org_name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        org.org_type === 'source'
                          ? 'bg-blue-500/15 text-blue-400'
                          : 'bg-purple-500/15 text-purple-400'
                      }`}>
                        {org.org_type}
                      </span>
                    </div>
                    <p className="text-xs text-white/40 mt-0.5">{org.instance_url}</p>
                  </div>
                </div>

                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5 text-green-400 text-xs">
                    <CheckCircle size={13} />
                    Connected {new Date(org.connected_at).toLocaleDateString()}
                  </div>
                  <button
                    onClick={() => handleDisconnect(org.id)}
                    disabled={removing === org.id}
                    className="text-white/25 hover:text-red-400 transition disabled:opacity-50 p-1.5 rounded-lg hover:bg-red-500/10"
                    title="Disconnect org"
                  >
                    {removing === org.id
                      ? <Loader2 size={15} className="animate-spin" />
                      : <Trash2 size={15} />
                    }
                  </button>
                </div>
              </div>
            ))}

            {/* Refresh */}
            <button
              onClick={() => user && loadOrgs(user.id)}
              className="flex items-center gap-2 text-white/30 hover:text-white text-xs transition mt-2"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        )}

        {/* Info box */}
        <div className="mt-8 bg-[#1E3A5F]/10 border border-white/6 rounded-xl p-5 text-xs text-white/40">
          <p className="font-semibold text-white/60 mb-1">How org connections work</p>
          <p>OrgIQ connects via Salesforce OAuth 2.0. Your access token is stored encrypted and used only during migration. You can disconnect an org at any time — this revokes the token from Salesforce immediately.</p>
        </div>
      </main>
    </div>
  );
}
