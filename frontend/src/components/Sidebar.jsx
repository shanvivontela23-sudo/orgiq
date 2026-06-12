import { NavLink, Link, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Link2, Settings, LogOut, Sparkles, Clock,
  FileSpreadsheet, UserPlus, Box, KeyRound, FileStack, ChevronRight,
} from 'lucide-react';
import { supabase } from '../lib/supabase';

const NAV_SECTIONS = [
  {
    label: 'Main',
    items: [
      { to: '/dashboard',  icon: <LayoutDashboard size={16} />, label: 'Workspace' },
      { to: '/orgs',       icon: <Link2 size={16} />,           label: 'Connected Orgs' },
    ],
  },
  {
    label: 'Build',
    items: [
      { to: '/generator',  icon: <Sparkles size={16} />,        label: 'Generator' },
      { to: '/migrations/new', icon: <FileSpreadsheet size={16} />, label: 'CSV Data Load' },
      { to: '/mapping-sheet',  icon: <FileStack size={16} />,   label: 'Mapping Sheet',  badge: 'New' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/users',       icon: <UserPlus size={16} />,  label: 'Users',       badge: 'New' },
      { to: '/objects',     icon: <Box size={16} />,        label: 'Objects',     badge: 'New' },
      { to: '/permissions', icon: <KeyRound size={16} />,   label: 'Permissions', badge: 'New' },
    ],
  },
  {
    label: 'Monitor',
    items: [
      { to: '/history',  icon: <Clock size={16} />,    label: 'Audit History' },
      { to: '/settings', icon: <Settings size={16} />, label: 'Settings' },
    ],
  },
];

export default function Sidebar({ user }) {
  const navigate = useNavigate();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate('/login');
  };

  return (
    <aside className="w-52 min-h-screen bg-[#0c0c0e] border-r border-white/8 flex flex-col shrink-0">

      {/* Logo */}
      <div className="px-4 py-4 border-b border-white/8">
        <Link to="/dashboard" className="flex items-center gap-2.5 hover:opacity-80 transition">
          <div className="w-7 h-7 rounded-lg bg-[#6366f1]/20 border border-[#6366f1]/30 flex items-center justify-center">
            <Sparkles size={13} className="text-[#6366f1]" />
          </div>
          <span className="text-sm font-semibold text-white/85 tracking-wide">SF Copilot</span>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 space-y-4 overflow-y-auto">
        {NAV_SECTIONS.map(({ label, items }) => (
          <div key={label}>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/20 px-3 mb-1">
              {label}
            </p>
            <div className="space-y-0.5">
              {items.map(({ to, icon, label: itemLabel, badge }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    `flex items-center justify-between gap-2.5 px-3 py-2 rounded-lg text-sm transition group ${
                      isActive
                        ? 'bg-[#6366f1]/15 text-[#6366f1] font-medium'
                        : 'text-white/45 hover:text-white hover:bg-white/5'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span className="flex items-center gap-2.5">
                        <span className={isActive ? 'text-[#6366f1]' : 'text-white/30 group-hover:text-white/60'}>
                          {icon}
                        </span>
                        {itemLabel}
                      </span>
                      {badge && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-[#6366f1]/20 text-[#6366f1]">
                          {badge}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* User + logout */}
      <div className="px-2 py-3 border-t border-white/8">
        <div className="px-3 py-2 mb-1">
          <p className="text-[10px] text-white/25 truncate">{user?.email}</p>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-white/40 hover:text-white hover:bg-white/5 transition w-full"
        >
          <LogOut size={16} />
          Logout
        </button>
      </div>
    </aside>
  );
}
