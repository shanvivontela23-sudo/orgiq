import { Link } from 'react-router-dom';
import { Zap, ShieldCheck, Server, Check, ArrowRight, Database, GitBranch, RefreshCw } from 'lucide-react';

const features = [
  {
    icon: <Zap size={28} className="text-[#6366f1]" />,
    title: 'Object-Agnostic Engine',
    desc: 'Migrate any standard or custom Salesforce object. No hardcoded schemas, no surprises.',
  },
  {
    icon: <ShieldCheck size={28} className="text-[#6366f1]" />,
    title: 'AI-Assisted Validation',
    desc: 'Claude reads your mapping file and flags conflicts, missing lookups, and PII exposure before a single record moves.',
  },
  {
    icon: <Server size={28} className="text-[#6366f1]" />,
    title: 'Battle-Tested at Scale',
    desc: 'Dependency-ordered loading, governor-limit-aware batching, and automatic retry — built for production.',
  },
];

const trustStats = [
  { icon: <Database size={20} className="text-[#6366f1]" />, value: '330K+', label: 'Records migrated per run' },
  { icon: <GitBranch size={20} className="text-[#6366f1]" />, value: '100+', label: 'Object types supported' },
  { icon: <RefreshCw size={20} className="text-[#6366f1]" />, value: '10s', label: 'Governor limit headroom built in' },
];

