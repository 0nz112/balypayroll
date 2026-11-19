import React, { useMemo, useRef, useState } from 'react';
import { useApp, navigate } from '../app/context.js';
import { useI18n, translate } from '../lib/i18n.js';
import { Button, Card, DataTable, Input, PageHead, useAsync, useFmt, useToast, Badge, STATUS_TONE, Kpi } from '../ui/ui.jsx';
import { DateRange, ManagerFilter, SearchBox } from '../app/shared.jsx';
import { rangePreset } from '../engine/dates.js';
import { formatIQD, formatNumber } from '../engine/money.js';
import { toCSV, toXLSX, downloadBlob, nodeToPng, pngToPdf } from '../lib/export.js';
import { usePrefs } from '../lib/prefs.js';
import { InventoryPanel, SalesReportButton } from './SalesReport.jsx';
import { Tabs } from '../ui/ui.jsx';

export default function Reports() {
  const { t } = useI18n();
  const [tab, setTab] = useState('inventory');
  return (
    <>
      <PageHead title={t('rep_title')} sub={tab === 'inventory' ? t('inventory_sub') : t('rep_sub')} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'inventory', label: t('inventory') }, { value: 'performance', label: t('performance_report') }]} />
      {tab === 'inventory' ? <InventoryPanel /> : <Performance />}
    </>
  );
}

