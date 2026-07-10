import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import Sidebar from '../components/Sidebar';
import {
  ShoppingCart, Upload, BarChart2, CheckCircle2, ArrowRight,
  Download, RefreshCw, ChevronDown, Loader2, AlertCircle,
} from 'lucide-react';

// ─── Mock data ────────────────────────────────────────────────────────────────

const DAILY_ORDERS = [
  { account: 'Daikan North America', orders: 142, revenue: '$284,000', date: '2026-06-25' },
  { account: 'Daikan Europe GmbH',   orders: 89,  revenue: '$178,000', date: '2026-06-25' },
  { account: 'Daikan APAC Pte Ltd',  orders: 211, revenue: '$422,000', date: '2026-06-25' },
  { account: 'Daikan Retail JP',     orders: 57,  revenue: '$114,000', date: '2026-06-25' },
  { account: 'Daikan Direct US',     orders: 194, revenue: '$388,000', date: '2026-06-25' },
];

const WEEKLY_ORDERS = [
  { account: 'Daikan North America', orders: 987,  revenue: '$1,974,000', week: 'Jun 16–22' },
  { account: 'Daikan Europe GmbH',   orders: 624,  revenue: '$1,248,000', week: 'Jun 16–22' },
  { account: 'Daikan APAC Pte Ltd',  orders: 1402, revenue: '$2,804,000', week: 'Jun 16–22' },
  { account: 'Daikan Retail JP',     orders: 378,  revenue: '$756,000',   week: 'Jun 16–22' },
  { account: 'Daikan Direct US',     orders: 1133, revenue: '$2,266,000', week: 'Jun 16–22' },
];

// ─── Section header ───────────────────────────────────────────────────────────

