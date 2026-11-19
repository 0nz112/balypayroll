// Professional paginated PDF reports:
//   • Promoter sales report (كشف مبيعات المروج) with direct WhatsApp send to the promoter
//   • Full inventory (الجرد الشامل) of all promoters for a day / days / week / month
// Pages are real A4 pages (794×1123 CSS px) rendered as HTML (perfect Arabic shaping),
// captured at 2× and assembled into one PDF. Tables paginate with repeated headers.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../app/context.js';
import { useI18n, translate } from '../lib/i18n.js';
import { usePrefs } from '../lib/prefs.js';
import { Alert, Badge, Button, Card, DataTable, Empty, Kpi, Modal, Seg, Skeleton, useAsync, useFmt, useToast, Tabs } from '../ui/ui.jsx';
import { DateRange, ManagerFilter } from '../app/shared.jsx';
import { addDays, baghdadToday, rangePreset, weekStartOf } from '../engine/dates.js';
import { formatIQD, formatNumber } from '../engine/money.js';
import { downloadBlob, openWhatsApp, pagesToPdf, toXLSXSheets } from '../lib/export.js';

// ------------------------------------------------------------------ data shaping
const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);

export function summarize(inv, promoterId) {
  const days = inv.days.filter((d) => !promoterId || d.promoter_id === promoterId);
  const weeks = inv.weeks.filter((w) => !promoterId || w.promoter_id === promoterId);
  const promoters = inv.promoters.filter((p) => !promoterId || p.id === promoterId);
  const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);
  return {
    days, weeks, promoters,
    cars: sum(days, (d) => d.count), active: sum(days, (d) => d.active), dayInc: sum(days, (d) => d.incentive + d.bonus),
    daysWorked: new Set(days.map((d) => d.date + '|' + d.promoter_id)).size,
    earn: sum(weeks, (w) => w.base_amount), inc: sum(weeks, (w) => w.incentive_amount), ded: sum(weeks, (w) => w.total_deductions),
    net: sum(weeks, (w) => w.effective_net), paid: sum(weeks, (w) => w.paid_total), out: sum(weeks, (w) => Math.max(0, w.outstanding)),
    bonusWeeks: weeks.filter((w) => w.bonus_applied).length, debt: sum(promoters, (p) => p.debt_balance),
  };
}

function fmtFactory(lang, digits) {
  const loc = lang === 'ar' ? `ar-IQ-u-nu-${digits}` : 'en-GB';
  const d = (iso) => new Date(iso + 'T00:00:00Z');
  return {
    t: (k, v) => translate(lang, k, v),
    m: (n) => formatIQD(n, lang, { digits }), mp: (n) => formatIQD(n, lang, { digits, withUnit: false }), n: (x) => formatNumber(x, lang, digits),
    date: (iso) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(d(iso)),
    short: (iso) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d(iso)),
    dm: (iso) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(d(iso)),
    wd: (iso) => new Intl.DateTimeFormat(loc, { weekday: 'long', timeZone: 'UTC' }).format(d(iso)),
    now: () => new Date().toLocaleString(loc, { timeZone: 'Asia/Baghdad', dateStyle: 'medium', timeStyle: 'short' }),
  };
}

function promoterSections(S, F) {
  const { t, n, mp, dm, wd } = F;
  return [
    { title: t('daily_details'), columns: [
        { label: t('date'), v: (d) => F.date(d.date), w: 15 }, { label: t('weekday'), v: (d) => wd(d.date), w: 12 },
        { label: t('week_col'), v: (d) => `${dm(weekStartOf(d.date))} – ${dm(addDays(weekStartOf(d.date), 6))}`, w: 12 },
        { label: t('cars'), v: (d) => n(d.count), num: true }, { label: t('active_cars'), v: (d) => n(d.active), num: true },
        { label: t('registered_only'), v: (d) => n(d.count - d.active), num: true }, { label: t('activity'), v: (d) => `${n(pct(d.active, d.count))}%`, num: true },
        { label: t('incentives_bonuses'), v: (d) => (d.incentive + d.bonus ? mp(d.incentive + d.bonus) : '—'), num: true }],
      rows: S.days,
      total: [t('total'), '', '', n(S.cars), n(S.active), n(S.cars - S.active), `${n(pct(S.active, S.cars))}%`, mp(S.dayInc)] },
    { title: t('weekly_summary'), columns: [
        { label: t('week'), v: (w) => `${dm(w.week_start)} – ${dm(w.week_end)}`, w: 11 }, { label: t('pay_day'), v: (w) => dm(w.pay_date) },
        { label: `${t('cars')} / ✓`, v: (w) => `${n(w.reg_count)} / ${n(w.active_count)}`, num: true },
        { label: t('rate'), v: (w) => (w.bonus_applied ? `★ ${F.mp(w.reg_count ? Math.round(w.base_amount / w.reg_count) : 0)}` : t('standard_rate')) },
        { label: t('car_earnings'), v: (w) => mp(w.base_amount), num: true }, { label: t('incentives_bonuses'), v: (w) => mp(w.incentive_amount), num: true },
        { label: t('deductions'), v: (w) => mp(w.total_deductions), num: true }, { label: t('net'), v: (w) => mp(w.effective_net), num: true, strong: true },
        { label: t('paid_total'), v: (w) => mp(w.paid_total), num: true }, { label: t('status'), v: (w) => t('ps_' + w.status) }],
      rows: S.weeks,
      total: [t('total'), '', `${n(S.weeks.reduce((s, w) => s + w.reg_count, 0))} / ${n(S.weeks.reduce((s, w) => s + w.active_count, 0))}`, '', mp(S.earn), mp(S.inc), mp(S.ded), mp(S.net), mp(S.paid), ''] },
  ];
}

