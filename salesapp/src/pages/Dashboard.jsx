import React, { useState } from 'react';
import { useApp, navigate } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { usePrefs } from '../lib/prefs.js';
import { Card, Kpi, PageHead, useAsync, useFmt, ErrorState, Skeleton, Empty, Button, Badge } from '../ui/ui.jsx';
import { Ring } from '../ui/motion.jsx';
import { AreaChart, BarList, Donut, PALETTE } from '../ui/charts.jsx';
import { DateRange, ManagerFilter } from '../app/shared.jsx';
import { rangePreset, addDays } from '../engine/dates.js';

export default function Dashboard() {
  const { api, isAdmin, categories, me } = useApp();
  const { t, lang } = useI18n();
  const { prefs } = usePrefs();
  const f = useFmt();
  const [range, setRange] = useState(() => rangePreset('last_30'));
  const [manager, setManager] = useState(null);
  const [metric, setMetric] = useState('cars');
  const pct = (a, b) => (b ? Math.round((a * 100) / b) : 0);
  const { data, loading, error, reload } = useAsync(() => api.getDashboard(range.from, range.to, manager), [api, range.from, range.to, manager]);
  const k = data?.kpis || {};
  const catName = (key) => { const c = categories.find((x) => x.key === key); return c ? (lang === 'ar' ? c.name_ar : c.name_en) : key; };

  const widgets = {
    kpis_regs: (
      <div className="kpi-grid section" key="kpis_regs">
        <Kpi hero label={t('kpi_today')} value={k.today} icon="register" loading={loading && !data} foot={`${f.num(k.today_active || 0)} ${t('active_cars')}`} />
        <Kpi label={t('kpi_24h')} value={k.last_24h} icon="clock" color="#60a5fa" loading={loading && !data} />
        <Kpi label={t('kpi_week')} value={k.this_week} icon="calendar" color="#8b5cf6" loading={loading && !data} foot={`${f.num(k.this_week_active || 0)} ✓ · ${f.num(pct(k.this_week_active, k.this_week))}%`} />
        <Kpi label={t('kpi_month')} value={k.this_month} icon="trend" color="#10b981" loading={loading && !data} />
        <Kpi label={t('kpi_active_promoters')} value={k.active_promoters} icon="users" color="#f59e0b" loading={loading && !data} />
      </div>
    ),
    kpis_money: (
      <div className="kpi-grid four section" key="kpis_money">
        <Kpi money label={t('car_earnings')} value={k.range_revenue} icon="money" foot={`${f.num(k.range_registrations || 0)} ${t('cars')} · ${f.num(k.range_active || 0)} ✓ · ★ ${f.num(k.bonus_weeks || 0)}`} loading={loading && !data} />
        <Kpi money label={t('kpi_incentives')} value={k.range_incentives} icon="gift" color="#8b5cf6" loading={loading && !data} />
        <Kpi money label={t('kpi_liabilities')} value={k.payroll_liabilities} icon="wallet" color="#f59e0b" loading={loading && !data} />
        <Kpi money label={t('kpi_paid')} value={k.paid_salaries} icon="check" color="#10b981" loading={loading && !data} />
        <Kpi money label={t('kpi_unpaid')} value={k.unpaid_salaries} icon="clock" color="#f43f5e" loading={loading && !data} />
        <Kpi money label={t('kpi_debts')} value={k.outstanding_debts} icon="debt" color="#f97316" loading={loading && !data} />
        <Kpi money label={t('kpi_withdrawals')} value={k.withdrawals} icon="coins" color="#60a5fa" loading={loading && !data} />
        <Kpi money label={t('kpi_expenses')} value={k.expenses} icon="receipt" color="#14b8a6" loading={loading && !data} />
      </div>
    ),
    chart: (
      <Card key="chart" className="section" glass title={metric === 'earnings' ? t('car_earnings') : t('chart_daily')} sub={`${f.date(range.from)} — ${f.date(range.to)}`}
        actions={<div className="row" style={{ gap: 10 }}>{data && <Ring value={pct(k.range_active, k.range_registrations)} size={46} stroke={5} />}<div className="seg">{[['cars', 'cars'], ['earnings', 'car_earnings']].map(([m, l]) => <button key={m} className={metric === m ? 'on accent' : ''} onClick={() => setMetric(m)}>{t(l)}</button>)}</div></div>}>
        {loading && !data ? <Skeleton h={240} /> : data?.series?.length ? (
          metric === 'cars'
            ? <><AreaChart data={data.series} series={[{ key: 'registrations', label: t('cars_registered'), color: 'var(--accent)' }, { key: 'active', label: t('active_cars'), color: '#10b981' }]} />
                <div className="legend" style={{ marginTop: 8 }}><span><i style={{ background: 'var(--accent)' }} />{t('cars_registered')}</span><span><i style={{ background: '#10b981' }} />{t('active_cars')}</span></div></>
            : (data.weeks?.length ? <BarList money items={data.weeks.map((w) => ({ id: w.week_start, label: `${f.short(w.week_start)} – ${f.short(addDays(w.week_start, 6))}`, value: w.earnings + w.incentives }))} sub={(i) => { const w = data.weeks.find((x) => x.week_start === i.id); return `${f.num(w.cars)} ${t('cars')} · ${f.num(w.active)} ✓`; }} /> : <Empty />)
        ) : <Empty />}
      </Card>
    ),
    managers: isAdmin && (
      <Card key="managers" className="section" title={t('managers_perf')} icon="shield">
        {loading && !data ? <Skeleton h={160} /> : data?.managers?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('rank')}</th><th>{t('manager')}</th><th className="n">{t('cars')}</th><th className="n">{t('activity')}</th><th className="n">{t('revenue')}</th><th className="n hide-mobile">{t('promoters_count')}</th><th className="n hide-mobile">{t('kpi_expenses')}</th><th className="hide-mobile" style={{ width: '28%' }} /></tr></thead>
              <tbody>{data.managers.map((m, i) => {
                const max = Math.max(1, ...data.managers.map((x) => x.registrations));
                return (
                  <tr key={m.manager_id} className="clickable" onClick={() => setManager(m.manager_id)}>
                    <td><span className={`rank r${i + 1}`}>{f.num(i + 1)}</span></td><td className="primary-cell">{m.manager_name}</td>
                    <td className="n num">{f.num(m.registrations)}</td><td className="n num">{f.num(pct(m.active, m.registrations))}%</td><td className="n num">{f.money(m.revenue)}</td>
                    <td className="n num hide-mobile">{f.num(m.promoters)}</td><td className="n num hide-mobile">{f.money(m.expenses)}</td>
                    <td className="hide-mobile"><div className="bar-track"><div className="bar-fill" style={{ width: `${(m.registrations / max) * 100}%` }} /></div></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        ) : <Empty />}
      </Card>
    ),
    top: (
      <Card key="top" className="section" title={t('top_promoters')} icon="star">
        {loading && !data ? <Skeleton h={200} /> : data?.top_promoters?.length ? (
          <div>{data.top_promoters.map((p, i) => (
            <div key={p.promoter_id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => navigate('/promoters/' + p.promoter_id)}>
              <span className={`rank r${i + 1}`}>{f.num(i + 1)}</span>
              <div className="grow" style={{ minWidth: 0 }}><b className="small ellipsis" style={{ display: 'block' }}>{p.full_name}</b><span className="tiny faint">{isAdmin ? p.manager_name + ' · ' : ''}{f.num(p.active)} ✓ · {f.num(pct(p.active, p.registrations))}%</span></div>
              <div style={{ textAlign: 'end' }}><b className="num">{f.num(p.registrations)}</b><div className="tiny faint num">{f.money(p.revenue)}</div></div>
            </div>
          ))}</div>
        ) : <Empty />}
      </Card>
    ),
    expenses: (
      <Card key="expenses" className="section" title={t('expenses_breakdown')} icon="receipt">
        {loading && !data ? <Skeleton h={180} /> : data?.expenses_by_category?.length ? (
          <Donut items={data.expenses_by_category.map((e, i) => ({ label: catName(e.category), value: e.amount, color: PALETTE[i % PALETTE.length] }))} centerLabel={t('total')} />
        ) : <Empty icon="receipt" />}
      </Card>
    ),
  };

  const order = prefs.widgets.filter((w) => w.visible && widgets[w.id]).map((w) => w.id);
  // pair the two narrow widgets side by side when adjacent
  const blocks = [];
  for (let i = 0; i < order.length; i++) {
    const a = order[i], b = order[i + 1];
    if (['top', 'expenses'].includes(a) && ['top', 'expenses'].includes(b)) { blocks.push(<div key={a + b} className="grid g2">{widgets[a]}{widgets[b]}</div>); i++; }
    else blocks.push(widgets[a]);
  }

  return (
    <>
      <PageHead title={t('dash_title')} sub={t('dash_sub')}
        actions={<><ManagerFilter value={manager} onChange={setManager} /><DateRange value={range} onChange={setRange} /><Button icon="refresh" onClick={reload} loading={loading && !!data} aria-label={t('refresh')} /></>} />
      {error ? <ErrorState error={error} onRetry={reload} /> : blocks}
    </>
  );
}
