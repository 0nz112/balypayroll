import React, { useMemo, useState } from 'react';
import { useApp, useAction, navigate } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { Badge, Button, Card, DataTable, Field, Input, Modal, PageHead, Select, Textarea, useAsync, useFmt, useToast, useConfirm, Tabs, STATUS_TONE, ErrorState, Skeleton, Kpi, PayrollStatus, Empty, Icon } from '../ui/ui.jsx';
import { ManagerFilter, SearchBox } from '../app/shared.jsx';
import { LedgerEntryForm, CATEGORY_TONE } from './Ledger.jsx';
import { StatementButton } from './Payroll.jsx';
import { SalesReportButton } from './SalesReport.jsx';
import { baghdadToday, weekStartOf, diffDays } from '../engine/dates.js';
import { toCSV, toXLSX, downloadBlob } from '../lib/export.js';

export function PromotersList() {
  const { api, isAdmin } = useApp();
  const { t } = useI18n(); const f = useFmt();
  const [search, setSearch] = useState('');
  const [manager, setManager] = useState(null);
  const [status, setStatus] = useState('');
  const [balance, setBalance] = useState('');
  const [edit, setEdit] = useState(null);
  const { data, loading, error, reload } = useAsync(() => api.listPromoters({ search, managerId: manager, status: status || null, balance: balance || null }), [api, search, manager, status, balance]);

  const columns = [
    { key: 'full_name', label: t('full_name'), primary: true, render: (r) => <div><div>{r.full_name}</div><div className="tiny faint num only-mobile">{r.phone}</div></div> },
    { key: 'phone', label: t('phone'), render: (r) => <span className="num faint">{r.phone}</span>, hideMobile: true },
    ...(isAdmin ? [{ key: 'manager_name', label: t('manager') }] : []),
    { key: 'status', label: t('status'), render: (r) => <Badge tone={STATUS_TONE[r.status]}>{t('st_' + r.status)}</Badge> },
    { key: 'lifetime_registrations', label: t('lifetime_regs'), num: true, render: (r) => f.num(r.lifetime_registrations) },
    { key: 'debt_balance', label: t('debt_balance'), num: true, render: (r) => <span className={r.debt_balance > 0 ? 'neg' : 'faint'}>{f.money(r.debt_balance)}</span> },
    { key: 'unpaid_salary', label: t('unpaid_salary'), num: true, render: (r) => <span className={r.unpaid_salary > 0 ? 'warn' : 'faint'}>{f.money(r.unpaid_salary)}</span> },
    { key: 'last_registration_date', label: t('last_registration'), render: (r) => <span className="faint">{f.date(r.last_registration_date)}</span>, hideMobile: true },
  ];
  const exportCols = [
    { label: t('full_name'), key: 'full_name' }, { label: t('phone'), key: 'phone' }, { label: t('manager'), key: 'manager_name' },
    { label: t('status'), value: (r) => t('st_' + r.status) }, { label: t('start_date'), key: 'start_date' }, { label: t('lifetime_regs'), key: 'lifetime_registrations' },
    { label: t('opening_debt'), key: 'opening_debt' }, { label: t('new_debt'), key: 'new_debt' }, { label: t('debt_repaid'), key: 'debt_repaid' },
    { label: t('debt_balance'), key: 'debt_balance' }, { label: t('withdrawals_total'), key: 'withdrawals_total' }, { label: t('unpaid_salary'), key: 'unpaid_salary' },
  ];
  return (
    <>
      <PageHead title={t('promoters_title')} sub={data ? `${f.num(data.length)} ${t('employees')}` : ''}
        actions={<>
          <Button icon="download" onClick={() => downloadBlob(toCSV(data || [], exportCols), 'promoters.csv')} disabled={!data?.length}>{t('export_csv')}</Button>
          <Button icon="download" onClick={async () => downloadBlob(await toXLSX(data || [], exportCols, { sheetName: t('promoters_title') }), 'promoters.xlsx')} disabled={!data?.length}>{t('export_xlsx')}</Button>
          <Button variant="primary" icon="plus" onClick={() => setEdit({})}>{t('add_promoter')}</Button>
        </>} />
      <Card className="flush">
        <div className="row wrap" style={{ padding: 'var(--pad)', gap: 10 }}>
          <SearchBox value={search} onChange={setSearch} placeholder={t('search_promoters')} />
          <ManagerFilter value={manager} onChange={setManager} />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={`${t('status')}: ${t('all')}`} style={{ width: 160 }}
            options={['active', 'inactive', 'terminated'].map((s) => ({ value: s, label: t('st_' + s) }))} />
          <Select value={balance} onChange={(e) => setBalance(e.target.value)} placeholder={`${t('balance_filter')}: ${t('all')}`} style={{ width: 180 }}
            options={[{ value: 'debt', label: t('has_debt') }, { value: 'no_debt', label: t('no_debt') }, { value: 'unpaid', label: t('has_unpaid') }]} />
        </div>
        <DataTable columns={columns} rows={data} loading={loading} error={error} onRetry={reload} onRowClick={(r) => navigate('/promoters/' + r.id)}
          empty={<Empty icon="users" action={<Button variant="primary" icon="plus" onClick={() => setEdit({})}>{t('add_promoter')}</Button>} />} />
      </Card>
      {edit && <PromoterForm initial={edit} onClose={() => setEdit(null)} onSaved={(p) => { setEdit(null); reload(); if (!edit.id) navigate('/promoters/' + p.id); }} />}
    </>
  );
}

