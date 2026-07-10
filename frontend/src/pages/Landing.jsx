import { Link } from 'react-router-dom';
import { Zap, ShieldCheck, Server, Check, ArrowRight, Database, GitBranch, RefreshCw } from 'lucide-react';

const features = [
  {
    icon: <Zap size={28} className="text-[#6366f1]" />,
    title: 'Prompt-Led Admin Work',
    desc: 'Describe the outcome once. SF Copilot routes the work to objects, users, permissions, data, reports, or metadata.',
  },
  {
    icon: <ShieldCheck size={28} className="text-[#6366f1]" />,
    title: 'Validation Before Change',
    desc: 'Dry-run metadata, inspect org shape, catch permission gaps, and surface risky choices before anything reaches production.',
  },
  {
    icon: <Server size={28} className="text-[#6366f1]" />,
    title: 'Built for Real Orgs',
    desc: 'Create users, objects, fields, permission sets, flows, reports, and data loads with audit history and repair-aware execution.',
  },
];

const trustStats = [
  { icon: <Database size={20} className="text-[#6366f1]" />, value: '6', label: 'Core admin workflows' },
  { icon: <GitBranch size={20} className="text-[#6366f1]" />, value: '1', label: 'Command layer for every request' },
  { icon: <RefreshCw size={20} className="text-[#6366f1]" />, value: '0', label: 'Deploys without review' },
];

const pricing = [
  {
    name: 'Free Review',
    price: '$0',
    desc: 'Turn a Salesforce request into a draft plan.',
    highlight: false,
    features: [
      'Copilot command planner',
      'Workspace routing',
      'Risk and missing-info summary',
      'No deploys without review',
      'No credit card required',
    ],
    cta: 'Start free',
  },
  {
    name: 'Admin Pro',
    price: '$49',
    per: '/workspace',
    desc: 'For admins building and validating real changes.',
    highlight: false,
    features: [
      'Objects, users, and permissions',
      'Metadata generation and dry runs',
      'Mapping sheet gap analysis',
      'Audit history',
      'Guided review before deploy',
    ],
    cta: 'Get started',
  },
  {
    name: 'Team Launch',
    price: '$199',
    per: '/month',
    desc: 'For teams shipping admin work together.',
    highlight: true,
    badge: 'Most Popular',
    features: [
      'Everything in Admin Pro',
      'Sandbox-to-production workflow',
      'Background deploy jobs',
      'Repair-aware execution',
      'Team activity feed',
    ],
    cta: 'Get started',
  },
  {
    name: 'Org Program',
    price: '$499',
    per: '/month',
    desc: 'For complex orgs with repeated operational change.',
    highlight: false,
    features: [
      'Everything in Team Launch',
      'Bulk data operations',
      'Advanced validation reports',
      'Priority troubleshooting',
      'Multi-org workflows',
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
          AI workspace for Salesforce teams
        </div>
        <h1 className="text-5xl md:text-6xl font-extrabold leading-tight max-w-3xl mb-6">
          Salesforce Admin{' '}
          <span className="text-[#6366f1]">Command Center</span>
        </h1>
        <p className="text-lg text-white/60 max-w-xl mb-10">
          Turn plain-English requests into guided workflows for metadata, objects, users, permissions, data loads, and audit-ready change history.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 items-center">
          <Link
            to="/login"
            className="bg-[#6366f1] hover:bg-[#4f46e5] text-white font-semibold px-8 py-4 rounded-xl text-base transition shadow-lg shadow-[#6366f1]/30 flex items-center gap-2"
          >
            Open Workspace <ArrowRight size={16} />
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
          Built for admins, PMs, business owners, and developers working in the same Salesforce org
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
          <h2 className="text-3xl font-bold text-center mb-4">Simple Pricing for Salesforce Work</h2>
          <p className="text-center text-white/50 mb-2 text-sm">Start with planning, then scale into guided execution, deployment, and audit.</p>
          <p className="text-center text-white/30 mb-12 text-xs">Need a custom rollout, compliance workflow, or dedicated support? <a href="mailto:abhishekreddyvontela@gmail.com" className="text-[#6366f1] hover:underline">Talk to us →</a></p>
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
              <p className="text-white/40 text-sm mt-1">Multi-org programs, governed admin operations, compliance requirements, or white-glove rollout management.</p>
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
