import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useAction } from '../app/context.js';
import { useI18n, translate } from '../lib/i18n.js';
import { Alert, Badge, Button, Card, DataTable, Field, Icon, Input, Modal, MoneyInput, PageHead, PayrollStatus, Select, Seg, Textarea, useAsync, useConfirm, useFmt, useToast, Kpi, Skeleton } from '../ui/ui.jsx';
import { ManagerFilter, WeekPicker } from '../app/shared.jsx';
import { addDays, baghdadToday, weekStartOf } from '../engine/dates.js';
import { formatIQD, formatNumber } from '../engine/money.js';
import { newKey, nodeToPng, pngToPdf, shareImage, downloadBlob, toCSV, toXLSX, openWhatsApp } from '../lib/export.js';
import { usePrefs } from '../lib/prefs.js';
import { celebrate } from '../ui/motion.jsx';

export default function Payroll({ query }) {
  const { api, isAdmin } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast();
  const today = baghdadToday();
  const [week, setWeek] = useState(query?.week ? weekStartOf(query.week) : addDays(weekStartOf(today), -7));
  const [manager, setManager] = useState(null);
  const [status, setStatus] = useState('');
  const [sel, setSel] = useState(new Set());
  const [open, setOpen] = useState(query?.open || null);
  const [paying, setPaying] = useState(null);
  const { data, loading, error, reload } = useAsync(() => api.listPayrolls({ weekStart: week, managerId: manager, status: status || null }), [api, week, manager, status]);
  const [run, busy] = useAction(toast);
  useEffect(() => setSel(new Set()), [week, manager, status]);
  const ended = addDays(week, 6) < today;

  const sum = useMemo(() => (data || []).reduce((s, r) => ({
    n: s.n + 1, regs: s.regs + r.reg_count, gross: s.gross + r.gross_amount, ded: s.ded + r.total_deductions, net: s.net + r.effective_net, paid: s.paid + r.paid_total, out: s.out + Math.max(0, r.outstanding),
  }), { n: 0, regs: 0, gross: 0, ded: 0, net: 0, paid: 0, out: 0 }), [data]);

  const generate = async () => { const r = await run(() => api.generatePayrolls(week, manager)); if (r) { toast.ok(`${t('done')} — ${f.num(r.payrolls)} ${t('employees')}`); reload(); } };
  const approve = async (ids) => { const n = await run(() => api.approvePayrolls(ids)); if (n !== undefined) { toast.ok(`${t('ps_approved')}: ${f.num(n)}`); celebrate(); setSel(new Set()); reload(); } };

  const cols = [
    { label: t('promoter'), key: 'promoter_name' }, { label: t('phone'), key: 'promoter_phone' }, { label: t('manager'), key: 'manager_name' },
    { label: t('st_period'), value: (r) => `${r.week_start} → ${r.week_end}` }, { label: t('pay_day'), key: 'pay_date' },
    { label: t('cars_registered'), key: 'reg_count' }, { label: t('active_cars'), key: 'active_count' }, { label: t('bonus_rate'), value: (r) => (r.bonus_applied ? '✓' : '') }, { label: t('car_earnings'), key: 'base_amount' }, { label: t('incentives'), key: 'incentive_amount' },
    { label: t('bonuses'), key: 'bonus_amount' }, { label: t('corrections'), key: 'correction_amount' }, { label: t('withdrawals'), key: 'withdrawal_amount' },
    { label: t('advances'), key: 'advance_amount' }, { label: t('other_deductions'), key: 'deduction_amount' }, { label: t('debt_repayments'), key: 'debt_repayment_amount' },
    { label: t('gross'), key: 'gross_amount' }, { label: t('deductions'), key: 'total_deductions' }, { label: t('net_salary'), key: 'effective_net' },
    { label: t('paid_total'), key: 'paid_total' }, { label: t('outstanding'), key: 'outstanding' }, { label: t('status'), value: (r) => t('ps_' + r.status) },
    { label: t('payment_method'), value: (r) => (r.payment_method ? t('pm_' + r.payment_method) : '') }, { label: t('payment_reference'), key: 'payment_reference' },
  ];

  return (
    <>
      <PageHead title={t('pay_title')} sub={t('pay_sub')} actions={<>
        <ManagerFilter value={manager} onChange={setManager} />
        <Button icon="download" disabled={!data?.length} onClick={() => downloadBlob(toCSV(data, cols), `payroll-${week}.csv`)}>{t('export_csv')}</Button>
        <Button icon="download" disabled={!data?.length} onClick={async () => downloadBlob(await toXLSX(data, cols, { sheetName: week }), `payroll-${week}.xlsx`)}>{t('export_xlsx')}</Button>
      </>} />
      <div className="row wrap between section" style={{ gap: 12 }}>
        <WeekPicker value={week} onChange={setWeek} />
        <div className="row wrap">
          <Seg value={status} onChange={setStatus} options={[{ value: '', label: t('all') }, ...['pending', 'approved', 'paid', 'adjusted'].map((s) => ({ value: s, label: t('ps_' + s) }))]} />
          <Button icon="refresh" loading={busy} onClick={generate}>{t('generate')}</Button>
        </div>
      </div>
      {!ended && <div className="section"><Alert tone="warn">{t('week_not_ended')}</Alert></div>}
      <div className="kpi-grid section">
        <Kpi label={t('employees')} value={sum.n} icon="users" loading={loading && !data} />
        <Kpi label={t('cars_registered')} value={sum.regs} icon="register" color="#8b5cf6" loading={loading && !data} />
        <Kpi money label={t('gross')} value={sum.gross} icon="trend" color="#10b981" loading={loading && !data} />
        <Kpi money label={t('deductions')} value={sum.ded} icon="minus" color="#f43f5e" loading={loading && !data} />
        <Kpi money hero label={t('net')} value={sum.net} icon="wallet" loading={loading && !data} />
        <Kpi money label={t('outstanding')} value={sum.out} icon="clock" color="#f59e0b" loading={loading && !data} />
      </div>
      <Card className="flush">
        <DataTable rows={data} loading={loading} error={error} onRetry={reload} onRowClick={(r) => setOpen(r.id)}
          selectable={(r) => r.status === 'pending' && ended} selected={sel} onSelect={setSel}
          footer={data?.length ? { promoter_name: `${t('total')} (${t('iqd')})`, reg_count: f.num(sum.regs), gross_amount: f.moneyPlain(sum.gross), total_deductions: f.moneyPlain(sum.ded), effective_net: f.moneyPlain(sum.net), outstanding: f.moneyPlain(sum.out) } : null}
          columns={[
            { key: 'promoter_name', label: `${t('promoter')} · ${t('iqd')}`, primary: true, render: (r) => <div>{r.promoter_name}{isAdmin && <div className="tiny faint">{r.manager_name}</div>}</div> },
            { key: 'reg_count', label: `${t('cars')} / ✓`, num: true, render: (r) => <span className="col" style={{ gap: 0, alignItems: 'flex-end' }}><span>{f.num(r.reg_count)} <span className="faint tiny">/ {f.num(r.active_count)}</span></span>{r.bonus_applied ? <span className="tiny" style={{ color: 'var(--success)' }}>★ {t('bonus_rate')}</span> : <span className="faint tiny">{f.num(r.reg_count ? Math.round((r.active_count * 100) / r.reg_count) : 0)}%</span>}</span> },
            { key: 'base_amount', label: t('car_earnings'), num: true, hideMobile: true, className: 'hide-md', render: (r) => f.moneyPlain(r.base_amount) },
            { key: 'incentive_amount', label: t('incentives'), num: true, render: (r) => (r.incentive_amount ? <span style={{ color: 'var(--accent)' }}>{f.moneyPlain(r.incentive_amount)}</span> : '—') },
            { key: 'gross_amount', label: t('gross'), num: true, hideMobile: true, className: 'hide-md', render: (r) => f.moneyPlain(r.gross_amount) },
            { key: 'total_deductions', label: t('deductions'), num: true, render: (r) => <span className="neg">{f.moneyPlain(r.total_deductions)}</span> },
            { key: 'effective_net', label: t('net'), num: true, render: (r) => <b className={r.effective_net < 0 ? 'neg' : ''}>{f.moneyPlain(r.effective_net)}</b> },
            { key: 'outstanding', label: t('outstanding'), num: true, render: (r) => <span className={r.outstanding > 0 ? 'warn' : 'faint'}>{f.moneyPlain(r.outstanding)}</span> },
            { key: 'status', label: t('status'), render: (r) => <span className="row" style={{ gap: 4 }}><PayrollStatus status={r.status} />{r.needs_recalc && <Badge tone="red" plain>!</Badge>}</span> },
            { key: 'act', label: '', sortable: false, stop: true, render: (r) => (
              <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                {['approved', 'adjusted'].includes(r.status) && r.outstanding > 0 && <Button size="sm" variant="success" icon="money" onClick={() => setPaying(r)}>{t('pay')}</Button>}
                {r.status === 'approved' && r.outstanding === 0 && <Button size="sm" variant="success" icon="check" onClick={() => setPaying(r)}>{t('ps_paid')}</Button>}
                <StatementButton payroll={r} size="sm" />
              </span>
            ) },
          ]} />
      </Card>
      {sel.size > 0 && (
        <div className="actionbar">
          <b>{f.num(sel.size)} {t('employees')}</b><span className="grow" />
          <Button variant="ghost" onClick={() => setSel(new Set())}>{t('cancel')}</Button>
          <Button variant="primary" icon="check" loading={busy} onClick={() => approve([...sel])}>{t('approve_selected')}</Button>
        </div>
      )}
      {open && <PayrollDetail id={open} onClose={() => setOpen(null)} onChanged={reload} onPay={(p) => setPaying(p)} onApprove={(id) => approve([id])} />}
      {paying && <PayModal payroll={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); reload(); setOpen((o) => o); }} />}
    </>
  );
}