const pricing = [
  {
    name: 'Free Validator',
    price: '$0',
    desc: 'Understand your org before you commit.',
    highlight: false,
    features: [
      'Full schema analysis',
      'Dry run report (no writes)',
      'Dependency graph preview',
      'PII field detection',
      'No credit card required',
    ],
    cta: 'Start free',
  },
  {
    name: 'Dry Run Pro',
    price: '$49',
    per: '/run',
    desc: 'The full pre-flight check before a real migration.',
    highlight: false,
    features: [
      'Everything in Free',
      'AI-powered mapping validation',
      'Field type mismatch warnings',
      'Required field gap report',
      'Downloadable validation report',
    ],
    cta: 'Get started',
  },
  {
    name: 'Migration Starter',
    price: '$199',
    per: '/run',
    desc: 'Production-ready migration for smaller orgs and sandbox refreshes.',
    highlight: true,
    badge: 'Most Popular',
    features: [
      'Everything in Dry Run Pro',
      'Up to 50K records',
      'Dependency-ordered load',
      'Automatic retry on failures',
      'Post-migration count report',
    ],
    cta: 'Get started',
  },
  {
    name: 'Migration Growth',
    price: '$499',
    per: '/run',
    desc: 'For growing teams with larger object sets.',
    highlight: false,
    features: [
      'Everything in Migration Starter',
      'Up to 250K records',
      'Priority retry support',
      'Binary file / ContentVersion support',
      'Advanced validation report',
      'Email support',
    ],
    cta: 'Get started',
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-[#111113] text-white font-sans">
      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 border-b border-white/10">
        <span className="text-xl font-bold tracking-tight text-[#6366f1]">SF Copilot</span>
        <div className="flex gap-6 text-sm text-white/70 items-center">
          <a href="#features" className="hover:text-white transition">Features</a>
          <a href="#pricing" className="hover:text-white transition">Pricing</a>
          <Link to="/login" className="text-white hover:text-[#6366f1] transition">Sign in</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="flex flex-col items-center text-center px-6 pt-24 pb-20">
        <div className="inline-block text-xs font-semibold tracking-widest uppercase text-[#6366f1] bg-[#6366f1]/10 px-4 py-1.5 rounded-full mb-6">
          Salesforce Data Migration — Reimagined
        </div>
        <h1 className="text-5xl md:text-6xl font-extrabold leading-tight max-w-3xl mb-6">
          Any Object.{' '}
          <span className="text-[#6366f1]">Any Cloud.</span>{' '}
          Any Direction.
        </h1>
        <p className="text-lg text-white/60 max-w-xl mb-10">
          Migrate your Salesforce org without the consulting bill. Object-agnostic, AI-validated, production-proven.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 items-center">
          <Link
            to="/login"
            className="bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-8 py-4 rounded-xl text-base transition shadow-lg shadow-[#6366f1]/30 flex items-center gap-2"
          >
            Start Free Validation <ArrowRight size={16} />
          </Link>
          <a
            href="#pricing"
            className="text-white/60 hover:text-white text-sm transition px-4 py-4"
          >
            See pricing →
          </a>
        </div>
        {/* Trust line */}
        <p className="mt-8 text-xs text-white/30">
          Built by a Senior Salesforce Developer at Meta · 10+ years of real migration experience
        </p>
      </section>

      {/* Trust stats */}
      <section className="border-y border-white/10 bg-[#27272a]/20 py-10">
        <div className="max-w-3xl mx-auto px-6 flex flex-col sm:flex-row justify-around gap-8 text-center">
          {trustStats.map((s) => (
            <div key={s.label} className="flex flex-col items-center gap-2">
              {s.icon}
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-white/40 text-xs">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="px-6 py-20 max-w-5xl mx-auto">
        <h2 className="text-3xl font-bold text-center mb-12">Built for the Admin at 4pm on a Tuesday</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {features.map((f) => (
            <div key={f.title} className="bg-[#27272a]/40 border border-white/10 rounded-2xl p-6 hover:border-[#6366f1]/40 transition">
              <div className="mb-4">{f.icon}</div>
              <h3 className="font-semibold text-lg mb-2">{f.title}</h3>
              <p className="text-white/60 text-sm leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="px-6 py-20 bg-[#27272a]/20">
        <div className="max-w-5xl mx-auto">
          <h2 className="text-3xl font-bold text-center mb-4">Simple, Run-Based Pricing</h2>
          <p className="text-center text-white/50 mb-2 text-sm">Pay per migration run. No monthly seat fees, no consulting sticker shock.</p>
          <p className="text-center text-white/30 mb-12 text-xs">Need more than 250K records or a custom SLA? <a href="mailto:abhishekreddyvontela@gmail.com" className="text-[#6366f1] hover:underline">Talk to us →</a></p>
          <div className="grid md:grid-cols-4 gap-5 items-start">
            {pricing.map((p) => (
              <div
                key={p.name}
                className={`relative bg-[#111113] rounded-2xl p-6 flex flex-col transition ${
                  p.highlight
                    ? 'border-2 border-[#6366f1] shadow-lg shadow-[#6366f1]/20'
                    : 'border border-white/10 hover:border-[#6366f1]/50'
                }`}
              >
                {p.badge && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-[#6366f1] text-white text-xs font-semibold px-3 py-1 rounded-full whitespace-nowrap">
                    {p.badge}
                  </div>
                )}
                <div className="text-xs text-white/40 uppercase tracking-widest mb-3">{p.name}</div>
                <div className="text-3xl font-bold text-[#6366f1] mb-1">
                  {p.price}
                  {p.per && <span className="text-base font-normal text-white/40">{p.per}</span>}
                </div>
                <p className="text-white/40 text-xs mt-1 mb-4 leading-relaxed">{p.desc}</p>
                <ul className="flex-1 space-y-2 mb-6">
                  {p.features.map((feat) => (
                    <li key={feat} className="flex items-start gap-2 text-sm text-white/70">
                      <Check size={13} className="text-[#6366f1] mt-0.5 shrink-0" />
                      {feat}
                    </li>
                  ))}
                </ul>
                <Link
                  to="/login"
                  className={`text-center text-sm font-medium py-2.5 rounded-lg transition ${
                    p.highlight
                      ? 'bg-[#6366f1] hover:bg-[#4f46e5] text-white'
                      : 'bg-[#6366f1]/10 hover:bg-[#6366f1]/20 text-[#6366f1]'
                  }`}
                >
                  {p.cta}
                </Link>
              </div>
            ))}
          </div>

          {/* Enterprise row */}
          <div className="mt-6 border border-white/10 rounded-2xl px-8 py-6 flex flex-col sm:flex-row items-center justify-between gap-4 hover:border-[#6366f1]/30 transition">
            <div>
              <div className="text-xs text-white/40 uppercase tracking-widest mb-1">Enterprise</div>
              <div className="font-semibold text-white">Custom volume · SLA · Dedicated CSM</div>
              <p className="text-white/40 text-sm mt-1">Multi-org programs, 1M+ records, compliance requirements, or white-glove migration management.</p>
            </div>
            <a
              href="mailto:abhishekreddyvontela@gmail.com"
              className="shrink-0 bg-white/5 hover:bg-white/10 text-white text-sm font-medium px-6 py-3 rounded-xl transition border border-white/10"
            >
              Contact us →
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="text-center py-10 text-white/30 text-xs border-t border-white/10">
        © {new Date().getFullYear()} SF Copilot. Built for Salesforce professionals.
      </footer>
    </div>
  );
}
