import { NavLink, Link, useNavigate } from 'react-router-dom';
import logo from '../assets/logo.svg';
import { LayoutDashboard, Plus, Link2, FileText, Settings, LogOut, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';

const nav = [
  { to: '/dashboard', icon: <LayoutDashboard size={18} />, label: 'Dashboard' },
  { to: '/migrations/new', icon: <Plus size={18} />, label: 'New Migration' },
  { to: '/orgs', icon: <Link2 size={18} />, label: 'Connected Orgs' },
  { to: '/generator', icon: <Sparkles size={18} />, label: 'Generator' },
  { to: '/reports', icon: <FileText size={18} />, label: 'Reports' },
  { to: '/settings', icon: <Settings size={18} />, label: 'Settings' },
];

export default function Sidebar({ user }) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  return (
    <aside className="w-56 min-h-screen bg-[#0c0c0e] border-r border-white/8 flex flex-col">
      <div className="px-5 py-5 border-b border-white/8">
        <Link to="/dashboard" className="flex items-center gap-3 hover:opacity-80 transition">
          <img src={logo} alt="SF Copilot" className="h-8 w-auto" />
          <span className="text-sm font-semibold text-white/80 tracking-wide">SF Copilot</span>
        </Link>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        {nav.map(({ to, icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition ${
                isActive
                  ? 'bg-[#6366f1]/15 text-[#6366f1] font-medium'
                  : 'text-white/50 hover:text-white hover:bg-white/5'
              }`
            }
          >
            {icon}
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-white/8">
        <div className="px-3 py-2 text-xs text-white/30 truncate mb-2">{user?.email}</div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-white/50 hover:text-white hover:bg-white/5 transition w-full"
        >
          <LogOut size={18} />
          Logout
        </button>
      </div>
    </aside>
  );
}
