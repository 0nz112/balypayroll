import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n, errorText } from '../lib/i18n.js';
import { usePrefs } from '../lib/prefs.js';
import { formatIQD, formatNumber } from '../engine/money.js';

// ------------------------------------------------------------------ icons
const P = {
  dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
  register: 'M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11',
  users: 'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75',
  wallet: 'M21 12V7H5a2 2 0 010-4h14v4M3 5v14a2 2 0 002 2h16v-5M18 12a2 2 0 000 4h4v-4h-4z',
  ledger: 'M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15zM8 7h8M8 11h6',
  receipt: 'M4 2v20l3-2 3 2 3-2 3 2 3-2 1 .67V2l-1 .67L16 2l-3 2-3-2-3 2-3-2zM8 8h8M8 12h8M8 16h5',
  gift: 'M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z',
  chart: 'M18 20V10M12 20V4M6 20v-6',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  history: 'M3 3v5h5M3.05 13A9 9 0 106 5.3L3 8M12 7v5l4 2',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
  palette: 'M12 2a10 10 0 100 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A5.7 5.7 0 0022 9.8C22 5.5 17.5 2 12 2zM6.5 12a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3-4a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm5 0a1.5 1.5 0 110-3 1.5 1.5 0 010 3zm3 4a1.5 1.5 0 110-3 1.5 1.5 0 010 3z',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14', x: 'M18 6L6 18M6 6l12 12', check: 'M20 6L9 17l-5-5',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35', filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3z',
  chevL: 'M15 18l-6-6 6-6', chevR: 'M9 18l6-6-6-6', chevD: 'M6 9l6 6 6-6',
  menu: 'M3 12h18M3 6h18M3 18h18', more: 'M12 13a1 1 0 100-2 1 1 0 000 2zM19 13a1 1 0 100-2 1 1 0 000 2zM5 13a1 1 0 100-2 1 1 0 000 2z',
  logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9',
  download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3', share: 'M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13',
  whatsapp: 'M20.5 3.5A11.8 11.8 0 0012 0C5.4 0 0 5.4 0 12c0 2.1.6 4.2 1.6 6L0 24l6.2-1.6A12 12 0 0012 24c6.6 0 12-5.4 12-12 0-3.2-1.3-6.2-3.5-8.5zM12 22a10 10 0 01-5.1-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A10 10 0 1112 22zm5.5-7.5c-.3-.2-1.8-.9-2-1s-.5-.2-.7.1-.8 1-.9 1.2-.3.2-.6.1a8.2 8.2 0 01-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6a1.2 1.2 0 00-.8.4 3.5 3.5 0 00-1.1 2.6 6 6 0 001.3 3.2 13.8 13.8 0 005.3 4.7c2 .8 2.7.9 3.7.8.6-.1 1.8-.8 2.1-1.5s.3-1.3.2-1.5-.3-.2-.6-.4z',
  lock: 'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4',
  alert: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01',
  info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01', calendar: 'M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2zM16 2v4M8 2v4M3 10h18',
  trend: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6', money: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6', coins: 'M8 14a6 6 0 100-12 6 6 0 000 12zM18.09 10.37A6 6 0 1110.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82',
  debt: 'M2 12h20M12 2v20M5 5l14 14', clock: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 6v6l4 2', file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6',
  edit: 'M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z', eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 100-6 3 3 0 000 6z',
  sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42', moon: 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
  globe: 'M12 22a10 10 0 100-20 10 10 0 000 20zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15', sidebar: 'M3 3h18v18H3zM9 3v18',
  fuel: 'M3 22V4a2 2 0 012-2h8a2 2 0 012 2v18M3 22h12M15 10h2a2 2 0 012 2v5a2 2 0 004 0V9l-3-3M7 7h4', paperclip: 'M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48',
  swap: 'M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16', star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  print: 'M6 9V2h12v7M6 18H4a2 2 0 01-2-2v-5a2 2 0 012-2h16a2 2 0 012 2v5a2 2 0 01-2 2h-2M6 14h12v8H6z', copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
  sparkles: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2zM19 3v4M21 5h-4',
};
export function Icon({ name, size = 18, stroke = 2, ...rest }) {
  const filled = name === 'whatsapp';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      <path d={P[name] || P.info} />
    </svg>
  );
}