function inventorySections(S, inv, F) {
  const { t, n, mp, wd } = F;
  const byP = S.promoters.map((p) => {
    const d = S.days.filter((x) => x.promoter_id === p.id); const w = S.weeks.filter((x) => x.promoter_id === p.id);
    const cars = d.reduce((s, x) => s + x.count, 0); const act = d.reduce((s, x) => s + x.active, 0);
    return { ...p, days: new Set(d.map((x) => x.date)).size, cars, act, inc: d.reduce((s, x) => s + x.incentive + x.bonus, 0),
      earn: w.reduce((s, x) => s + x.base_amount, 0), net: w.reduce((s, x) => s + x.effective_net, 0), bonusWeeks: w.filter((x) => x.bonus_applied).length };
  }).filter((p) => p.cars || p.earn || p.net).sort((a, b) => b.cars - a.cars || a.full_name.localeCompare(b.full_name, 'ar'));
  const dates = [...new Set(S.days.map((d) => d.date))].sort();
  const byD = dates.map((date) => { const d = S.days.filter((x) => x.date === date); const cars = d.reduce((s, x) => s + x.count, 0); const act = d.reduce((s, x) => s + x.active, 0);
    return { date, people: new Set(d.map((x) => x.promoter_id)).size, cars, act, inc: d.reduce((s, x) => s + x.incentive + x.bonus, 0) }; });
  const name = (id) => inv.promoters.find((p) => p.id === id)?.full_name || '';
  return { byP, byD, sections: [
    { title: t('by_promoter'), columns: [
        { label: '#', v: (r, i) => n(i + 1), w: 4 }, { label: t('promoter'), v: (r) => r.full_name, w: 18, strong: true }, { label: t('manager'), v: (r) => r.manager_name, w: 14 },
        { label: t('days_worked'), v: (r) => n(r.days), num: true }, { label: t('cars'), v: (r) => n(r.cars), num: true }, { label: t('active_cars'), v: (r) => n(r.act), num: true },
        { label: t('activity'), v: (r) => `${n(pct(r.act, r.cars))}%${r.bonusWeeks ? ' ★' : ''}`, num: true }, { label: t('incentives_bonuses'), v: (r) => mp(r.inc), num: true },
        { label: t('car_earnings'), v: (r) => mp(r.earn), num: true }, { label: t('total_net'), v: (r) => mp(r.net), num: true, strong: true }, { label: t('debt_balance'), v: (r) => mp(r.debt_balance), num: true }],
      rows: byP,
      total: [t('total'), '', '', '', n(S.cars), n(S.active), `${n(pct(S.active, S.cars))}%`, mp(S.dayInc), mp(S.earn), mp(S.net), mp(S.debt)] },
    { title: t('by_day'), columns: [
        { label: t('date'), v: (r) => F.date(r.date), w: 16 }, { label: t('weekday'), v: (r) => wd(r.date) }, { label: t('promoters_active'), v: (r) => n(r.people), num: true },
        { label: t('cars'), v: (r) => n(r.cars), num: true }, { label: t('active_cars'), v: (r) => n(r.act), num: true }, { label: t('activity'), v: (r) => `${n(pct(r.act, r.cars))}%`, num: true },
        { label: t('incentives_bonuses'), v: (r) => mp(r.inc), num: true }],
      rows: byD, total: [t('total'), '', '', n(S.cars), n(S.active), `${n(pct(S.active, S.cars))}%`, mp(S.dayInc)] },
    { title: t('details'), columns: [
        { label: t('date'), v: (r) => F.date(r.date), w: 15 }, { label: t('promoter'), v: (r) => name(r.promoter_id), w: 20, strong: true },
        { label: t('cars'), v: (r) => n(r.count), num: true }, { label: t('active_cars'), v: (r) => n(r.active), num: true },
        { label: t('registered_only'), v: (r) => n(r.count - r.active), num: true }, { label: t('activity'), v: (r) => `${n(pct(r.active, r.count))}%`, num: true },
        { label: t('incentives_bonuses'), v: (r) => (r.incentive + r.bonus ? mp(r.incentive + r.bonus) : '—'), num: true }],
      rows: S.days },
  ] };
}

