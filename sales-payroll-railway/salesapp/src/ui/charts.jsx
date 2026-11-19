import React, { useMemo, useRef, useState } from 'react';
import { useFmt } from './ui.jsx';
import { useI18n } from '../lib/i18n.js';

/** Responsive area/line chart. series: [{ key, label, color, money }] over data rows (x = row.date). */
export function AreaChart({ data, series, height = 240 }) {
  const f = useFmt();
  const { dir } = useI18n();
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const W = 800, H = height, padL = 46, padR = 12, padT = 14, padB = 26;
  const rtl = dir === 'rtl';
  const geo = useMemo(() => {
    const n = data.length;
    const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key] || 0)));
    const nice = niceMax(max);
    const x = (i) => { const p = n <= 1 ? 0.5 : i / (n - 1); return padL + (rtl ? 1 - p : p) * (W - padL - padR); };
    const y = (v) => padT + (1 - v / nice) * (H - padT - padB);
    return { n, nice, x, y };
  }, [data, series, rtl, H]);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((p) => p * geo.nice);
  const step = Math.max(1, Math.ceil(geo.n / 7));
  const path = (key) => data.map((d, i) => `${i ? 'L' : 'M'}${geo.x(i).toFixed(1)},${geo.y(d[key] || 0).toFixed(1)}`).join(' ');
  const smooth = (key) => {
    if (data.length < 3) return path(key);
    const pts = data.map((d, i) => [geo.x(i), geo.y(d[key] || 0)]);
    let s = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; const cx = (x0 + x1) / 2;
      s += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
    }
    return s;
  };
  function onMove(e) {
    const rect = ref.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0, bd = Infinity;
    for (let i = 0; i < geo.n; i++) { const dd = Math.abs(geo.x(i) - px); if (dd < bd) { bd = dd; best = i; } }
    setHover(best);
  }
  return (
    <div style={{ position: 'relative' }}>
      <svg ref={ref} className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
        onTouchMove={(e) => onMove(e.touches[0])} role="img">
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity=".38" /><stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((tk) => (
          <g key={tk}>
            <line className="grid-line" x1={padL} x2={W - padR} y1={geo.y(tk)} y2={geo.y(tk)} />
            <text className="axis" x={rtl ? W - 4 : 4} y={geo.y(tk) + 4} textAnchor={rtl ? 'end' : 'start'}>{compact(tk, f)}</text>
          </g>
        ))}
        {data.map((d, i) => (i % step === 0 || i === geo.n - 1) && (
          <text key={d.date} className="axis" x={geo.x(i)} y={H - 6} textAnchor="middle">{f.short(d.date)}</text>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            <path d={`${smooth(s.key)} L${geo.x(geo.n - 1)},${geo.y(0)} L${geo.x(0)},${geo.y(0)} Z`} fill={`url(#g-${s.key})`} />
            <path d={smooth(s.key)} fill="none" stroke={s.color} strokeWidth="2.4" vectorEffect="non-scaling-stroke" style={{ strokeDasharray: 3000, strokeDashoffset: 0, animation: 'dash 1.4s ease both' }} />
          </g>
        ))}
        {hover != null && (
          <g>
            <line x1={geo.x(hover)} x2={geo.x(hover)} y1={padT} y2={H - padB} stroke="var(--border-2)" strokeDasharray="4 4" />
            {series.map((s) => <circle key={s.key} cx={geo.x(hover)} cy={geo.y(data[hover][s.key] || 0)} r="5" fill={s.color} stroke="var(--surface)" strokeWidth="2" />)}
          </g>
        )}
        <style>{'@keyframes dash { from { stroke-dashoffset: 3000; } }'}</style>
      </svg>
      {hover != null && data[hover] && (
        <div className="chart-tip" style={{ left: `${(geo.x(hover) / W) * 100}%`, top: `${(geo.y(Math.max(...series.map((s) => data[hover][s.key] || 0))) / H) * 100}%` }}>
          <div className="faint tiny">{f.weekday(data[hover].date)} · {f.date(data[hover].date)}</div>
          {series.map((s) => <div key={s.key}><i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: s.color, marginInlineEnd: 6 }} />{s.label}: <b className="num">{s.money ? f.money(data[hover][s.key]) : f.num(data[hover][s.key])}</b></div>)}
        </div>
      )}
    </div>
  );
}

export function BarList({ items, valueKey = 'value', labelKey = 'label', money, sub }) {
  const f = useFmt();
  const max = Math.max(1, ...items.map((i) => i[valueKey] || 0));
  return (
    <div>
      {items.map((i, idx) => (
        <div key={i.id ?? idx} className="bar-row">
          <div className="ellipsis" title={i[labelKey]}><b className="small">{i[labelKey]}</b>{sub && <div className="tiny faint ellipsis">{sub(i)}</div>}</div>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${((i[valueKey] || 0) / max) * 100}%`, animationDelay: `${idx * 60}ms` }} /></div>
          <div className="num small" style={{ fontWeight: 800 }}>{money ? f.money(i[valueKey]) : f.num(i[valueKey])}</div>
        </div>
      ))}
    </div>
  );
}

export const PALETTE = ['#22d3ee', '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6', '#eab308'];

export function Donut({ items, size = 180, centerLabel }) {
  const f = useFmt();
  const total = items.reduce((s, i) => s + i.value, 0) || 1;
  const R = 70, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div className="row wrap" style={{ gap: 20, justifyContent: 'center' }}>
      <svg width={size} height={size} viewBox="0 0 180 180" role="img">
        <circle cx="90" cy="90" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="22" />
        {items.map((i, idx) => {
          const len = (i.value / total) * C; const off = acc; acc += len;
          return <circle key={idx} cx="90" cy="90" r={R} fill="none" stroke={i.color || PALETTE[idx % PALETTE.length]} strokeWidth="22"
            strokeDasharray={`${Math.max(0, len - 2)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 90 90)" style={{ transition: 'stroke-dasharray .8s' }} />;
        })}
        <text x="90" y="86" textAnchor="middle" fill="var(--text-3)" fontSize="11">{centerLabel}</text>
        <text x="90" y="106" textAnchor="middle" fill="var(--text)" fontSize="15" fontWeight="800">{compact(total === 1 && !items.length ? 0 : total, f)}</text>
      </svg>
      <div className="col" style={{ minWidth: 160 }}>
        {items.map((i, idx) => (
          <div key={idx} className="row between small" style={{ gap: 16 }}>
            <span><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: i.color || PALETTE[idx % PALETTE.length], marginInlineEnd: 8 }} />{i.label}</span>
            <b className="num">{f.money(i.value)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Sparkbars({ values, height = 34 }) {
  const max = Math.max(1, ...values);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${values.length * 10} ${height}`} preserveAspectRatio="none">
      {values.map((v, i) => <rect key={i} x={i * 10 + 1} width="8" y={height - (v / max) * height} height={(v / max) * height} rx="2" fill="var(--accent)" opacity={0.35 + (v / max) * 0.65} />)}
    </svg>
  );
}

function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
function compact(v, f) {
  if (v >= 1e9) return (Math.round(v / 1e8) / 10) + 'B';
  if (v >= 1e6) return (Math.round(v / 1e5) / 10) + 'M';
  if (v >= 1e4) return Math.round(v / 1e3) + 'K';
  return f.num(v);
}