// ------------------------------------------------------------------ formatting
export function useFmt() {
  const { lang } = useI18n();
  const { prefs } = usePrefs();
  return useMemo(() => {
    const digits = lang === 'ar' ? prefs.digits : 'latn';
    const locale = lang === 'ar' ? `ar-IQ-u-nu-${digits}` : 'en-GB';
    const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const dayFmt = new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' });
    const shortFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const dtFmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Baghdad' });
    const monthFmt = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const d = (iso) => new Date(iso + 'T00:00:00Z');
    return {
      money: (n) => formatIQD(n, lang, { digits }),
      moneyPlain: (n) => formatIQD(n, lang, { digits, withUnit: false }),
      num: (n) => formatNumber(n, lang, digits),
      date: (iso) => (iso ? dateFmt.format(d(iso.slice(0, 10))) : '—'),
      short: (iso) => (iso ? shortFmt.format(d(iso.slice(0, 10))) : '—'),
      weekday: (iso) => dayFmt.format(d(iso)),
      dt: (ts) => (ts ? dtFmt.format(new Date(ts)) : '—'),
      month: (iso) => monthFmt.format(d(iso)),
      digits,
    };
  }, [lang, prefs.digits]);
}

// ------------------------------------------------------------------ async data hook
export function useAsync(fn, deps) {
  const [state, set] = useState({ loading: true, data: null, error: null });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const id = ++seq.current;
    set((s) => ({ ...s, loading: true, error: null }));
    try { const data = await fn(); if (id === seq.current) set({ loading: false, data, error: null }); }
    catch (error) { if (id === seq.current) set({ loading: false, data: null, error }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

// ------------------------------------------------------------------ toast
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, type = 'success', ms = 3600) => {
    const id = Math.random();
    setItems((x) => [...x.slice(-3), { id, msg, type }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), ms);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon name={t.type === 'error' ? 'alert' : t.type === 'info' ? 'info' : 'check'} />
            <span className="grow">{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const push = useContext(ToastCtx);
  const { lang } = useI18n();
  return useMemo(() => ({
    ok: (m) => push(m, 'success'), info: (m) => push(m, 'info', 5200), error: (e) => push(typeof e === 'string' ? e : errorText(lang, e), 'error', 5200),
  }), [push, lang]);
}

// ------------------------------------------------------------------ primitives
export function Button({ variant = '', size = '', icon, loading, children, className = '', ...rest }) {
  return (
    <button type="button" className={`btn ${variant} ${size} ${!children ? 'icon' : ''} ${className}`} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
      {children}
    </button>
  );
}
export function Card({ title, sub, actions, children, className = '', glass, icon, ...rest }) {
  return (
    <section className={`card ${glass ? 'glass' : ''} ${className}`} {...rest}>
      {(title || actions) && (
        <div className="card-head">
          <div><h3 className="card-title">{icon && <Icon name={icon} size={17} />} {title}</h3>{sub && <div className="card-sub">{sub}</div>}</div>
          {actions && <div className="row wrap">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
export function Field({ label, hint, error, children, className = '' }) {
  return (
    <label className={`field ${className}`}>
      {label && <span className="label">{label}</span>}
      {children}
      {error ? <span className="error-text">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}
export const Input = React.forwardRef(function Input({ className = '', ...p }, ref) { return <input ref={ref} className={`input ${className}`} {...p} />; });
export function Select({ options, className = '', placeholder, ...p }) {
  return (
    <select className={`select ${className}`} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
export function Textarea(p) { return <textarea className="textarea" {...p} />; }
export function Switch({ checked, onChange, label }) {
  return (
    <label className="row" style={{ cursor: 'pointer' }}>
      <span className="switch"><input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} /><span /></span>
      {label && <span className="small">{label}</span>}
    </label>
  );
}
export function Seg({ value, onChange, options, accent }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`${value === o.value ? 'on' : ''} ${accent ? 'accent' : ''}`} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
/** Integer IQD input with live thousands formatting. value: number|null */
export function MoneyInput({ value, onChange, allowNegative, placeholder = '0', ...rest }) {
  const fmt = (v) => (v === null || v === undefined || v === '' ? '' : new Intl.NumberFormat('en-US').format(v));
  const [text, setText] = useState(fmt(value));
  useEffect(() => { setText((t) => (parseText(t) === value ? t : fmt(value))); }, [value]);
  function parseText(t) {
    const s = String(t).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d-]/g, '');
    if (s === '' || s === '-') return null;
    const n = Number(allowNegative ? s.replace(/(?!^)-/g, '') : s.replace(/-/g, ''));
    return Number.isSafeInteger(n) ? n : null;
  }
  return (
    <div className="input-wrap">
      <input className="input money" inputMode="numeric" placeholder={placeholder} value={text} style={{ paddingInlineStart: 12, paddingInlineEnd: 44 }}
        onChange={(e) => { const n = parseText(e.target.value); setText(n === null ? e.target.value.replace(/[^\d٠-٩-]/g, '') : (String(e.target.value).trim().startsWith('-') && n === 0 ? '-' : fmt(n))); onChange(n); }} {...rest} />
      <span className="input-suffix">IQD</span>
    </div>
  );
}
export function Stepper({ value, onChange, min = 0, max = 100, changed, locked, label }) {
  const v = Number(value) || 0;
  return (
    <div className={`stepper ${changed ? 'changed' : ''} ${locked ? 'locked' : ''}`} aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, v - 1))} aria-label="-"><Icon name="minus" size={16} /></button>
      <input inputMode="numeric" value={value} onFocus={(e) => e.target.select()}
        onChange={(e) => { const s = e.target.value.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, ''); onChange(s === '' ? 0 : Math.min(max, Number(s))); }} />
      <button type="button" onClick={() => onChange(Math.min(max, v + 1))} aria-label="+"><Icon name="plus" size={16} /></button>
    </div>
  );
}
export function Badge({ tone = '', children, plain }) { return <span className={`badge ${tone} ${plain ? 'plain' : ''}`}>{children}</span>; }

export const STATUS_TONE = {
  pending: 'amber', approved: 'blue', paid: 'green', adjusted: 'violet', active: 'green', inactive: 'amber', terminated: 'red', suspended: 'red',
  rejected: 'red', void: '', deleted: 'red',
};
export function PayrollStatus({ status }) { const { t } = useI18n(); return <Badge tone={STATUS_TONE[status]}>{t('ps_' + status)}</Badge>; }

export function Skeleton({ h = 16, w = '100%', r, style }) { return <div className="skeleton" style={{ height: h, width: w, borderRadius: r, ...style }} />; }
export function SkeletonRows({ rows = 6 }) {
  return <div className="grid" style={{ gap: 10, padding: 16 }}>{Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={34} w={`${100 - (i % 3) * 8}%`} />)}</div>;
}
export function Empty({ icon = 'sparkles', title, hint, action }) {
  const { t } = useI18n();
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={26} /></div>
      <h4>{title || t('no_data')}</h4>
      <div className="small">{hint || t('no_data_hint')}</div>
      {action}
    </div>
  );
}
export function ErrorState({ error, onRetry }) {
  const { lang, t } = useI18n();
  return (
    <div className="empty">
      <div className="empty-icon" style={{ background: 'color-mix(in srgb, var(--danger) 14%, transparent)', color: 'var(--danger)' }}><Icon name="alert" size={26} /></div>
      <h4>{errorText(lang, error)}</h4>
      {onRetry && <Button icon="refresh" onClick={onRetry}>{t('retry')}</Button>}
    </div>
  );
}
export function Alert({ tone = 'info', children }) {
  return <div className={`alert ${tone}`}><Icon name={tone === 'info' ? 'info' : 'alert'} size={17} /><div className="grow">{children}</div></div>;
}

// ------------------------------------------------------------------ modal
export function Modal({ open, onClose, title, children, footer, size = '' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  // Rendered at the document root so no animated/transformed ancestor can trap or clip it.
  return createPortal(
    <div className="overlay" dir={document.documentElement.dir} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }} onClick={(e) => e.stopPropagation()}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h3>{title}</h3><Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="close" /></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation dialog; when requireReason, a reason (≥3 chars) is collected and passed to onConfirm. */
const ConfirmCtx = createContext(null);
export function ConfirmProvider({ children }) {
  const { t } = useI18n();
  const [st, setSt] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = useCallback((opts) => new Promise((resolve) => { setReason(''); setSt({ ...opts, resolve }); }), []);
  const close = (v) => { st?.resolve(v); setSt(null); setBusy(false); };
  const valid = !st?.requireReason || reason.trim().length >= 3;
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal open={!!st} onClose={() => close(null)} title={st?.title || t('are_you_sure')}
        footer={<>
          <Button variant="ghost" onClick={() => close(null)}>{t('cancel')}</Button>
          <Button variant={st?.danger ? 'danger' : 'primary'} disabled={!valid} loading={busy}
            onClick={() => { setBusy(true); close(st?.requireReason ? reason.trim() : true); }}>{st?.confirmText || t('confirm')}</Button>
        </>}>
        {st?.message && <div className="muted">{st.message}</div>}
        {st?.requireReason && (
          <Field label={t('reason')} hint={t('reason_hint')}>
            <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
        )}
        {!st?.requireReason && <div className="hint">{t('irreversible')}</div>}
      </Modal>
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ------------------------------------------------------------------ tabs
export function Tabs({ value, onChange, items }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => <button key={i.value} role="tab" aria-selected={value === i.value} className={`tab ${value === i.value ? 'on' : ''}`} onClick={() => onChange(i.value)}>{i.label}{i.count != null && <span className="faint"> · {i.count}</span>}</button>)}
    </div>
  );
}

// ------------------------------------------------------------------ data table (cards on mobile)
export function DataTable({ columns, rows, loading, error, onRetry, onRowClick, rowKey = 'id', empty, footer, selectable, selected, onSelect, initialSort, mobileTitle }) {
  const [sort, setSort] = useState(initialSort || null);
  const sorted = useMemo(() => {
    if (!sort || !rows) return rows || [];
    const col = columns.find((c) => c.key === sort.key);
    const get = col?.sortValue || ((r) => r[sort.key]);
    return [...rows].sort((a, b) => { const x = get(a), y = get(b); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'ar'); return sort.dir === 'asc' ? c : -c; });
  }, [rows, sort, columns]);
  if (loading && !rows) return <SkeletonRows />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!sorted.length) return empty || <Empty />;
  const allSel = selectable && sorted.every((r) => selected?.has(r[rowKey]));
  return (
    <div className="table-wrap responsive">
      <table className="table">
        <thead><tr>
          {selectable && <th style={{ width: 40 }}><input type="checkbox" className="check" checked={allSel} onChange={(e) => onSelect(new Set(e.target.checked ? sorted.filter((r) => selectable(r)).map((r) => r[rowKey]) : []))} /></th>}
          {columns.map((c) => (
            <th key={c.key} className={`${c.num ? 'n' : ''} ${c.sortable !== false ? 'sortable' : ''} ${c.className || ''}`} style={{ width: c.width }}
              onClick={() => c.sortable !== false && setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
              {c.label}{sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
            </th>
          ))}
        </tr></thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={r[rowKey]} className={`${onRowClick ? 'clickable' : ''} ${selected?.has(r[rowKey]) ? 'selected' : ''}`} onClick={() => onRowClick?.(r)}>
              {selectable && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" className="check" disabled={!selectable(r)} checked={selected?.has(r[rowKey]) || false}
                onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(r[rowKey]) : s.delete(r[rowKey]); onSelect(s); }} /></td>}
              {columns.map((c) => <td key={c.key} className={`${c.num ? 'n num' : ''} ${c.primary ? 'primary-cell' : ''} ${c.className || ''}`}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot><tr>{selectable && <td />}{columns.map((c) => <td key={c.key} className={`${c.num ? 'n num' : ''} ${c.className || ''}`}>{footer[c.key] ?? ''}</td>)}</tr></tfoot>}
      </table>
      <div className="cards-list">
        {sorted.map((r) => (
          <div key={r[rowKey]} className="m-card" onClick={() => onRowClick?.(r)} style={{ cursor: onRowClick ? 'pointer' : undefined }}>
            <div className="row between">
              {selectable && <input type="checkbox" className="check" onClick={(e) => e.stopPropagation()} disabled={!selectable(r)} checked={selected?.has(r[rowKey]) || false}
                onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(r[rowKey]) : s.delete(r[rowKey]); onSelect(s); }} />}
              <b className="grow ellipsis">{mobileTitle ? mobileTitle(r) : (columns[0].render ? columns[0].render(r) : r[columns[0].key])}</b>
            </div>
            {columns.slice(1).filter((c) => !c.hideMobile).map((c) => (
              <div key={c.key} className="m-kv"><span>{c.label}</span><span className={c.num ? 'num' : ''} onClick={(e) => c.stop && e.stopPropagation()}>{c.render ? c.render(r) : r[c.key]}</span></div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ KPI with animated counter
export function useCountUp(target, enabled = true, duration = 900) {
  const [v, setV] = useState(enabled ? 0 : target);
  const from = useRef(0);
  useEffect(() => {
    if (!enabled) { setV(target); return undefined; }
    const start = performance.now(); const a = from.current; let raf;
    const step = (now) => { const p = Math.min(1, (now - start) / duration); const e = 1 - Math.pow(1 - p, 3); setV(Math.round(a + (target - a) * e)); if (p < 1) raf = requestAnimationFrame(step); else from.current = target; };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, duration]);
  return v;
}
export function Kpi({ label, value, money, icon = 'trend', color, foot, hero, loading }) {
  const { prefs } = usePrefs();
  const f = useFmt();
  const v = useCountUp(Number(value) || 0, prefs.animations);
  return (
    <div className={`card kpi ${hero ? 'hero' : ''}`} style={color ? { '--k': color } : undefined}>
      <div className="kpi-label"><span className="kpi-icon"><Icon name={icon} size={16} /></span>{label}</div>
      {loading ? <Skeleton h={30} w="70%" style={{ marginTop: 12 }} /> : (
        <div className="kpi-value num">{money ? f.moneyPlain(v) : f.num(v)}{money && <small>{f.digits === 'arab' ? 'د.ع' : 'IQD'}</small>}</div>
      )}
      {foot && <div className="kpi-foot">{foot}</div>}
    </div>
  );
}

export function PageHead({ title, sub, actions }) {
  return (
    <div className="page-head">
      <div><h1 className="page-title">{title}</h1>{sub && <p className="page-sub">{sub}</p>}</div>
      {actions && <div className="row wrap">{actions}</div>}
    </div>
  );
}