function ScenarioHeader({ num, icon, title, subtitle, done }) {
  return (
    <div className="flex items-start gap-4 mb-6">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
        done
          ? 'bg-green-500/15 border-green-500/30 text-green-400'
          : 'bg-[#6366f1]/15 border-[#6366f1]/30 text-[#6366f1]'
      }`}>
        {done ? <CheckCircle2 size={18} /> : icon}
      </div>
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-widest text-white/25 mb-0.5">
          Scenario {num}
        </div>
        <h2 className="text-base font-semibold text-white">{title}</h2>
        <p className="text-sm text-white/40 mt-0.5">{subtitle}</p>
      </div>
    </div>
  );
}

// ─── Scenario 1: Cart Limit ───────────────────────────────────────────────────

function CartLimitScenario() {
  const [status, setStatus] = useState('idle'); // idle | running | done
  const [currentLimit, setCurrentLimit] = useState(25);

  const apply = async () => {
    setStatus('running');
    await new Promise(r => setTimeout(r, 1800));
    setCurrentLimit(100);
    setStatus('done');
  };

  const reset = () => { setCurrentLimit(25); setStatus('idle'); };

  return (
    <section className="bg-[#18181b] border border-white/8 rounded-2xl p-6 mb-6">
      <ScenarioHeader
        num={1}
        icon={<ShoppingCart size={18} />}
        title="Cart Limit Increase"
        subtitle="Raise the maximum active carts per account from 25 to 100"
        done={status === 'done'}
      />

      {/* Comparison */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-[#111113] border border-white/8 rounded-xl p-5 text-center">
          <div className="text-[10px] uppercase tracking-widest text-white/25 mb-3">Before</div>
          <div className="text-5xl font-bold text-red-400 mb-2">25</div>
          <div className="text-xs text-white/30">carts / account</div>
          <div className="mt-3 text-[11px] text-white/20 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
            WebStore.MaxCartsPerAccount = 25
          </div>
        </div>
        <div className={`border rounded-xl p-5 text-center transition-all duration-500 ${
          status === 'done'
            ? 'bg-green-500/5 border-green-500/30'
            : 'bg-[#111113] border-white/8'
        }`}>
          <div className="text-[10px] uppercase tracking-widest text-white/25 mb-3">After</div>
          <div className={`text-5xl font-bold mb-2 transition-colors duration-500 ${
            status === 'done' ? 'text-green-400' : 'text-white/20'
          }`}>{currentLimit === 100 ? 100 : 100}</div>
          <div className="text-xs text-white/30">carts / account</div>
          <div className={`mt-3 text-[11px] rounded-lg px-3 py-2 transition-all duration-500 ${
            status === 'done'
              ? 'text-green-300/70 bg-green-500/10 border border-green-500/20'
              : 'text-white/20 bg-white/5 border border-white/8'
          }`}>
            WebStore.MaxCartsPerAccount = 100
          </div>
        </div>
      </div>

      {/* SF change preview */}
      <div className="bg-[#111113] border border-white/8 rounded-xl p-4 mb-5 font-mono text-xs text-white/40 leading-relaxed">
        <div className="text-white/20 mb-2">// Custom Metadata: B2BCommerceSettings.MaxCartsPerAccount</div>
        <div><span className="text-[#6366f1]">WebStoreNetwork</span> config = [</div>
        <div className="pl-4">SELECT Id, MaxCartsPerAccount</div>
        <div className="pl-4">FROM WebStoreNetwork LIMIT 1</div>
        <div>];</div>
        <div className="mt-2">
          config.MaxCartsPerAccount = <span className={status === 'done' ? 'text-green-400' : 'text-white/60'}>
            {status === 'done' ? '100' : '25 → 100'}
          </span>;
        </div>
        <div>update config;</div>
      </div>

      <div className="flex items-center gap-3">
        {status === 'idle' && (
          <button
            onClick={apply}
            className="bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition flex items-center gap-2"
          >
            <ShoppingCart size={14} /> Apply Limit Change
          </button>
        )}
        {status === 'running' && (
          <button disabled className="bg-[#6366f1]/50 text-white text-sm font-semibold px-5 py-2.5 rounded-xl flex items-center gap-2 cursor-not-allowed">
            <Loader2 size={14} className="animate-spin" /> Deploying to Salesforce…
          </button>
        )}
        {status === 'done' && (
          <>
            <div className="flex items-center gap-2 text-green-400 text-sm font-medium">
              <CheckCircle2 size={16} /> Limit updated — 100 carts / account active
            </div>
            <button onClick={reset} className="text-white/30 hover:text-white/60 text-xs flex items-center gap-1 transition ml-auto">
              <RefreshCw size={11} /> Reset
            </button>
          </>
        )}
      </div>
    </section>
  );
}

// ─── Scenario 2: Upload Cart Enhancement ─────────────────────────────────────

function UploadCartScenario() {
  const [downloaded, setDownloaded] = useState(false);
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadStatus, setUploadStatus] = useState('idle'); // idle | processing | done | error
  const [parseResult, setParseResult] = useState(null);

  const downloadTemplate = () => {
    // Build CSV with the Comments column
    const csv = [
      'Part Number,Quantity,Comments',
      'DKN-A100,10,Rush order - priority handling required',
      'DKN-B220,25,Standard delivery',
      'DKN-C330,5,Fragile — special packaging needed',
    ].join('\n');

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'daikan_cart_upload_template.csv';
    a.click();
    URL.revokeObjectURL(url);
    setDownloaded(true);
  };

  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    setUploadFile(f);
    setUploadStatus('processing');

    setTimeout(() => {
      // Simulate parse: check if Comments column present
      const reader = new FileReader();
      reader.onload = (ev) => {
        const lines = ev.target.result.split('\n').filter(Boolean);
        const headers = lines[0].split(',').map(h => h.trim());
        const hasComments = headers.some(h => h.toLowerCase().includes('comment'));
        setParseResult({
          rows: lines.length - 1,
          headers,
          hasComments,
        });
        setUploadStatus(hasComments ? 'done' : 'error');
      };
      reader.readAsText(f);
    }, 1200);
  };

  return (
    <section className="bg-[#18181b] border border-white/8 rounded-2xl p-6 mb-6">
      <ScenarioHeader
        num={2}
        icon={<Upload size={18} />}
        title="Upload Cart Enhancement"
        subtitle="Add a Comments column to the cart upload template for order-level notes"
        done={uploadStatus === 'done'}
      />

      {/* Before / After columns */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-white/25 mb-2">Before — Original Template</div>
          <div className="bg-[#111113] border border-white/8 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/8">
                  <th className="text-left px-4 py-3 text-white/50 font-medium">Part Number</th>
                  <th className="text-left px-4 py-3 text-white/50 font-medium">Quantity</th>
                </tr>
              </thead>
              <tbody>
                {['DKN-A100', 'DKN-B220', 'DKN-C330'].map((p, i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="px-4 py-2.5 text-white/40">{p}</td>
                    <td className="px-4 py-2.5 text-white/40">{[10, 25, 5][i]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-widest text-white/25 mb-2">After — Enhanced Template</div>
          <div className="bg-[#111113] border border-green-500/20 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-white/8">
                  <th className="text-left px-4 py-3 text-white/50 font-medium">Part Number</th>
                  <th className="text-left px-4 py-3 text-white/50 font-medium">Quantity</th>
                  <th className="text-left px-4 py-3 text-green-400 font-medium">Comments ✦</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['DKN-A100', 10, 'Rush order'],
                  ['DKN-B220', 25, 'Standard'],
                  ['DKN-C330', 5,  'Fragile pkg'],
                ].map(([p, q, c], i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="px-4 py-2.5 text-white/40">{p}</td>
                    <td className="px-4 py-2.5 text-white/40">{q}</td>
                    <td className="px-4 py-2.5 text-green-300/60 italic">{c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-green-400/60 mt-1.5 px-1">✦ New column — maps to CartItem.CommentField__c</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={downloadTemplate}
          className={`flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-xl transition ${
            downloaded
              ? 'bg-green-500/15 text-green-400 border border-green-500/30'
              : 'bg-[#6366f1] hover:bg-[#4f46e5] text-white'
          }`}
        >
          <Download size={14} />
          {downloaded ? 'Template Downloaded' : 'Download Enhanced Template'}
        </button>

        <label className="flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-xl border border-white/10 text-white/50 hover:text-white hover:border-white/20 transition cursor-pointer">
          <Upload size={14} />
          {uploadFile ? uploadFile.name : 'Test Upload a File'}
          <input type="file" accept=".csv,.xlsx" onChange={handleFileChange} className="hidden" />
        </label>
      </div>

      {/* Upload result */}
      {uploadStatus === 'processing' && (
        <div className="mt-4 flex items-center gap-2 text-white/40 text-sm">
          <Loader2 size={14} className="animate-spin" /> Parsing file…
        </div>
      )}
      {uploadStatus === 'done' && parseResult && (
        <div className="mt-4 bg-green-500/8 border border-green-500/20 rounded-xl p-4 text-sm">
          <div className="flex items-center gap-2 text-green-400 font-medium mb-1">
            <CheckCircle2 size={15} /> Upload validated — {parseResult.rows} rows detected
          </div>
          <div className="text-white/40 text-xs">
            Columns found: {parseResult.headers.join(', ')}
          </div>
        </div>
      )}
      {uploadStatus === 'error' && parseResult && (
        <div className="mt-4 bg-red-500/8 border border-red-500/20 rounded-xl p-4 text-sm">
          <div className="flex items-center gap-2 text-red-400 font-medium mb-1">
            <AlertCircle size={15} /> Missing "Comments" column
          </div>
          <div className="text-white/40 text-xs">
            Columns found: {parseResult.headers.join(', ')} — download the enhanced template above.
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Scenario 3: Order Reports ────────────────────────────────────────────────

function OrderReportsScenario() {
  const [view, setView] = useState('daily'); // daily | weekly
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(null);

  const data = view === 'daily' ? DAILY_ORDERS : WEEKLY_ORDERS;

  const exportReport = async () => {
    setExporting(true);
    await new Promise(r => setTimeout(r, 1200));

    const header = view === 'daily'
      ? 'Account,Orders,Revenue,Date'
      : 'Account,Orders,Revenue,Week';

    const rows = data.map(r =>
      view === 'daily'
        ? `${r.account},${r.orders},${r.revenue},${r.date}`
        : `${r.account},${r.orders},${r.revenue},${r.week}`
    );

    const csv = [header, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daikan_${view}_order_report.csv`;
    a.click();
    URL.revokeObjectURL(url);

    setExporting(false);
    setExported(view);
  };

  const totalOrders = data.reduce((s, r) => s + r.orders, 0);

  return (
    <section className="bg-[#18181b] border border-white/8 rounded-2xl p-6">
      <ScenarioHeader
        num={3}
        icon={<BarChart2 size={18} />}
        title="Daily & Weekly Order Reports"
        subtitle="Account-level order count exports for Daikan's operations team"
        done={!!exported}
      />

      {/* Toggle + stat */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-1 bg-[#111113] border border-white/8 rounded-xl p-1">
          {['daily', 'weekly'].map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition capitalize ${
                view === v
                  ? 'bg-[#6366f1] text-white'
                  : 'text-white/40 hover:text-white'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-white">{totalOrders.toLocaleString()}</div>
          <div className="text-[11px] text-white/30">total orders · {view === 'daily' ? 'today' : 'this week'}</div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-[#111113] border border-white/8 rounded-xl overflow-hidden mb-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/8 text-white/30 text-xs uppercase tracking-wider">
              <th className="text-left px-5 py-3 font-medium">Account</th>
              <th className="text-left px-4 py-3 font-medium">Orders</th>
              <th className="text-left px-4 py-3 font-medium">Revenue</th>
              <th className="text-left px-4 py-3 font-medium">{view === 'daily' ? 'Date' : 'Week'}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((row, i) => (
              <tr key={i} className="border-b border-white/5 hover:bg-white/2 transition">
                <td className="px-5 py-3 text-white/80">{row.account}</td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 rounded-full bg-[#6366f1]/30 flex-1 max-w-20">
                      <div
                        className="h-1.5 rounded-full bg-[#6366f1]"
                        style={{ width: `${(row.orders / Math.max(...data.map(r => r.orders))) * 100}%` }}
                      />
                    </div>
                    <span className="text-white/60 text-xs w-8">{row.orders}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-white/50 text-xs">{row.revenue}</td>
                <td className="px-4 py-3 text-white/30 text-xs">{view === 'daily' ? row.date : row.week}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Export */}
      <div className="flex items-center gap-3">
        <button
          onClick={exportReport}
          disabled={exporting}
          className="flex items-center gap-2 bg-[#6366f1] hover:bg-[#4f46e5] disabled:opacity-60 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition"
        >
          {exporting
            ? <><Loader2 size={14} className="animate-spin" /> Generating…</>
            : <><Download size={14} /> Export {view === 'daily' ? 'Daily' : 'Weekly'} Report</>
          }
        </button>
        {exported && (
          <span className="text-green-400 text-sm flex items-center gap-1.5">
            <CheckCircle2 size={14} /> {exported} report downloaded
          </span>
        )}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DaikanDemo() {
  const [user, setUser] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user || null);
    });
  }, []);

  return (
    <div className="flex min-h-screen bg-[#111113] text-white">
      <Sidebar user={user} />

      <main className="flex-1 px-8 py-8 max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-2 text-[11px] text-white/30 mb-3 uppercase tracking-widest">
            <span>Client Demo</span>
            <ArrowRight size={10} />
            <span className="text-[#6366f1]">Daikan</span>
          </div>
          <h1 className="text-2xl font-bold mb-1">Salesforce B2B Commerce</h1>
          <p className="text-white/40 text-sm">
            3 customizations scoped for Daikan's eCommerce operations · B2B Commerce on LWR
          </p>

          {/* Status bar */}
          <div className="mt-5 flex items-center gap-6 bg-[#18181b] border border-white/8 rounded-xl px-5 py-3">
            <div>
              <div className="text-[10px] text-white/25 uppercase tracking-wider mb-0.5">Client</div>
              <div className="text-sm font-medium text-white">Daikan Corporation</div>
            </div>
            <div className="w-px h-8 bg-white/8" />
            <div>
              <div className="text-[10px] text-white/25 uppercase tracking-wider mb-0.5">Platform</div>
              <div className="text-sm font-medium text-white">B2B Commerce LWR</div>
            </div>
            <div className="w-px h-8 bg-white/8" />
            <div>
              <div className="text-[10px] text-white/25 uppercase tracking-wider mb-0.5">Scenarios</div>
              <div className="text-sm font-medium text-white">3 ready to demo</div>
            </div>
            <div className="w-px h-8 bg-white/8" />
            <div>
              <div className="text-[10px] text-white/25 uppercase tracking-wider mb-0.5">Est. Effort</div>
              <div className="text-sm font-medium text-white">~3–5 days</div>
            </div>
          </div>
        </div>

        {/* Scenarios */}
        <CartLimitScenario />
        <UploadCartScenario />
        <OrderReportsScenario />
      </main>
    </div>
  );
}