// ------------------------------------------------------------------ pagination
const PAGE_H = 1123, HEAD = 118, FOOT = 46, PAD = 30, ROW = 25, THEAD = 30, TITLE = 38, TOTAL = 28, GAP = 12;
const BODY = PAGE_H - HEAD - FOOT - PAD * 2;
function paginate(sections, introH) {
  const pages = [[]]; let left = BODY - introH;
  for (const sec of sections) {
    let i = 0;
    if (!sec.rows.length) {
      if (left < TITLE + THEAD + ROW) { pages.push([]); left = BODY; }
      pages[pages.length - 1].push({ sec, from: 0, to: 0, empty: true, total: false }); left -= TITLE + THEAD + ROW + GAP; continue;
    }
    while (i < sec.rows.length) {
      if (left < TITLE + THEAD + ROW * 2) { pages.push([]); left = BODY; }
      const fit = Math.max(1, Math.floor((left - TITLE - THEAD) / ROW));
      const to = Math.min(sec.rows.length, i + fit);
      const last = to === sec.rows.length;
      let usedRows = to - i;
      if (last && sec.total && left - TITLE - THEAD - usedRows * ROW < TOTAL && usedRows > 1) usedRows -= 1;
      const end = i + usedRows;
      pages[pages.length - 1].push({ sec, from: i, to: end, cont: i > 0, total: end === sec.rows.length && !!sec.total });
      left -= TITLE + THEAD + usedRows * ROW + (end === sec.rows.length && sec.total ? TOTAL : 0) + GAP;
      i = end;
    }
  }
  return pages;
}

// ------------------------------------------------------------------ page rendering
const C = { ink: '#0f172a', sub: '#64748b', line: '#e2e8f0', zebra: '#f8fafc', head: '#eff6ff', accent: '#0891b2', accent2: '#2563eb' };