function PayrollDetail({ id, onClose, onChanged, onPay, onApprove }) {
  const { api } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const { data, loading, reload } = useAsync(() => api.getPayroll(id), [api, id]);
  const [run, busy] = useAction(toast);
  const p = data?.payroll;
  const snap = p?.snapshot || {};
  const refresh = () => { reload(); onChanged(); };
  async function reopen() { const r = await confirm({ title: t('reopen'), requireReason: true }); if (r) { await run(() => api.reopenPayroll(id, r), t('done')); refresh(); } }
  async function adjust() {
    const r = await confirm({ title: t('adjust'), message: t('needs_recalc'), requireReason: true });
    if (r) { const res = await run(() => api.adjustPayroll(id, r)); if (res) { toast.ok(`${t('delta')}: ${f.money(res.delta)}`); refresh(); } }
  }
  const lines = p ? [
    ['car_earnings', p.base_amount, ''], ['incentives', p.incentive_amount, 'pos'], ['bonuses', p.bonus_amount, 'pos'], ['corrections', p.correction_amount, p.correction_amount < 0 ? 'neg' : 'pos'],
    ['withdrawals', -p.withdrawal_amount, 'neg'], ['advances', -p.advance_amount, 'neg'], ['other_deductions', -p.deduction_amount, 'neg'], ['debt_repayments', -p.debt_repayment_amount, 'neg'],
  ] : [];
  return (
    <Modal open onClose={onClose} size="wide" title={p ? `${p.promoter_name} — ${f.short(p.week_start)} / ${f.date(p.week_end)}` : t('loading')}
      footer={p && <>
        {p.status === 'pending' && <Button variant="primary" icon="check" loading={busy} onClick={() => { onApprove(id); onClose(); }} disabled={p.week_end >= baghdadToday()}>{t('approve')}</Button>}
        {p.status === 'approved' && !data.payments.length && <Button icon="refresh" onClick={reopen} loading={busy}>{t('reopen')}</Button>}
        {['paid', 'adjusted'].includes(p.status) && <Button icon="swap" onClick={adjust} loading={busy} variant={p.needs_recalc ? 'danger' : ''}>{t('adjust')}</Button>}
        {['approved', 'adjusted'].includes(p.status) && (p.outstanding > 0 || p.status === 'approved') && <Button variant="success" icon="money" onClick={() => { onPay(p); onClose(); }}>{t('pay')}</Button>}
        <StatementButton payroll={p} />
      </>}>
      {loading && !data ? <Skeleton h={300} /> : p && <>
        <div className="row wrap" style={{ gap: 8 }}><PayrollStatus status={p.status} /><Badge plain>{t('pay_day')}: {f.date(p.pay_date)}</Badge><Badge plain>{t('payroll_month')}: {f.month(p.payroll_month)}</Badge></div>
        {p.needs_recalc && <Alert tone="error">{t('needs_recalc')}</Alert>}
        {p.carry_forward_debt > 0 && <Alert tone="warn">{t('carry_forward')}: {f.money(p.carry_forward_debt)}</Alert>}
        <div className="grid g2">
          <div className="card" style={{ padding: 14 }}>
            {lines.filter(([, v]) => v !== 0).map(([k, v, cls]) => <div key={k} className="m-kv" style={{ padding: '5px 0' }}><span>{t(k)}</span><b className={`num ${cls}`}>{f.money(v)}</b></div>)}
            <hr className="divider" />
            <div className="m-kv"><span>{t('gross')}</span><b className="num">{f.money(p.gross_amount)}</b></div>
            <div className="m-kv"><span>{t('deductions')}</span><b className="num neg">{f.money(p.total_deductions)}</b></div>
            {p.adjustments_total !== 0 && <div className="m-kv"><span>{t('adjustments')}</span><b className="num">{f.money(p.adjustments_total)}</b></div>}
            <div className="m-kv" style={{ fontSize: '1.15rem', marginTop: 8 }}><span style={{ color: 'var(--text)' }}>{t('net_salary')}</span><b className="num" style={{ color: 'var(--accent)' }}>{f.money(p.effective_net)}</b></div>
            <div className="m-kv"><span>{t('paid_total')}</span><b className="num">{f.money(p.paid_total)}</b></div>
            <div className="m-kv"><span>{t('outstanding')}</span><b className="num warn">{f.money(p.outstanding)}</b></div>
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div className="row wrap" style={{ gap: 8, padding: 12 }}>
              <Badge plain>{t('cars')}: {f.num(p.reg_count)}</Badge><Badge plain tone="green">{t('active_cars')}: {f.num(p.active_count)}</Badge>
              <Badge plain>{t('activity')}: {f.num(p.reg_count ? Math.round((p.active_count * 100) / p.reg_count) : 0)}%</Badge>
              {p.bonus_applied ? <Badge tone="accent">★ {t('bonus_rate')}</Badge> : null}
            </div>
            <table className="table"><thead><tr><th>{t('date')}</th><th className="n">{t('cars')}</th><th className="n">{t('active_cars')}</th><th className="n">{t('incentive')}</th></tr></thead>
              <tbody>{(snap.days || []).map((d) => (
                <tr key={d.date}><td><span className="small">{f.weekday(d.date)}</span> <span className="faint tiny">{f.short(d.date)}</span> {d.incentive_day && <Icon name="gift" size={12} style={{ color: 'var(--accent)' }} />}</td>
                  <td className="n num">{f.num(d.count)}</td><td className="n num">{f.num(d.active ?? 0)}</td><td className="n num">{d.incentive ? f.money(d.incentive) : '—'}</td></tr>
              ))}</tbody></table>
          </div>
        </div>
        {snap.entries?.length > 0 && <Card title={t('account_ledger')} className="flush"><table className="table"><tbody>{snap.entries.map((e) => (
          <tr key={e.id}><td>{f.date(e.date)}</td><td>{t('cat_' + e.category)}</td><td className="faint small">{e.notes}</td><td className="n num">{f.money(e.amount)}</td></tr>))}</tbody></table></Card>}
        {data.payments.length > 0 && <Card title={t('payments')} className="flush"><table className="table"><tbody>{data.payments.map((x) => (
          <tr key={x.id}><td>{f.dt(x.paid_at)}</td><td>{t('pm_' + x.method)}</td><td className="num faint">{x.reference}</td><td className="n num"><b>{f.money(x.amount)}</b></td></tr>))}</tbody></table></Card>}
        {data.adjustments.length > 0 && <Card title={t('adjustments')} className="flush"><table className="table"><tbody>{data.adjustments.map((a) => (
          <tr key={a.id}><td>{f.dt(a.created_at)}</td><td className="small">{a.reason}</td><td className="n num">{f.money(a.previous_net)} → {f.money(a.new_net)}</td><td className="n num"><b className={a.delta < 0 ? 'neg' : 'pos'}>{f.money(a.delta)}</b></td></tr>))}</tbody></table></Card>}
      </>}
    </Modal>
  );
}

