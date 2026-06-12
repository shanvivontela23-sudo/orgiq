import { useState, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * LoadingButton
 *
 * Prevents double-clicks. Grays out on first click with a spinner + loading label.
 * Re-enables on success OR failure so the user can always retry.
 * Shows "Taking longer than usual…" after a configurable timeout.
 *
 * Props:
 *   onClick        async function — must return or throw
 *   children       button content (idle state)
 *   loadingText    text shown while loading            default: "Please wait…"
 *   slowText       text shown after slowThreshold ms   default: "Still working…"
 *   slowThreshold  ms before "slow" label appears      default: 20000
 *   disabled       external disabled flag
 *   className      classes for the button
 *   variant        'primary' | 'danger' | 'ghost'      default: 'primary'
 */
export default function LoadingButton({
  onClick,
  children,
  loadingText   = 'Please wait…',
  slowText      = 'Still working…',
  slowThreshold = 20_000,
  disabled      = false,
  className     = '',
  variant       = 'primary',
  type          = 'button',
  ...rest
}) {
  const [loading, setLoading]   = useState(false);
  const [slow, setSlow]         = useState(false);
  const slowTimer               = useRef(null);
  const mounted                 = useRef(true);

  useEffect(() => () => { mounted.current = false; clearTimeout(slowTimer.current); }, []);

  const BASE = {
    primary: 'bg-[#6366f1] hover:bg-[#4f46e5] text-white shadow-lg shadow-[#6366f1]/20',
    danger:  'bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/20',
    ghost:   'bg-white/5 hover:bg-white/10 text-white/60 hover:text-white border border-white/10',
  };

  const LOADING_CLS = 'opacity-60 cursor-not-allowed pointer-events-none';

  async function handle(e) {
    e.preventDefault();
    if (loading || disabled) return;

    setLoading(true);
    setSlow(false);

    slowTimer.current = setTimeout(() => {
      if (mounted.current) setSlow(true);
    }, slowThreshold);

    try {
      await onClick(e);
    } catch {
      // Error is the caller's responsibility — we just re-enable the button
    } finally {
      clearTimeout(slowTimer.current);
      if (mounted.current) {
        setLoading(false);
        setSlow(false);
      }
    }
  }

  const isDisabled = loading || disabled;
  const label = loading ? (slow ? slowText : loadingText) : null;

  return (
    <button
      type={type}
      onClick={handle}
      disabled={isDisabled}
      className={`
        inline-flex items-center gap-2 font-semibold px-5 py-2.5 rounded-xl text-sm transition
        ${BASE[variant] || BASE.primary}
        ${isDisabled ? LOADING_CLS : ''}
        ${className}
      `}
      {...rest}
    >
      {loading && <Loader2 size={14} className="animate-spin shrink-0" />}
      <span>{label || children}</span>
    </button>
  );
}

/**
 * useLoadingState — lightweight hook for cases where you need
 * loading state on a custom element (not a button).
 *
 * const { loading, slow, run } = useLoadingState(asyncFn, 20000);
 */
export function useLoadingState(fn, slowThreshold = 20_000) {
  const [loading, setLoading] = useState(false);
  const [slow, setSlow]       = useState(false);
  const [error, setError]     = useState(null);
  const slowTimer             = useRef(null);
  const mounted               = useRef(true);

  useEffect(() => () => { mounted.current = false; clearTimeout(slowTimer.current); }, []);

  async function run(...args) {
    if (loading) return;
    setLoading(true);
    setSlow(false);
    setError(null);

    slowTimer.current = setTimeout(() => {
      if (mounted.current) setSlow(true);
    }, slowThreshold);

    try {
      return await fn(...args);
    } catch (err) {
      if (mounted.current) setError(err);
      throw err;
    } finally {
      clearTimeout(slowTimer.current);
      if (mounted.current) { setLoading(false); setSlow(false); }
    }
  }

  return { loading, slow, error, run };
}
