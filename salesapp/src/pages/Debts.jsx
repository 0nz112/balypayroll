import React, { useMemo, useState } from 'react';
import { useApp, useAction, navigate } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { Badge, Button, Card, DataTable, Kpi, PageHead, Select, Switch, Tabs, useAsync, useConfirm, useFmt, useToast } from '../ui/ui.jsx';
import { DateRange, ManagerFilter, PromoterPicker, SearchBox } from '../app/shared.jsx';
import { LedgerEntryForm, CATEGORY_TONE } from './Ledger.jsx';
import { rangePreset } from '../engine/dates.js';
import { toCSV, toXLSX, downloadBlob } from '../lib/export.js';

const DEBT_CATS = ['debt', 'opening_debt', 'debt_repayment'];

export default function Debts() {
  const { api } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const [tab, setTab] = useState('balances');
  const [manager, setManager] = useState(null);
  const [search, setSearch] = useState('');
  const [onlyDebtors, setOnlyDebtors] = useState(true);
  const [range, setRange] = useState(() => rangePreset('last_30'));
  const [promoter, setPromoter] = useState(null);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('approved');
  const [form, setForm] = useState(null); // { promoterId, category }
  const balances = useAsync(() => api.listPromoters({ search, managerId: manager }), [api, search, manager]);
  const entries = useAsync(() => api.listDebtEntries({ managerId: manager, promoterId: promoter, from: range.from, to: range.to, status: status || null }), [api, manager, promoter, range.from, range.to, status]);
  const [run] = useAction(toast);

  const rows = useMemo(() => (balances.data || []).filter((p) => !onlyDebtors || p.debt_balance > 0), [balances.data, onlyDebtors]);
  const ent = useMemo(() => (entries.data || []).filter((e) => !type || e.category === type), [entries.data, type]);
  const all = balances.data || [];
  const tot = { debt: all.reduce((s, p) => s + Math.max(0, p.debt_balance), 0), debtors: all.filter((p) => p.debt_balance > 0).length,
    repaid: all.reduce((s, p) => s + p.debt_repaid, 0), opening: all.reduce((s, p) => s + p.opening_debt, 0) };
  const reload = () => { balances.reload(); entries.reload(); };

  async function remove(e) {
    const reason = await confirm({ title: t('delete_entry'), requireReason: true, danger: true, message: `${e.promoter_name} · ${t('cat_' + e.category)} · ${f.money(e.amount)}` });
    if (reason && await run(() => api.voidLedgerEntry(e.id, reason), t('done')) !== undefined) reload();
  }
  const cols = [{ label: t('full_name'), key: 'full_name' }, { label: t('phone'), key: 'phone' }, { label: t('manager'), key: 'manager_name' },
    { label: t('opening_debt'), key: 'opening_debt' }, { label: t('new_debt'), key: 'new_debt' }, { label: t('debt_repaid'), key: 'debt_repaid' }, { label: t('debt_balance'), key: 'debt_balance' }];

  return (
    <>
      <PageHead title={t('debts_title')} sub={t('debts_sub')} actions={<>
        <Button icon="download" disabled={!rows.length} onClick={() => downloadBlob(toCSV(rows, cols), 'debts.csv')}>{t('export_csv')}</Button>
        <Button icon="download" disabled={!rows.length} onClick={async () => downloadBlob(await toXLSX(rows, cols, { sheetName: t('nav_debts') }), 'debts.xlsx')}>{t('export_xlsx')}</Button>
        <Button variant="success" icon="minus" onClick={() => setForm({ category: 'debt_repayment' })}>{t('add_repayment')}</Button>
        <Button variant="primary" icon="plus" onClick={() => setForm({ category: 'debt' })}>{t('add_debt')}</Button>
      </>} />
      <div className="kpi-grid section">
        <Kpi money hero label={t('total_debts')} value={tot.debt} icon="debt" loading={balances.loading && !balances.data} />
        <Kpi label={t('debtors')} value={tot.debtors} icon="users" color="#f59e0b" loading={balances.loading && !balances.data} />
        <Kpi money label={t('opening_debt')} value={tot.opening} icon="history" color="#f43f5e" loading={balances.loading && !balances.data} />
        <Kpi money label={t('repaid_total')} value={tot.repaid} icon="check" color="#10b981" loading={balances.loading && !balances.data} />
      </div>
      <Card className="flush">
        <div style={{ padding: 'var(--pad) var(--pad) 0' }}>
          <Tabs value={tab} onChange={setTab} items={[{ value: 'balances', label: t('debt_balance'), count: rows.length }, { value: 'entries', label: t('debt_entries'), count: ent.length }]} />
        </div>
        {tab === 'balances' ? <>
          <div className="row wrap" style={{ padding: '0 var(--pad) var(--pad)', gap: 10 }}>
            <SearchBox value={search} onChange={setSearch} placeholder={t('search_promoters')} />
            <ManagerFilter value={manager} onChange={setManager} />
            <Switch checked={onlyDebtors} onChange={setOnlyDebtors} label={t('only_debtors')} />
          </div>
          <DataTable rows={rows} loading={balances.loading} error={balances.error} onRetry={balances.reload} initialSort={{ key: 'debt_balance', dir: 'desc' }}
            onRowClick={(r) => navigate('/promoters/' + r.id)} columns={[
              { key: 'full_name', label: t('promoter'), primary: true, render: (r) => <div>{r.full_name}<div className="tiny faint num">{r.phone} · {r.manager_name}</div></div> },
              { key: 'opening_debt', label: t('opening_debt'), num: true, render: (r) => f.money(r.opening_debt) },
              { key: 'new_debt', label: t('new_debt'), num: true, render: (r) => f.money(r.new_debt) },
              { key: 'debt_repaid', label: t('debt_repaid'), num: true, render: (r) => <span className="pos">{f.money(r.debt_repaid)}</span> },
              { key: 'debt_balance', label: t('debt_balance'), num: true, render: (r) => <b className={r.debt_balance > 0 ? 'neg' : 'faint'}>{f.money(r.debt_balance)}</b> },
              { key: 'act', label: '', sortable: false, stop: true, render: (r) => (
                <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" icon="plus" onClick={() => setForm({ promoterId: r.id, category: 'debt' })}>{t('add_debt')}</Button>
                  {r.debt_balance > 0 && <Button size="sm" variant="success" icon="minus" onClick={() => setForm({ promoterId: r.id, category: 'debt_repayment' })}>{t('add_repayment')}</Button>}
                </span>) },
            ]} />
        </> : <>
          <div className="row wrap" style={{ padding: '0 var(--pad) var(--pad)', gap: 10 }}>
            <DateRange value={range} onChange={setRange} />
            <ManagerFilter value={manager} onChange={setManager} />
            <div style={{ width: 220 }}><PromoterPicker value={promoter} onChange={setPromoter} managerId={manager} placeholder={`${t('promoter')}: ${t('all')}`} /></div>
            <Select value={type} onChange={(e) => setType(e.target.value)} placeholder={`${t('debt_type')}: ${t('all')}`} style={{ width: 170 }} options={DEBT_CATS.map((c) => ({ value: c, label: t('cat_' + c) }))} />
            <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={`${t('status')}: ${t('all')}`} style={{ width: 160 }} options={['approved', 'pending', 'void'].map((s) => ({ value: s, label: t('as_' + s) }))} />
          </div>
          <DataTable rows={ent} loading={entries.loading} error={entries.error} onRetry={entries.reload} columns={[
            { key: 'entry_date', label: t('date'), primary: true, render: (r) => f.date(r.entry_date) },
            { key: 'promoter_name', label: t('promoter'), render: (r) => <a href={`#/promoters/${r.promoter_id}`} onClick={(e) => { e.preventDefault(); navigate('/promoters/' + r.promoter_id); }}>{r.promoter_name}</a> },
            { key: 'category', label: t('debt_type'), render: (r) => <Badge plain tone={CATEGORY_TONE[r.category]}>{t('cat_' + r.category)}</Badge> },
            { key: 'amount', label: t('amount'), num: true, render: (r) => <b style={{ textDecoration: r.status === 'void' ? 'line-through' : undefined }} className={r.category === 'debt_repayment' ? 'pos' : ''}>{f.money(r.amount)}</b> },
            { key: 'status', label: t('status'), render: (r) => <Badge tone={r.status === 'approved' ? 'green' : r.status === 'pending' ? 'amber' : 'red'}>{t('as_' + r.status)}</Badge> },
            { key: 'notes', label: t('notes'), hideMobile: true, render: (r) => <span className="small faint">{r.void_reason ? `${r.notes || ''} — ${r.void_reason}` : r.notes || ''}</span> },
            { key: 'act', label: '', sortable: false, stop: true, render: (r) => (['approved', 'pending'].includes(r.status) && !r.payroll_id
              ? <span onClick={(e) => e.stopPropagation()}><Button size="sm" variant="ghost" icon="x" onClick={() => remove(r)}>{t('delete')}</Button></span> : r.payroll_id ? <span className="tiny faint">{t('linked_payroll')}</span> : null) },
          ]} />
        </>}
      </Card>
      {form && <LedgerEntryForm promoterId={form.promoterId} defaultCategory={form.category} categories={DEBT_CATS}
        title={form.category === 'debt_repayment' ? t('add_repayment') : t('add_debt')} onClose={() => setForm(null)} onSaved={() => { setForm(null); reload(); }} />}
    </>
  );
}
