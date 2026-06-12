import { Link } from 'react-router-dom';
import { Construction } from 'lucide-react';
import Sidebar from '../components/Sidebar';
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';

export default function ComingSoon({ title, description }) {
  const [user, setUser] = useState(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user || null));
  }, []);

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />
      <main className="flex-1 flex flex-col items-center justify-center px-8">
        <div className="text-center max-w-md">
          <div className="w-14 h-14 rounded-2xl bg-[#6366f1]/10 border border-[#6366f1]/20 flex items-center justify-center mx-auto mb-6">
            <Construction size={24} className="text-[#6366f1]" />
          </div>
          <h1 className="text-2xl font-bold mb-2">{title}</h1>
          <p className="text-white/40 text-sm leading-relaxed mb-8">{description}</p>
          <Link to="/dashboard" className="text-[#6366f1] hover:underline text-sm">
            ← Back to Workspace
          </Link>
        </div>
      </main>
    </div>
  );
}