function Page({ children, F, title, subtitle, company, idx, total, lang }) {
  return (
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ width: 794, height: PAGE_H, background: '#fff', color: C.ink, position: 'relative', boxSizing: 'border-box', overflow: 'hidden',
      fontFamily: "'Cairo','IBM Plex Sans Arabic','Segoe UI',Tahoma,sans-serif" }}>
      <div style={{ height: HEAD, padding: '22px 30px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: '#fff',
        background: 'linear-gradient(120deg,#06263a 0%,#0b3b66 55%,#1d4ed8 100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: 'linear-gradient(135deg,#22d3ee,#3b82f6)', display: 'grid', placeItems: 'center', color: '#04121f', fontSize: 26, fontWeight: 900 }}>↗</div>
          <div><div style={{ fontSize: 20, fontWeight: 800 }}>{title}</div><div style={{ fontSize: 12.5, opacity: 0.85 }}>{company}</div></div>
        </div>
        <div style={{ textAlign: 'end', fontSize: 12.5, lineHeight: 1.7 }}>{subtitle}</div>
      </div>
      <div style={{ padding: `${PAD}px 30px 0` }}>{children}</div>
      <div style={{ position: 'absolute', insetInline: 30, bottom: 0, height: FOOT, borderTop: `1px solid ${C.line}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10.5, color: C.sub }}>
        <span>{F.t('st_footer')} · {F.t('st_generated')}: {F.now()}</span><span>{F.t('page_of', { p: F.n(idx + 1), n: F.n(total) })}</span>
      </div>
    </div>
  );
}

function SectionTable({ chunk, F }) {
  const { sec } = chunk;
  const rows = sec.rows.slice(chunk.from, chunk.to);
  const th = { padding: '0 6px', height: THEAD, fontSize: 10.5, fontWeight: 800, color: '#1e3a8a', background: C.head, borderBottom: `2px solid ${C.accent}`, textAlign: 'start', whiteSpace: 'nowrap' };
  const td = { padding: '0 6px', height: ROW, fontSize: 10.5, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 };
  return (
    <div style={{ marginBottom: GAP }}>
      <div style={{ height: TITLE, display: 'flex', alignItems: 'center', gap: 8, fontSize: 14.5, fontWeight: 800 }}>
        <span style={{ width: 5, height: 18, borderRadius: 3, background: `linear-gradient(${C.accent},${C.accent2})` }} />{sec.title}{chunk.cont ? ' (…)' : ''}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'auto' }}>
        <thead><tr>{sec.columns.map((c, i) => <th key={i} style={{ ...th, textAlign: c.num ? 'end' : 'start' }}>{c.label}</th>)}</tr></thead>
        <tbody>
          {chunk.empty ? <tr><td colSpan={sec.columns.length} style={{ ...td, textAlign: 'center', color: C.sub }}>{F.t('no_data')}</td></tr>
            : rows.map((r, i) => (
              <tr key={i} style={{ background: (chunk.from + i) % 2 ? C.zebra : '#fff' }}>
                {sec.columns.map((c, j) => <td key={j} style={{ ...td, textAlign: c.num ? 'end' : 'start', fontWeight: c.strong ? 800 : 500, fontVariantNumeric: 'tabular-nums' }}>{c.v(r, chunk.from + i)}</td>)}
              </tr>
            ))}
        </tbody>
        {chunk.total && <tfoot><tr>{sec.total.map((v, j) => <td key={j} style={{ ...td, height: TOTAL, background: '#0f172a', color: '#fff', fontWeight: 800, textAlign: sec.columns[j]?.num ? 'end' : 'start' }}>{v}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

function KpiStrip({ items }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(items.length, 4)}, 1fr)`, gap: 8, marginBottom: 14 }}>
      {items.map(([label, value, color], i) => (
        <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '9px 12px', background: i === 0 ? 'linear-gradient(135deg,#ecfeff,#eff6ff)' : '#fff' }}>
          <div style={{ fontSize: 10.5, color: C.sub, fontWeight: 700 }}>{label}</div>
          <div style={{ fontSize: 16, fontWeight: 900, color: color || C.ink, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

/** Renders all pages; refs are collected for PDF capture. */
function Document({ kind, inv, promoterId, company, lang, digits, pageRefs }) {
  const F = useMemo(() => fmtFactory(lang, digits), [lang, digits]);
  const S = useMemo(() => summarize(inv, promoterId), [inv, promoterId]);
  const p = S.promoters[0];
  const subtitle = <>{F.t('period')}: <b>{F.date(inv.from)} — {F.date(inv.to)}</b><br />{F.t('timezone')}: Asia/Baghdad · IQD</>;
  let intro; let introH; let sections; let title;
  if (kind === 'promoter') {
    title = F.t('sales_report');
    sections = promoterSections(S, F);
    introH = 268;
    intro = (
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: `1px solid ${C.line}`, borderRadius: 14, padding: '14px 18px', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 900 }}>{p?.full_name}</div>
            <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{F.t('manager')}: <b style={{ color: C.ink }}>{p?.manager_name}</b> · {F.t('start_date')}: {p ? F.date(p.start_date) : ''} · {F.t('st_' + (p?.status || 'active'))}</div>
          </div>
          <div style={{ textAlign: 'end', fontSize: 12, color: C.sub, direction: 'ltr' }}>☎ {p?.phone}<br />{p?.whatsapp ? `WhatsApp ${p.whatsapp}` : ''}</div>
        </div>
        <KpiStrip items={[[F.t('cars_registered'), F.n(S.cars)], [F.t('active_cars'), `${F.n(S.active)} (${F.n(pct(S.active, S.cars))}%)`, '#059669'],
          [F.t('registered_only'), F.n(S.cars - S.active)], [F.t('days_worked'), F.n(S.daysWorked)]]} />
        <KpiStrip items={[[F.t('car_earnings'), F.m(S.earn), C.accent], [F.t('incentives_bonuses'), F.m(S.inc), '#7c3aed'], [F.t('deductions'), F.m(S.ded), '#e11d48'],
          [F.t('net'), F.m(S.net), '#0f172a']]} />
        <KpiStrip items={[[F.t('paid_total'), F.m(S.paid)], [F.t('outstanding'), F.m(S.out), '#d97706'], [F.t('debt_balance'), F.m(S.debt), '#e11d48'], [`★ ${F.t('bonus_rate')}`, F.n(S.bonusWeeks)]]} />
      </>
    );
  } else {
    title = F.t('inventory');
    sections = inventorySections(S, inv, F).sections;
    introH = 168;
    intro = (
      <>
        <KpiStrip items={[[F.t('cars_registered'), F.n(S.cars)], [F.t('active_cars'), `${F.n(S.active)} (${F.n(pct(S.active, S.cars))}%)`, '#059669'],
          [F.t('promoters_active'), F.n(new Set(S.days.map((d) => d.promoter_id)).size)], [F.t('incentives_bonuses'), F.m(S.dayInc), '#7c3aed']]} />
        <KpiStrip items={[[F.t('car_earnings'), F.m(S.earn), C.accent], [F.t('deductions'), F.m(S.ded), '#e11d48'], [F.t('total_net'), F.m(S.net)], [F.t('debt_balance'), F.m(S.debt), '#e11d48']]} />
        <div style={{ fontSize: 10.5, color: C.sub, marginTop: -6, marginBottom: 6 }}>{F.t('weekly_earnings_note')}</div>
      </>
    );
  }
  const pages = paginate(sections, introH);
  return pages.map((chunks, i) => (
    <div key={i} ref={(el) => { pageRefs.current[i] = el; }} style={{ marginBottom: 16, boxShadow: '0 6px 30px rgba(0,0,0,.35)' }}>
      <Page F={F} title={title} subtitle={subtitle} company={company} idx={i} total={pages.length} lang={lang}>
        {i === 0 && intro}
        {chunks.map((c, j) => <SectionTable key={j} chunk={c} F={F} />)}
      </Page>
    </div>
  ));
}

export function whatsappText(inv, promoterId, lang, digits, company) {
  const F = fmtFactory(lang, digits); const S = summarize(inv, promoterId); const p = S.promoters[0];
  const lines = [F.t('wa_header', { title: `${F.t('sales_report')} — ${p?.full_name || ''}` }), F.t('wa_period', { from: F.date(inv.from), to: F.date(inv.to) }), '',
    F.t('wa_totals', { cars: F.n(S.cars), active: F.n(S.active), pct: F.n(pct(S.active, S.cars)) }), ''];
  for (const d of S.days.slice(0, 31)) lines.push(`• ${F.wd(d.date)} ${F.short(d.date)}: ${F.n(d.count)} 🚗 / ${F.n(d.active)} ✅${d.incentive + d.bonus ? ` 🎁 ${F.mp(d.incentive + d.bonus)}` : ''}`);
  if (S.days.length > 31) lines.push('…');
  if (S.weeks.length) { lines.push(''); for (const w of S.weeks) lines.push(`🗓️ ${F.short(w.week_start)} – ${F.short(w.week_end)}: ${F.m(w.effective_net)}${w.bonus_applied ? ' ★' : ''} (${F.t('ps_' + w.status)})`); }
  lines.push('', F.t('wa_earn', { earn: F.m(S.earn), inc: F.m(S.inc), ded: F.m(S.ded), net: F.m(S.net) }), F.t('wa_debt', { debt: F.m(S.debt) }), '', F.t('wa_footer', { company }));
  return lines.join('\n');
}

function useDocCapture() {
  const pageRefs = useRef([]);
  const capture = async (title) => { const nodes = pageRefs.current.filter(Boolean); return pagesToPdf(nodes, { title }); };
  return { pageRefs, capture };
}

const PRESETS = [['week', 'this_week'], ['last_week', 'last_week'], ['month', 'this_month'], ['last_month', 'last_month']];

// ------------------------------------------------------------------ promoter report modal
export function SalesReportButton({ promoter, size, label = true }) {
  const { t } = useI18n(); const [open, setOpen] = useState(false);
  return <>
    <Button size={size} icon="file" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{label ? t('sales_report') : ''}</Button>
    {open && <SalesReportModal promoter={promoter} onClose={() => setOpen(false)} />}
  </>;
}

function SalesReportModal({ promoter, onClose }) {
  const { api, settings } = useApp(); const { t, lang } = useI18n(); const { prefs } = usePrefs(); const toast = useToast();
  const digits = lang === 'ar' ? prefs.digits : 'latn';
  const [range, setRange] = useState(() => rangePreset('week'));
  const [busy, setBusy] = useState('');
  const { data, loading, error } = useAsync(() => api.inventoryReport(range.from, range.to, null, promoter.id), [api, range.from, range.to, promoter.id]);
  const { pageRefs, capture } = useDocCapture();
  const file = `sales-${promoter.full_name.replace(/\s+/g, '_')}-${range.from}_${range.to}.pdf`;
  const number = promoter.whatsapp || promoter.phone;
  const preset = PRESETS.find(([k]) => { const r = rangePreset(k); return r.from === range.from && r.to === range.to; })?.[0] || 'custom';

  async function pdf() { setBusy('pdf'); try { downloadBlob(await capture(file), file); } catch (e) { toast.error(e); } finally { setBusy(''); } }
  async function whatsapp() {
    if (!number) { toast.error(t('no_whatsapp')); return; }
    openWhatsApp(number, whatsappText(data, promoter.id, lang, digits, settings.company_name)); // must run in the click gesture
    setBusy('wa');
    try { downloadBlob(await capture(file), file); toast.info(t('wa_opened')); } catch (e) { toast.error(e); } finally { setBusy(''); }
  }
  async function share() {
    setBusy('share');
    try {
      const blob = await capture(file); const f = new File([blob], file, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: file, text: t('sales_report') }); toast.info(t('share_ready')); } catch { toast.info(t('share_cancelled')); } }
      else { downloadBlob(blob, file); toast.info(t('share_fallback')); }
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  }
  return (
    <Modal open onClose={onClose} size="xwide" title={`${t('sales_report')} — ${promoter.full_name}`}
      footer={<>
        <Button icon="file" loading={busy === 'pdf'} disabled={!data || !!busy} onClick={pdf}>{t('download_pdf')}</Button>
        <Button icon="share" loading={busy === 'share'} disabled={!data || !!busy} onClick={share}>{t('share_pdf')}</Button>
        <Button variant="primary" icon="whatsapp" loading={busy === 'wa'} disabled={!data || !!busy} onClick={whatsapp} style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)', color: '#fff' }}>{t('send_whatsapp')}</Button>
      </>}>
      <div className="row wrap" style={{ gap: 10 }}>
        <Seg accent value={preset} onChange={(k) => k !== 'custom' && setRange(rangePreset(k))} options={[...PRESETS.map(([k, l]) => ({ value: k, label: t(l) })), { value: 'custom', label: t('custom') }]} />
        <DateRange value={range} onChange={setRange} />
      </div>
      <Alert>{t('send_whatsapp_hint')} <b className="num" dir="ltr">{number || t('no_whatsapp')}</b></Alert>
      <DocPreview>{loading && !data ? <Skeleton h={500} /> : error ? <Empty icon="alert" title={t('err_generic')} /> : data &&
        <Document kind="promoter" inv={data} promoterId={promoter.id} company={settings.company_name} lang={lang} digits={digits} pageRefs={pageRefs} />}</DocPreview>
    </Modal>
  );
}

function DocPreview({ children }) {
  const ref = useRef(null); const inner = useRef(null);
  const [scale, setScale] = useState(0.6); const [h, setH] = useState(0);
  useEffect(() => {
    const el = ref.current; if (!el) return undefined;
    const ro = new ResizeObserver(() => { setScale(Math.min(1, (el.clientWidth - 24) / 794)); setH(inner.current?.offsetHeight || 0); });
    ro.observe(el); if (inner.current) ro.observe(inner.current); return () => ro.disconnect();
  }, []);
  return (
    <div ref={ref} className="doc-preview">
      <div style={{ height: h ? h * scale : 'auto', overflow: 'hidden' }}>
        <div ref={inner} style={{ width: 794, transform: `scale(${scale})`, transformOrigin: 'top center', marginInline: 'auto' }}>{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ full inventory (Reports tab)
export function InventoryPanel() {
  const { api, settings, isAdmin } = useApp(); const { t, lang } = useI18n(); const { prefs } = usePrefs(); const f = useFmt(); const toast = useToast();
  const digits = lang === 'ar' ? prefs.digits : 'latn';
  const [range, setRange] = useState(() => rangePreset('today'));
  const [manager, setManager] = useState(null);
  const [tab, setTab] = useState('promoter');
  const [stage, setStage] = useState(false);
  const [busy, setBusy] = useState('');
  const { data, loading, error, reload } = useAsync(() => api.inventoryReport(range.from, range.to, manager, null), [api, range.from, range.to, manager]);
  const { pageRefs, capture } = useDocCapture();
  const F = useMemo(() => fmtFactory(lang, digits), [lang, digits]);
  const S = useMemo(() => (data ? summarize(data) : null), [data]);
  const inv = useMemo(() => (data && S ? inventorySections(S, data, F) : null), [data, S, F]);
  const file = `inventory-${range.from}_${range.to}`;

  async function pdf() {
    setBusy('pdf'); setStage(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try { downloadBlob(await capture(file), file + '.pdf'); } catch (e) { toast.error(e); } finally { setStage(false); setBusy(''); }
  }
  async function xlsx() {
    const name = (id) => data.promoters.find((p) => p.id === id)?.full_name || '';
    downloadBlob(await toXLSXSheets([
      { name: t('by_promoter'), rows: inv.byP, columns: [
        { label: t('promoter'), key: 'full_name', width: 26 }, { label: t('phone'), key: 'phone' }, { label: t('manager'), key: 'manager_name', width: 22 },
        { label: t('days_worked'), key: 'days' }, { label: t('cars'), key: 'cars' }, { label: t('active_cars'), key: 'act' }, { label: t('activity') + ' %', value: (r) => pct(r.act, r.cars) },
        { label: t('bonus_rate') + ' ★', key: 'bonusWeeks' }, { label: t('incentives_bonuses'), key: 'inc' }, { label: t('car_earnings'), key: 'earn' },
        { label: t('total_net'), key: 'net' }, { label: t('debt_balance'), key: 'debt_balance' }] },
      { name: t('by_day'), rows: inv.byD, columns: [
        { label: t('date'), key: 'date' }, { label: t('weekday'), value: (r) => F.wd(r.date) }, { label: t('promoters_active'), key: 'people' },
        { label: t('cars'), key: 'cars' }, { label: t('active_cars'), key: 'act' }, { label: t('activity') + ' %', value: (r) => pct(r.act, r.cars) }, { label: t('incentives_bonuses'), key: 'inc' }] },
      { name: t('details'), rows: S.days, columns: [
        { label: t('date'), key: 'date' }, { label: t('promoter'), value: (r) => name(r.promoter_id), width: 26 }, { label: t('cars'), key: 'count' }, { label: t('active_cars'), key: 'active' },
        { label: t('registered_only'), value: (r) => r.count - r.active }, { label: t('activity') + ' %', value: (r) => pct(r.active, r.count) },
        { label: t('incentive'), key: 'incentive' }, { label: t('daily_bonus'), key: 'bonus' }] },
    ]), file + '.xlsx');
  }
  function shareSummary() {
    const lines = [F.t('wa_header', { title: F.t('inventory') }), F.t('wa_period', { from: F.date(range.from), to: F.date(range.to) }), '',
      F.t('wa_totals', { cars: F.n(S.cars), active: F.n(S.active), pct: F.n(pct(S.active, S.cars)) }), ''];
    inv.byP.slice(0, 40).forEach((p, i) => lines.push(`${F.n(i + 1)}. ${p.full_name}: ${F.n(p.cars)} 🚗 / ${F.n(p.act)} ✅`));
    lines.push('', F.t('wa_footer', { company: settings.company_name }));
    window.open(`https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`, '_blank', 'noopener');
  }
  function sendOne(p) {
    const num = p.whatsapp || p.phone; if (!num) { toast.error(t('no_whatsapp')); return; }
    openWhatsApp(num, whatsappText(data, p.id, lang, digits, settings.company_name));
  }

  return (
    <>
      <div className="row wrap section" style={{ gap: 10 }}>
        <DateRange value={range} onChange={setRange} /><ManagerFilter value={manager} onChange={setManager} />
        <span className="grow" />
        <Button icon="file" disabled={!S} loading={busy === 'pdf'} onClick={pdf}>{t('export_pdf')}</Button>
        <Button icon="download" disabled={!S} onClick={xlsx}>{t('export_xlsx')}</Button>
        <Button icon="whatsapp" disabled={!S} onClick={shareSummary}>{t('share_summary')}</Button>
      </div>
      <div className="kpi-grid section">
        <Kpi hero label={t('cars_registered')} value={S?.cars || 0} icon="register" loading={loading && !data} foot={S ? `${f.num(S.active)} ${t('active_cars')} · ${f.num(pct(S.active, S.cars))}%` : ''} />
        <Kpi label={t('promoters_active')} value={S ? new Set(S.days.map((d) => d.promoter_id)).size : 0} icon="users" color="#f59e0b" loading={loading && !data} />
        <Kpi money label={t('incentives_bonuses')} value={S?.dayInc || 0} icon="gift" color="#8b5cf6" loading={loading && !data} />
        <Kpi money label={t('car_earnings')} value={S?.earn || 0} icon="money" color="#10b981" loading={loading && !data} />
        <Kpi money label={t('total_net')} value={S?.net || 0} icon="wallet" loading={loading && !data} />
      </div>
      <Card className="flush">
        <div style={{ padding: 'var(--pad) var(--pad) 0' }}><Tabs value={tab} onChange={setTab} items={[{ value: 'promoter', label: t('by_promoter'), count: inv?.byP.length }, { value: 'day', label: t('by_day'), count: inv?.byD.length }, { value: 'details', label: t('details'), count: S?.days.length }]} /></div>
        <div className="hint" style={{ padding: '0 var(--pad) 8px' }}>{t('weekly_earnings_note')}</div>
        {tab === 'promoter' && <DataTable rows={inv?.byP} loading={loading} error={error} onRetry={reload} initialSort={{ key: 'cars', dir: 'desc' }} columns={[
          { key: 'full_name', label: t('promoter'), primary: true, render: (r) => <div>{r.full_name}{isAdmin && <div className="tiny faint">{r.manager_name}</div>}</div> },
          { key: 'days', label: t('days_worked'), num: true, render: (r) => f.num(r.days) },
          { key: 'cars', label: t('cars'), num: true, render: (r) => <b>{f.num(r.cars)}</b> },
          { key: 'act', label: t('active_cars'), num: true, render: (r) => <span className="pos">{f.num(r.act)}</span> },
          { key: 'pct', label: t('activity'), num: true, sortValue: (r) => pct(r.act, r.cars), render: (r) => <span>{f.num(pct(r.act, r.cars))}%{r.bonusWeeks ? ' ★' : ''}</span> },
          { key: 'inc', label: t('incentives_bonuses'), num: true, hideMobile: true, render: (r) => f.money(r.inc) },
          { key: 'earn', label: t('car_earnings'), num: true, render: (r) => f.money(r.earn) },
          { key: 'net', label: t('total_net'), num: true, render: (r) => <b>{f.money(r.net)}</b> },
          { key: 'act2', label: '', sortable: false, stop: true, render: (r) => <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
            <Button size="sm" icon="whatsapp" onClick={() => sendOne(r)} aria-label={t('send_whatsapp')} style={{ color: '#25d366' }} />
            <SalesReportButton promoter={r} size="sm" label={false} /></span> },
        ]} />}
        {tab === 'day' && <DataTable rows={inv?.byD.map((d) => ({ ...d, id: d.date }))} loading={loading} error={error} onRetry={reload} initialSort={{ key: 'date', dir: 'asc' }} columns={[
          { key: 'date', label: t('date'), primary: true, render: (r) => <span>{f.date(r.date)} <span className="tiny faint">{f.weekday(r.date)}</span></span> },
          { key: 'people', label: t('promoters_active'), num: true, render: (r) => f.num(r.people) },
          { key: 'cars', label: t('cars'), num: true, render: (r) => <b>{f.num(r.cars)}</b> },
          { key: 'act', label: t('active_cars'), num: true, render: (r) => <span className="pos">{f.num(r.act)}</span> },
          { key: 'pct', label: t('activity'), num: true, sortValue: (r) => pct(r.act, r.cars), render: (r) => `${f.num(pct(r.act, r.cars))}%` },
          { key: 'inc', label: t('incentives_bonuses'), num: true, render: (r) => f.money(r.inc) },
        ]} />}
        {tab === 'details' && <DataTable rows={S?.days.map((d, i) => ({ ...d, id: d.date + d.promoter_id + i, name: data.promoters.find((p) => p.id === d.promoter_id)?.full_name }))} loading={loading} error={error} onRetry={reload} columns={[
          { key: 'date', label: t('date'), primary: true, render: (r) => f.date(r.date) },
          { key: 'name', label: t('promoter') },
          { key: 'count', label: t('cars'), num: true, render: (r) => <b>{f.num(r.count)}</b> },
          { key: 'active', label: t('active_cars'), num: true, render: (r) => <span className="pos">{f.num(r.active)}</span> },
          { key: 'pct', label: t('activity'), num: true, sortValue: (r) => pct(r.active, r.count), render: (r) => `${f.num(pct(r.active, r.count))}%` },
          { key: 'ib', label: t('incentives_bonuses'), num: true, sortValue: (r) => r.incentive + r.bonus, render: (r) => (r.incentive + r.bonus ? f.money(r.incentive + r.bonus) : '—') },
        ]} />}
      </Card>
      {stage && data && createPortal(<div className="statement-stage"><Document kind="inventory" inv={data} company={settings.company_name} lang={lang} digits={digits} pageRefs={pageRefs} /></div>, document.body)}
    </>
  );
}