export function PromoterForm({ initial, onClose, onSaved }) {
  const { api, isAdmin, managers } = useApp();
  const { t } = useI18n(); const toast = useToast();
  const [run, busy] = useAction(toast);
  const [v, setV] = useState({ status: 'active', start_date: baghdadToday(), ...initial });
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));
  const valid = v.full_name?.trim().length >= 2 && /^\+?[0-9\s-]{7,18}$/.test(v.phone || '') && v.start_date && (!isAdmin || v.manager_id);
  async function save() {
    const p = await run(() => api.upsertPromoter({ id: v.id, full_name: v.full_name, phone: v.phone, whatsapp: v.whatsapp || null, birth_date: v.birth_date || null, start_date: v.start_date, status: v.status, notes: v.notes, manager_id: v.manager_id }), t('saved'));
    if (p) onSaved(p);
  }
  return (
    <Modal open onClose={onClose} title={v.id ? t('edit_promoter') : t('add_promoter')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" onClick={save} loading={busy} disabled={!valid}>{t('save')}</Button></>}>
      <Field label={t('full_name')}><Input value={v.full_name || ''} onChange={set('full_name')} autoFocus maxLength={120} /></Field>
      <div className="grid g2">
        <Field label={t('phone')} hint="07XXXXXXXXX"><Input value={v.phone || ''} onChange={set('phone')} inputMode="tel" dir="ltr" maxLength={18} /></Field>
        <Field label={`${t('whatsapp')} (${t('optional')})`} hint={t('whatsapp_hint')}><Input value={v.whatsapp || ''} onChange={set('whatsapp')} inputMode="tel" dir="ltr" maxLength={18} placeholder="+9647…" /></Field>
        <Field label={t('employment_status')}><Select value={v.status} onChange={set('status')} options={['active', 'inactive', 'terminated'].map((s) => ({ value: s, label: t('st_' + s) }))} /></Field>
        <Field label={t('start_date')}><Input type="date" value={v.start_date || ''} onChange={set('start_date')} /></Field>
        <Field label={`${t('birth_date')} (${t('optional')})`}><Input type="date" value={v.birth_date || ''} onChange={set('birth_date')} max={v.start_date} /></Field>
      </div>
      {isAdmin && !v.id && <Field label={t('manager')}><Select value={v.manager_id || ''} onChange={set('manager_id')} placeholder={t('select_manager')} options={managers.filter((m) => m.status === 'active').map((m) => ({ value: m.id, label: m.full_name }))} /></Field>}
      <Field label={t('notes')}><Textarea value={v.notes || ''} onChange={set('notes')} maxLength={1000} /></Field>
    </Modal>
  );
}

