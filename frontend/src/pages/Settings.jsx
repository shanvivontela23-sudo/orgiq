import { useEffect, useState } from 'react';
import { ShieldCheck, UserRound } from 'lucide-react';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';

export default function Settings() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user || null));
  }, []);

  return (
    <div className="flex min-h-screen bg-[#0f1e30] text-white">
      <Sidebar user={user} />
      <main className="flex-1 px-8 py-8 max-w-4xl">
        <div className="mb-8">
          <h1 className="text-2xl font-bold">Settings</h1>
          <p className="text-white/40 text-sm mt-1">Account and workspace configuration</p>
        </div>

        <div className="space-y-4">
          <section className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-[#2E86AB]/20 flex items-center justify-center">
                <UserRound size={18} className="text-[#2E86AB]" />
              </div>
              <div>
                <h2 className="font-semibold">Account</h2>
                <p className="text-xs text-white/40">Signed-in user details</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-white/40 mb-1">Email</p>
                <p className="text-white/80">{user?.email || '-'}</p>
              </div>
              <div>
                <p className="text-xs text-white/40 mb-1">User ID</p>
                <p className="text-white/60 font-mono text-xs break-all">{user?.id || '-'}</p>
              </div>
            </div>
          </section>

          <section className="bg-[#1E3A5F]/20 border border-white/8 rounded-2xl p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center">
                <ShieldCheck size={18} className="text-green-400" />
              </div>
              <div>
                <h2 className="font-semibold">Migration Defaults</h2>
                <p className="text-xs text-white/40">Default safety settings for new runs</p>
              </div>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 text-sm">
              <div className="border border-white/8 rounded-xl p-4">
                <p className="text-white/80">Dry run first</p>
                <p className="text-xs text-white/35 mt-1">Recommended before live writes</p>
              </div>
              <div className="border border-white/8 rounded-xl p-4">
                <p className="text-white/80">Token refresh</p>
                <p className="text-xs text-white/35 mt-1">Enabled for source and target orgs</p>
              </div>
              <div className="border border-white/8 rounded-xl p-4">
                <p className="text-white/80">Reports</p>
                <p className="text-xs text-white/35 mt-1">Generated from backend run data</p>
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