function Performance() {
  const { api, isAdmin, settings } = useApp();
  const { t, lang } = useI18n(); const f = useFmt(); const toast = useToast();
  const { prefs } = usePrefs();
  const [range, setRange] = useState(() => rangePreset('month'));
  const [manager, setManager] = useState(null);
  const [minRegs, setMinRegs] = useState(0);
  const [search, setSearch] = useState('');
  const [stage, setStage] = useState(false);
  const [busy, setBusy] = useState('');
  const ref = useRef(null);
  const { data, loading, error, reload } = useAsync(() => api.reportPerformance(range.from, range.to, manager), [api, range.from, range.to, manager]);
  const rows = useMemo(() => (data || []).map((r) => ({ ...r, id: r.promoter_id, avg: r.days_worked ? Math.round((r.registrations / r.days_worked) * 10) / 10 : 0, earnings: r.base_amount + r.incentive_amount + r.bonuses }))
    .filter((r) => r.registrations >= minRegs && (!search || r.full_name.includes(search) || r.phone.includes(search))), [data, minRegs, search]);
  const tot = rows.reduce((s, r) => ({ act: s.act + r.active, regs: s.regs + r.registrations, base: s.base + r.base_amount, inc: s.inc + r.incentive_amount, wd: s.wd + r.withdrawals, ded: s.ded + r.deductions, debt: s.debt + r.debt_balance }), { act: 0, regs: 0, base: 0, inc: 0, wd: 0, ded: 0, debt: 0 });

  const cols = [
    { label: t('full_name'), key: 'full_name', width: 26 }, { label: t('phone'), key: 'phone' }, { label: t('manager'), key: 'manager_name' }, { label: t('status'), value: (r) => t('st_' + r.status) },
    { label: t('cars_registered'), key: 'registrations' }, { label: t('active_cars'), key: 'active' }, { label: t('activity'), value: (r) => `${r.activity_pct}%` }, { label: t('bonus_rate'), key: 'bonus_weeks' },
    { label: t('days_worked'), key: 'days_worked' }, { label: t('avg_per_day'), key: 'avg' },
    { label: t('car_earnings'), key: 'base_amount' }, { label: t('incentives'), key: 'incentive_amount' }, { label: t('bonuses'), key: 'bonuses' },
    { label: t('withdrawals'), key: 'withdrawals' }, { label: t('deductions'), key: 'deductions' }, { label: t('debt_balance'), key: 'debt_balance' },
  ];
  const name = `performance-${range.from}_${range.to}`;
  async function image(kind) {
    setBusy(kind); setStage(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const png = await nodeToPng(ref.current, { pixelRatio: 2 });
      downloadBlob(kind === 'pdf' ? await pngToPdf(png) : png, `${name}.${kind}`);
    } catch (e) { toast.error(e); } finally { setStage(false); setBusy(''); }
  }

  return (
    <>
      <div className="row wrap end section" style={{ gap: 8 }}>
        <Button icon="download" disabled={!rows.length} onClick={() => downloadBlob(toCSV(rows, cols), name + '.csv')}>{t('export_csv')}</Button>
        <Button icon="download" disabled={!rows.length} onClick={async () => downloadBlob(await toXLSX(rows, cols, { sheetName: t('performance_report') }), name + '.xlsx')}>{t('export_xlsx')}</Button>
        <Button icon="file" disabled={!rows.length} loading={busy === 'pdf'} onClick={() => image('pdf')}>{t('export_pdf')}</Button>
        <Button icon="download" disabled={!rows.length} loading={busy === 'png'} onClick={() => image('png')}>{t('export_png')}</Button>
      </div>
      <div className="row wrap section" style={{ gap: 10 }}>
        <DateRange value={range} onChange={setRange} /><ManagerFilter value={manager} onChange={setManager} />
        <SearchBox value={search} onChange={setSearch} placeholder={t('search_promoters')} />
        <label className="row small muted" style={{ gap: 6 }}>{t('min_regs')}<Input type="number" min={0} value={minRegs} onChange={(e) => setMinRegs(Math.max(0, parseInt(e.target.value || '0', 10)))} style={{ width: 90 }} /></label>
      </div>
      <div className="kpi-grid section">
        <Kpi hero label={t('cars_registered')} value={tot.regs} icon="register" loading={loading && !data} foot={`${f.num(tot.act)} ${t('active_cars')}`} />
        <Kpi money label={t('car_earnings')} value={tot.base} icon="money" color="#10b981" loading={loading && !data} />
        <Kpi money label={t('incentives')} value={tot.inc} icon="gift" color="#8b5cf6" loading={loading && !data} />
        <Kpi money label={t('withdrawals')} value={tot.wd} icon="coins" color="#f59e0b" loading={loading && !data} />
        <Kpi money label={t('debt_balance')} value={tot.debt} icon="debt" color="#f43f5e" loading={loading && !data} />
      </div>
      <Card className="flush" title={t('performance_report')} sub={`${f.date(range.from)} — ${f.date(range.to)}`}>
        <DataTable rows={rows} loading={loading} error={error} onRetry={reload} onRowClick={(r) => navigate('/promoters/' + r.promoter_id)} initialSort={{ key: 'registrations', dir: 'desc' }}
          footer={rows.length ? { full_name: t('total'), registrations: f.num(tot.regs), base_amount: f.money(tot.base), incentive_amount: f.money(tot.inc), withdrawals: f.money(tot.wd), deductions: f.money(tot.ded), debt_balance: f.money(tot.debt) } : null}
          columns={[
            { key: 'full_name', label: t('full_name'), primary: true, render: (r) => <div>{r.full_name}{isAdmin && <div className="tiny faint">{r.manager_name}</div>}</div> },
            { key: 'status', label: t('status'), hideMobile: true, render: (r) => <Badge tone={STATUS_TONE[r.status]}>{t('st_' + r.status)}</Badge> },
            { key: 'registrations', label: t('cars'), num: true, render: (r) => <b>{f.num(r.registrations)}</b> },
            { key: 'active', label: t('active_cars'), num: true, render: (r) => <span className="pos">{f.num(r.active)}</span> },
            { key: 'activity_pct', label: t('activity'), num: true, render: (r) => `${f.num(r.activity_pct)}%` },
            { key: 'bonus_weeks', label: '★', num: true, hideMobile: true, render: (r) => (r.bonus_weeks ? <b style={{ color: 'var(--accent)' }}>{f.num(r.bonus_weeks)}</b> : '—') },
            { key: 'days_worked', label: t('days_worked'), num: true, render: (r) => f.num(r.days_worked) },
            { key: 'avg', label: t('avg_per_day'), num: true, hideMobile: true, render: (r) => r.avg.toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en') },
            { key: 'base_amount', label: t('car_earnings'), num: true, render: (r) => f.money(r.base_amount) },
            { key: 'incentive_amount', label: t('incentives'), num: true, render: (r) => f.money(r.incentive_amount) },
            { key: 'withdrawals', label: t('withdrawals'), num: true, hideMobile: true, render: (r) => f.money(r.withdrawals) },
            { key: 'deductions', label: t('deductions'), num: true, hideMobile: true, render: (r) => f.money(r.deductions) },
            { key: 'debt_balance', label: t('debt_balance'), num: true, render: (r) => <span className={r.debt_balance > 0 ? 'neg' : 'faint'}>{f.money(r.debt_balance)}</span> },
            { key: 'rep', label: '', sortable: false, stop: true, render: (r) => <span onClick={(e) => e.stopPropagation()}><SalesReportButton promoter={{ id: r.promoter_id, full_name: r.full_name, phone: r.phone }} size="sm" label={false} /></span> },
          ]} />
      </Card>
      {stage && <div className="statement-stage"><ReportSheet ref={ref} rows={rows} tot={tot} range={range} lang={lang} digits={lang === 'ar' ? prefs.digits : 'latn'} company={settings.company_name} /></div>}
    </>
  );
}

const ReportSheet = React.forwardRef(function ReportSheet({ rows, tot, range, lang, digits, company }, ref) {
  const t = (k) => translate(lang, k);
  const m = (n) => formatIQD(n, lang, { digits, withUnit: false });
  const n = (x) => formatNumber(x, lang, digits);
  const th = { padding: '12px 10px', fontSize: 15, color: '#475569', textAlign: 'start', borderBottom: '2px solid #0ea5e9', background: '#f0f9ff' };
  const td = { padding: '10px', fontSize: 15, borderBottom: '1px solid #e2e8f0' };
  return (
    <div ref={ref} dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ width: 1400, padding: 48, background: '#fff', color: '#0f172a', fontFamily: "'Cairo','IBM Plex Sans Arabic','Segoe UI',Tahoma,sans-serif" }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, paddingBottom: 18, borderBottom: '4px solid', borderImage: 'linear-gradient(90deg,#22d3ee,#3b82f6) 1' }}>
        <div><div style={{ fontSize: 30, fontWeight: 900 }}>{t('performance_report')}</div><div style={{ fontSize: 18, color: '#64748b' }}>{company}</div></div>
        <div style={{ fontSize: 18, color: '#334155', direction: 'ltr' }}>{range.from} → {range.to}</div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['#', 'full_name', 'manager', 'cars', 'active_cars', 'car_earnings', 'incentives', 'withdrawals', 'deductions', 'debt_balance'].map((k) => <th key={k} style={th}>{k === '#' ? '#' : t(k)}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => (
          <tr key={r.promoter_id} style={{ background: i % 2 ? '#f8fafc' : '#fff' }}>
            <td style={td}>{n(i + 1)}</td><td style={{ ...td, fontWeight: 700 }}>{r.full_name}</td><td style={td}>{r.manager_name}</td>
            <td style={{ ...td, fontWeight: 800 }}>{n(r.registrations)}</td><td style={td}>{n(r.active)} ({n(r.activity_pct)}%){r.bonus_weeks ? ' ★' : ''}</td><td style={td}>{m(r.base_amount)}</td>
            <td style={td}>{m(r.incentive_amount)}</td><td style={td}>{m(r.withdrawals)}</td><td style={td}>{m(r.deductions)}</td><td style={{ ...td, color: r.debt_balance > 0 ? '#e11d48' : undefined }}>{m(r.debt_balance)}</td>
          </tr>
        ))}</tbody>
        <tfoot><tr style={{ background: '#0f172a', color: '#fff', fontWeight: 800 }}>
          <td style={td} colSpan={3}>{t('total')} ({lang === 'ar' ? 'د.ع' : 'IQD'})</td><td style={td}>{n(tot.regs)}</td><td style={td}>{n(tot.act)}</td><td style={td}>{m(tot.base)}</td><td style={td}>{m(tot.inc)}</td><td style={td}>{m(tot.wd)}</td><td style={td}>{m(tot.ded)}</td><td style={td}>{m(tot.debt)}</td>
        </tr></tfoot>
      </table>
      <div style={{ marginTop: 20, fontSize: 14, color: '#94a3b8' }}>{t('st_generated')}: {new Date().toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-GB', { timeZone: 'Asia/Baghdad' })}</div>
    </div>
  );
});