export function PromoterDetail({ id }) {
  const { api, isAdmin, managers } = useApp();
  const { t, lang } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const [tab, setTab] = useState('registrations');
  const [edit, setEdit] = useState(false);
  const [entry, setEntry] = useState(false);
  const [moveTo, setMoveTo] = useState(null);
  const { data, loading, error, reload } = useAsync(() => api.getPromoter(id), [api, id]);
  const [run, busy] = useAction(toast);
  const today = baghdadToday();

  const stats = useMemo(() => {
    if (!data) return {};
    const ws = weekStartOf(today); const ms = today.slice(0, 8) + '01';
    const sum = (fn) => data.registrations.filter(fn).reduce((s, r) => s + r.reg_count, 0);
    return { week: sum((r) => r.work_date >= ws), month: sum((r) => r.work_date >= ms) };
  }, [data, today]);

  const ledgerRows = useMemo(() => {
    if (!data) return [];
    // running debt balance (old debt + new debt − repayments), chronological
    const chron = [...data.ledger].sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at));
    let bal = 0; const map = new Map();
    for (const e of chron) { if (e.status === 'approved') { if (['opening_debt', 'debt'].includes(e.category)) bal += e.amount; if (e.category === 'debt_repayment') bal -= e.amount; } map.set(e.id, bal); }
    return data.ledger.map((e) => ({ ...e, running: map.get(e.id) }));
  }, [data]);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <div className="grid"><Skeleton h={140} /><Skeleton h={320} /></div>;
  const p = data.promoter;
  const age = p.birth_date ? Math.floor(diffDays(today, p.birth_date) / 365.25) : null;

  async function archive() {
    const reason = await confirm({ title: t('archive'), message: t('archive_hint'), requireReason: true, danger: true });
    if (reason && await run(() => api.archivePromoter(id, reason), t('done')) !== undefined) navigate('/promoters');
  }
  async function reassign() {
    const reason = await confirm({ title: t('reassign'), requireReason: true });
    if (reason && moveTo) { await run(() => api.reassignPromoters(moveTo, [id], reason), t('done')); setMoveTo(null); reload(); }
  }

  return (
    <>
      <div className="row" style={{ marginBottom: 10 }}><Button variant="ghost" size="sm" icon={lang === 'ar' ? 'chevR' : 'chevL'} onClick={() => navigate('/promoters')}>{t('back')}</Button></div>
      <Card glass className="section">
        <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
          <div className="avatar" style={{ width: 64, height: 64, fontSize: '1.3rem', background: 'var(--grad)', color: '#04121f' }}>{p.full_name.split(' ').slice(0, 2).map((w) => w[0]).join('')}</div>
          <div className="grow">
            <div className="row wrap"><h1 className="page-title" style={{ fontSize: '1.4rem' }}>{p.full_name}</h1><Badge tone={STATUS_TONE[p.status]}>{t('st_' + p.status)}</Badge></div>
            <div className="row wrap muted small" style={{ gap: 16, marginTop: 6 }}>
              <span className="num"><Icon name="info" size={14} /> {p.phone}</span>
              {p.whatsapp && <span className="num" style={{ color: '#25d366' }}><Icon name="whatsapp" size={14} /> {p.whatsapp}</span>}
              <span><Icon name="shield" size={14} /> {p.manager_name}</span>
              <span><Icon name="calendar" size={14} /> {t('start_date')}: {f.date(p.start_date)} · {t('tenure')} {f.num(diffDays(today, p.start_date))} {t('day_unit')}</span>
              {age != null && <span>{t('age')}: {f.num(age)} {t('years')}</span>}
            </div>
            {p.notes && <div className="small faint" style={{ marginTop: 6 }}>{p.notes}</div>}
          </div>
          <div className="row wrap">
            <SalesReportButton promoter={p} />
            <Button icon="edit" onClick={() => setEdit(true)}>{t('edit')}</Button>
            <Button variant="primary" icon="plus" onClick={() => setEntry(true)}>{t('add_entry')}</Button>
            <Button icon="register" onClick={() => navigate('/registrations')}>{t('nav_registrations')}</Button>
            <Button variant="ghost" icon="x" onClick={archive}>{t('archive')}</Button>
          </div>
        </div>
        {isAdmin && (
          <div className="row wrap" style={{ marginTop: 14, gap: 8 }}>
            <span className="small muted">{t('reassign')}:</span>
            <Select value={moveTo || ''} onChange={(e) => setMoveTo(e.target.value || null)} placeholder={t('select_manager')} style={{ width: 200 }}
              options={managers.filter((m) => m.id !== p.manager_id && m.status === 'active').map((m) => ({ value: m.id, label: m.full_name }))} />
            <Button size="sm" icon="swap" disabled={!moveTo} loading={busy} onClick={reassign}>{t('confirm')}</Button>
          </div>
        )}
      </Card>

      <div className="kpi-grid section">
        <Kpi label={t('lifetime_regs')} value={p.lifetime_registrations} icon="register" hero foot={`${f.num(p.lifetime_active ?? 0)} ${t('active_cars')}`} />
        <Kpi label={t('weekly_total')} value={stats.week} icon="calendar" color="#8b5cf6" />
        <Kpi label={t('monthly_total')} value={stats.month} icon="trend" color="#10b981" />
        <Kpi money label={t('debt_balance')} value={p.debt_balance} icon="debt" color="#f43f5e" foot={`${t('opening_debt')} ${f.money(p.opening_debt)} · ${t('new_debt')} ${f.money(p.new_debt)} · ${t('debt_repaid')} ${f.money(p.debt_repaid)}`} />
        <Kpi money label={t('withdrawals_total')} value={p.withdrawals_total + p.advances_total} icon="coins" color="#60a5fa" />
        <Kpi money label={t('unpaid_salary')} value={p.unpaid_salary} icon="wallet" color="#f59e0b" />
      </div>

      <Card>
        <Tabs value={tab} onChange={setTab} items={[
          { value: 'registrations', label: t('registrations'), count: data.registrations.filter((r) => r.reg_count > 0).length },
          { value: 'ledger', label: t('account_ledger'), count: data.ledger.length },
          { value: 'payrolls', label: t('nav_payroll'), count: data.payrolls.length },
          { value: 'payments', label: t('payment_history'), count: data.payments.length },
          { value: 'history', label: t('reg_history'), count: data.history.length },
        ]} />
        {tab === 'registrations' && <DataTable rows={data.registrations.filter((r) => r.reg_count > 0)} initialSort={{ key: 'work_date', dir: 'desc' }} columns={[
          { key: 'work_date', label: t('date'), primary: true, render: (r) => <span>{f.date(r.work_date)} <span className="faint tiny">{f.weekday(r.work_date)}</span></span> },
          { key: 'reg_count', label: t('cars_registered'), num: true, render: (r) => <b>{f.num(r.reg_count)}</b> },
          { key: 'active_count', label: t('active_cars'), num: true, render: (r) => <span className="pos">{f.num(r.active_count ?? 0)}</span> },
          { key: 'pct', label: t('activity'), num: true, sortValue: (r) => (r.reg_count ? r.active_count / r.reg_count : 0), render: (r) => `${f.num(r.reg_count ? Math.round(((r.active_count ?? 0) * 100) / r.reg_count) : 0)}%` },
          { key: 'version', label: t('version'), render: (r) => (r.version > 1 ? <Badge tone="amber">v{r.version}</Badge> : <span className="faint">v1</span>) },
        ]} />}
        {tab === 'ledger' && <>
          <div className="hint" style={{ marginBottom: 10 }}>{t('debt_note')}</div>
          <DataTable rows={ledgerRows} columns={[
            { key: 'entry_date', label: t('date'), primary: true, render: (r) => f.date(r.entry_date) },
            { key: 'category', label: t('category'), render: (r) => <Badge tone={CATEGORY_TONE[r.category]} plain>{t('cat_' + r.category)}</Badge> },
            { key: 'amount', label: t('amount'), num: true, render: (r) => <b className={r.status !== 'approved' ? 'faint' : ''} style={{ textDecoration: ['void', 'rejected'].includes(r.status) ? 'line-through' : undefined }}>{f.money(r.amount)}</b> },
            { key: 'status', label: t('status'), render: (r) => <Badge tone={r.status === 'approved' ? 'green' : r.status === 'pending' ? 'amber' : 'red'}>{t('as_' + r.status)}</Badge> },
            { key: 'running', label: t('debt_balance'), num: true, sortable: false, render: (r) => <span className="faint">{f.money(r.running)}</span> },
            { key: 'notes', label: t('notes'), render: (r) => <span className="small faint ellipsis" style={{ maxWidth: 260, display: 'inline-block' }}>{r.notes || (r.payroll_id ? t('linked_payroll') : '')}</span> },
          ]} />
        </>}
        {tab === 'payrolls' && <DataTable rows={data.payrolls} columns={[
          { key: 'week_start', label: t('week'), primary: true, render: (r) => <span className="num">{f.short(r.week_start)} – {f.date(r.week_end)}</span> },
          { key: 'reg_count', label: t('cars'), num: true, render: (r) => <span>{f.num(r.reg_count)} <span className="tiny faint">/ {f.num(r.active_count)} ✓</span>{r.bonus_applied ? ' ★' : ''}</span> },
          { key: 'gross_amount', label: t('gross'), num: true, render: (r) => f.money(r.gross_amount) },
          { key: 'total_deductions', label: t('deductions'), num: true, render: (r) => f.money(r.total_deductions) },
          { key: 'effective_net', label: t('net'), num: true, render: (r) => <b>{f.money(r.effective_net)}</b> },
          { key: 'outstanding', label: t('outstanding'), num: true, render: (r) => <span className={r.outstanding > 0 ? 'warn' : 'faint'}>{f.money(r.outstanding)}</span> },
          { key: 'status', label: t('status'), render: (r) => <PayrollStatus status={r.status} /> },
          { key: 'x', label: '', sortable: false, stop: true, render: (r) => <span onClick={(e) => e.stopPropagation()}><StatementButton payroll={r} size="sm" /></span> },
        ]} onRowClick={(r) => navigate(`/payroll?week=${r.week_start}&open=${r.id}`)} />}
        {tab === 'payments' && <DataTable rows={data.payments} columns={[
          { key: 'paid_at', label: t('payment_date'), primary: true, render: (r) => f.dt(r.paid_at) },
          { key: 'amount', label: t('amount'), num: true, render: (r) => <b>{f.money(r.amount)}</b> },
          { key: 'method', label: t('payment_method'), render: (r) => t('pm_' + r.method) },
          { key: 'reference', label: t('payment_reference'), render: (r) => <span className="num faint">{r.reference || '—'}</span> },
          { key: 'notes', label: t('notes'), render: (r) => <span className="faint small">{r.notes || ''}</span> },
        ]} />}
        {tab === 'history' && <DataTable rows={data.history} columns={[
          { key: 'changed_at', label: t('date'), primary: true, render: (r) => f.dt(r.changed_at) },
          { key: 'work_date', label: t('reg_date'), render: (r) => f.date(r.work_date) },
          { key: 'old_count', label: t('old_value'), num: true, render: (r) => (r.old_count == null ? '—' : `${f.num(r.old_count)} / ${f.num(r.old_active ?? 0)} ✓`) },
          { key: 'new_count', label: t('new_value'), num: true, render: (r) => <b>{f.num(r.new_count)} / {f.num(r.new_active ?? 0)} ✓</b> },
          { key: 'reason', label: t('reason'), render: (r) => <span className="small">{r.reason || '—'}</span> },
        ]} />}
      </Card>
      {edit && <PromoterForm initial={p} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); reload(); }} />}
      {entry && <LedgerEntryForm promoterId={id} onClose={() => setEntry(false)} onSaved={() => { setEntry(false); reload(); }} />}
    </>
  );
}