function PayModal({ payroll, onClose, onDone }) {
  const { api } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast();
  const [run, busy] = useAction(toast);
  const [key] = useState(newKey);
  const [v, setV] = useState({ amount: payroll.outstanding, method: 'cash', reference: '', paidAt: baghdadToday(), notes: '' });
  const zero = payroll.outstanding === 0;
  const valid = zero || (v.amount > 0 && v.amount <= payroll.outstanding);
  async function save() {
    const r = await run(() => api.payPayroll(payroll.id, { ...v, amount: zero ? null : v.amount, key }));
    if (r) { toast.ok(r.duplicate ? t('done') : `${t('ps_paid')}: ${f.money(r.paid)}`); if (!r.duplicate && r.outstanding === 0) celebrate(); onDone(); }
  }
  return (
    <Modal open onClose={onClose} title={`${t('pay')} — ${payroll.promoter_name}`}
      footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" icon="check" loading={busy} disabled={!valid} onClick={save}>{t('confirm')}</Button></>}>
      <div className="grid g3">
        <div className="card" style={{ padding: 12 }}><div className="tiny faint">{t('payable')}</div><b className="num">{f.money(payroll.effective_payable)}</b></div>
        <div className="card" style={{ padding: 12 }}><div className="tiny faint">{t('paid_total')}</div><b className="num">{f.money(payroll.paid_total)}</b></div>
        <div className="card" style={{ padding: 12 }}><div className="tiny faint">{t('outstanding')}</div><b className="num warn">{f.money(payroll.outstanding)}</b></div>
      </div>
      {!zero && <Field label={t('amount')} error={v.amount > payroll.outstanding ? t('err_OVERPAYMENT', { detail: f.money(payroll.outstanding) }) : null}>
        <MoneyInput value={v.amount} onChange={(n) => setV((s) => ({ ...s, amount: n }))} />
        <div className="row"><Button size="sm" variant="ghost" onClick={() => setV((s) => ({ ...s, amount: payroll.outstanding }))}>{t('pay_full')}</Button></div>
      </Field>}
      <div className="grid g2">
        <Field label={t('payment_method')}><Select value={v.method} onChange={(e) => setV((s) => ({ ...s, method: e.target.value }))} options={['cash', 'zain_cash', 'qi_card', 'bank_transfer', 'other'].map((m) => ({ value: m, label: t('pm_' + m) }))} /></Field>
        <Field label={t('payment_date')}><Input type="date" value={v.paidAt} max={baghdadToday()} onChange={(e) => setV((s) => ({ ...s, paidAt: e.target.value }))} /></Field>
      </div>
      <Field label={`${t('payment_reference')} (${t('optional')})`}><Input value={v.reference} onChange={(e) => setV((s) => ({ ...s, reference: e.target.value }))} dir="ltr" maxLength={80} /></Field>
      <Field label={t('notes')}><Textarea value={v.notes} onChange={(e) => setV((s) => ({ ...s, notes: e.target.value }))} maxLength={300} /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- statement image / PDF / WhatsApp
export function StatementButton({ payroll, size }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!payroll) return null;
  return <>
    <Button size={size} icon="file" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>{size === 'sm' ? '' : t('statement')}</Button>
    {open && <StatementModal payroll={payroll} onClose={() => setOpen(false)} />}
  </>;
}

function StatementModal({ payroll, onClose }) {
  const { api, settings } = useApp();
  const { t, lang } = useI18n(); const toast = useToast();
  const { prefs } = usePrefs();
  const ref = useRef(null);
  const [busy, setBusy] = useState('');
  const [h, setH] = useState(0);
  const { data } = useAsync(() => Promise.all([api.getPayroll(payroll.id), api.getPromoter(payroll.promoter_id)]), [api, payroll.id]);
  const p = data?.[0]?.payroll || payroll;
  const debt = data?.[1]?.promoter?.debt_balance;
  const fname = `statement-${p.promoter_name.replace(/\s+/g, '_')}-${p.week_start}`;

  useEffect(() => { if (!data || !ref.current) return undefined; const ro = new ResizeObserver(() => setH(ref.current?.offsetHeight || 0)); ro.observe(ref.current); return () => ro.disconnect(); }, [data]);
  async function png() { return nodeToPng(ref.current, { pixelRatio: 2 }); }
  async function act(kind) {
    if (kind === 'wa') { // open the promoter's chat inside the click gesture, then prepare the image
      const text = [t('wa_message', { name: p.promoter_name, from: p.week_start, to: p.week_end, net: formatIQD(p.effective_net, lang) }),
        `🚗 ${p.reg_count} | ✅ ${p.active_count}${p.bonus_applied ? ' ★' : ''}`, `💰 ${formatIQD(p.base_amount, lang)} + 🎁 ${formatIQD(p.incentive_amount, lang)} − ${formatIQD(p.total_deductions, lang)}`,
        `${t('outstanding')}: ${formatIQD(p.outstanding, lang)}`, `— ${settings.company_name}`].join('\n');
      openWhatsApp(data?.[1]?.promoter?.whatsapp || p.promoter_phone, text);
    }
    setBusy(kind);
    try {
      const img = await png();
      if (kind === 'png') downloadBlob(img, fname + '.png');
      if (kind === 'pdf') downloadBlob(await pngToPdf(img), fname + '.pdf');
      if (kind === 'print') { const url = URL.createObjectURL(await pngToPdf(img)); window.open(url, '_blank'); }
      if (kind === 'file') {
        const text = t('wa_message', { name: p.promoter_name, from: p.week_start, to: p.week_end, net: formatIQD(p.effective_net, lang) });
        const r = await shareImage(img, fname + '.png', text, data?.[1]?.promoter?.whatsapp || p.promoter_phone);
        toast.info(r === 'shared' ? t('share_ready') : r === 'cancelled' ? t('share_cancelled') : t('share_fallback'));
      }
      if (kind === 'wa') { downloadBlob(img, fname + '.png'); toast.info(t('wa_opened')); }
    } catch (e) { toast.error(e); } finally { setBusy(''); }
  }
  return (
    <Modal open onClose={onClose} size="wide" title={t('st_title')}
      footer={<>
        <Button icon="download" loading={busy === 'png'} disabled={!data} onClick={() => act('png')}>{t('download_png')}</Button>
        <Button icon="file" loading={busy === 'pdf'} disabled={!data} onClick={() => act('pdf')}>{t('download_pdf')}</Button>
        <Button icon="print" loading={busy === 'print'} disabled={!data} onClick={() => act('print')}>{t('print')}</Button>
        <Button icon="share" loading={busy === 'file'} disabled={!data} onClick={() => act('file')}>{t('share')}</Button>
        <Button variant="primary" icon="whatsapp" loading={busy === 'wa'} disabled={!data} onClick={() => act('wa')} style={{ background: 'linear-gradient(135deg,#25d366,#128c7e)', color: '#fff' }}>{t('send_whatsapp')}</Button>
      </>}>
      <div style={{ overflow: 'auto', maxHeight: '62dvh', borderRadius: 12, background: '#030712' }}>
        <div style={{ width: 540, height: h ? h * 0.5 : 'auto', overflow: 'hidden', margin: '0 auto' }}>
          <div style={{ transform: 'scale(.5)', transformOrigin: lang === 'ar' ? 'top right' : 'top left', width: 1080 }}>
            {data ? <StatementCard ref={ref} p={p} debt={debt} company={settings.company_name} lang={lang} digits={lang === 'ar' ? prefs.digits : 'latn'} /> : <Skeleton h={600} />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Self-contained, theme-independent card optimised for 1080px PNG export. */
export const StatementCard = React.forwardRef(function StatementCard({ p, debt, company, lang, digits = 'latn' }, ref) {
  const t = (k, v) => translate(lang, k, v);
  const m = (n) => formatIQD(n, lang, { digits });
  const n = (x) => formatNumber(x, lang, digits);
  const loc = lang === 'ar' ? `ar-IQ-u-nu-${digits}` : 'en-GB';
  const dt = (iso) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  const wd = (iso) => new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  const days = p.snapshot?.days || [];
  const statusColor = { pending: '#f59e0b', approved: '#60a5fa', paid: '#22c55e', adjusted: '#a78bfa' }[p.status];
  const row = (label, value, color) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 0', borderBottom: '1px solid rgba(148,178,255,.12)', fontSize: 24 }}>
      <span style={{ color: '#a3b3d9' }}>{label}</span><b style={{ color: color || '#e9efff', direction: 'ltr', unicodeBidi: 'plaintext' }}>{value}</b>
    </div>
  );
  return (
    <div ref={ref} dir={lang === 'ar' ? 'rtl' : 'ltr'} style={{ width: 1080, padding: 56, boxSizing: 'border-box', fontFamily: "'Cairo','IBM Plex Sans Arabic','Segoe UI',Tahoma,sans-serif", color: '#e9efff',
      background: 'radial-gradient(900px 500px at 90% -10%, rgba(34,211,238,.22), transparent 60%), radial-gradient(700px 500px at -10% 110%, rgba(59,130,246,.2), transparent 60%), linear-gradient(160deg,#071126,#0b1733 60%,#060b1a)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 36 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div style={{ width: 72, height: 72, borderRadius: 20, background: 'linear-gradient(135deg,#22d3ee,#3b82f6)', display: 'grid', placeItems: 'center', color: '#04121f', fontSize: 34, fontWeight: 900 }}>↗</div>
          <div><div style={{ fontSize: 30, fontWeight: 800 }}>{company}</div><div style={{ fontSize: 20, color: '#8fa3cf' }}>{t('st_title')}</div></div>
        </div>
        <div style={{ padding: '10px 22px', borderRadius: 999, border: `2px solid ${statusColor}`, color: statusColor, fontSize: 22, fontWeight: 800 }}>{t('ps_' + p.status)}</div>
      </div>
      <div style={{ borderRadius: 28, padding: 32, background: 'rgba(16,27,56,.75)', border: '1px solid rgba(148,178,255,.18)', marginBottom: 28 }}>
        <div style={{ fontSize: 40, fontWeight: 900, marginBottom: 6 }}>{p.promoter_name}</div>
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', fontSize: 21, color: '#a3b3d9' }}>
          <span>{t('manager')}: <b style={{ color: '#e9efff' }}>{p.manager_name}</b></span>
          <span>{t('st_period')}: <b style={{ color: '#e9efff' }}>{wd(p.week_start)} {dt(p.week_start)} — {wd(p.week_end)} {dt(p.week_end)}</b></span>
          <span>{t('pay_day')}: <b style={{ color: '#e9efff' }}>{wd(p.pay_date)} {dt(p.pay_date)}</b></span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 10, marginBottom: 28 }}>
        {days.map((d) => (
          <div key={d.date} style={{ borderRadius: 18, padding: '14px 8px', textAlign: 'center', background: d.incentive_day ? 'linear-gradient(160deg,rgba(34,211,238,.25),rgba(16,27,56,.8))' : 'rgba(16,27,56,.7)', border: `1px solid ${d.incentive_day ? 'rgba(34,211,238,.5)' : 'rgba(148,178,255,.14)'}` }}>
            <div style={{ fontSize: 18, color: '#8fa3cf' }}>{wd(d.date)}</div>
            <div style={{ fontSize: 34, fontWeight: 900, margin: '4px 0' }}>{n(d.count)}</div>
            <div style={{ fontSize: 15, color: '#22c55e' }}>{n(d.active ?? 0)} ✓</div>
            <div style={{ fontSize: 14, color: d.incentive ? '#22d3ee' : '#5b6b92' }}>{d.incentive ? '+' + n(d.incentive) : '—'}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
        <div>
          {row(t('cars_registered'), n(p.reg_count))}
          {row(t('active_cars'), `${n(p.active_count)} (${n(p.reg_count ? Math.round((p.active_count * 100) / p.reg_count) : 0)}%)`, '#22c55e')}
          {row(t('car_earnings') + (p.bonus_applied ? ' ★' : ''), m(p.base_amount), p.bonus_applied ? '#22d3ee' : undefined)}
          {row(t('incentives'), m(p.incentive_amount), '#22d3ee')}
          {p.bonus_amount ? row(t('bonuses'), m(p.bonus_amount), '#22c55e') : null}
          {p.correction_amount ? row(t('corrections'), m(p.correction_amount), p.correction_amount < 0 ? '#f43f5e' : '#22c55e') : null}
          {row(t('gross'), m(p.gross_amount))}
        </div>
        <div>
          {row(t('withdrawals'), m(p.withdrawal_amount + p.advance_amount), '#f59e0b')}
          {row(t('other_deductions'), m(p.deduction_amount), '#f43f5e')}
          {row(t('debt_repayments'), m(p.debt_repayment_amount), '#f43f5e')}
          {p.adjustments_total ? row(t('adjustments'), m(p.adjustments_total), '#a78bfa') : null}
          {row(t('debt_balance'), m(debt ?? 0), '#fb923c')}
          {row(t('paid_total'), m(p.paid_total))}
        </div>
      </div>
      <div style={{ marginTop: 30, borderRadius: 28, padding: '28px 34px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'linear-gradient(135deg,#22d3ee,#3b82f6)', color: '#03101d' }}>
        <div><div style={{ fontSize: 24, fontWeight: 700, opacity: 0.8 }}>{t('net_salary')}</div>{p.outstanding > 0 && <div style={{ fontSize: 19, fontWeight: 700, opacity: 0.75 }}>{t('outstanding')}: {m(p.outstanding)}</div>}</div>
        <div style={{ fontSize: 56, fontWeight: 900, direction: 'ltr', unicodeBidi: 'plaintext' }}>{m(p.effective_net)}</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 26, fontSize: 17, color: '#6f7fa6' }}>
        <span>{t('st_footer')}</span><span style={{ direction: 'ltr' }}>{t('st_generated')}: {new Date().toLocaleString(loc, { timeZone: 'Asia/Baghdad', dateStyle: 'medium', timeStyle: 'short' })}</span>
      </div>
    </div>
  );
});
