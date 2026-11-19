import React, { useMemo, useState } from 'react';
import { useApp, useAction, navigate } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { Alert, Badge, Button, Card, DataTable, Field, Input, Modal, MoneyInput, PageHead, Select, Textarea, useAsync, useConfirm, useFmt, useToast } from '../ui/ui.jsx';
import { DateRange, ManagerFilter, PromoterPicker } from '../app/shared.jsx';
import { baghdadToday, rangePreset } from '../engine/dates.js';
import { PAYROLL_CATEGORIES } from '../engine/payroll.js';
import { newKey, toCSV, toXLSX, downloadBlob } from '../lib/export.js';

export const MANUAL_CATEGORIES = ['withdrawal', 'advance', 'debt', 'opening_debt', 'debt_repayment', 'expense_charge', 'deduction', 'bonus', 'correction'];
export const CATEGORY_TONE = {
  opening_debt: 'red', debt: 'red', debt_repayment: 'green', withdrawal: 'amber', advance: 'amber', expense_charge: 'amber',
  deduction: 'red', bonus: 'green', correction: 'violet', salary_payment: 'blue',
};

export function LedgerEntryForm({ promoterId, onClose, onSaved, defaultCategory = 'withdrawal', categories = MANUAL_CATEGORIES, title }) {
  const { api, settings } = useApp();
  const { t } = useI18n(); const toast = useToast();
  const [run, busy] = useAction(toast);
  const [key] = useState(newKey);
  const [v, setV] = useState({ promoter_id: promoterId || null, category: defaultCategory, amount: null, entry_date: baghdadToday(), notes: '' });
  const needNotes = ['correction', 'deduction'].includes(v.category);
  const valid = v.promoter_id && v.amount && (v.category === 'correction' ? v.amount !== 0 : v.amount > 0) && (!needNotes || v.notes.trim());
  async function save() {
    const r = await run(() => api.addLedgerEntry({ ...v, idempotency_key: key }), settings.ledger_requires_approval ? t('as_pending') : t('saved'));
    if (r) onSaved(r);
  }
  return (
    <Modal open onClose={onClose} title={title || t('add_entry')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={save}>{t('save')}</Button></>}>
      {!promoterId && <Field label={t('promoter')}><PromoterPicker value={v.promoter_id} onChange={(id) => setV((s) => ({ ...s, promoter_id: id }))} /></Field>}
      <Field label={t('category')}>
        <div className="row wrap" style={{ gap: 6 }}>
          {categories.map((c) => <button key={c} type="button" className={`chip ${v.category === c ? 'on' : ''}`} onClick={() => setV((s) => ({ ...s, category: c }))}>{t('cat_' + c)}</button>)}
        </div>
      </Field>
      <div className="grid g2">
        <Field label={t('amount')} hint={v.category === 'correction' ? t('correction_hint') : undefined}><MoneyInput value={v.amount} allowNegative={v.category === 'correction'} onChange={(n) => setV((s) => ({ ...s, amount: n }))} /></Field>
        <Field label={t('date')}><Input type="date" value={v.entry_date} max={baghdadToday()} onChange={(e) => setV((s) => ({ ...s, entry_date: e.target.value }))} /></Field>
      </div>
      <Field label={needNotes ? t('reason') : t('notes')}><Textarea value={v.notes} onChange={(e) => setV((s) => ({ ...s, notes: e.target.value }))} maxLength={500} /></Field>
      <Alert>{v.category === 'debt_repayment' ? t('repay_from_salary') : PAYROLL_CATEGORIES.includes(v.category) ? t('affects_payroll') : t('debt_note')}</Alert>
    </Modal>
  );
}

export default function Ledger({ query }) {
  const { api, isAdmin } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const [range, setRange] = useState(() => rangePreset('last_30'));
  const [manager, setManager] = useState(null);
  const [promoter, setPromoter] = useState(query?.promoter || null);
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.listLedger({ from: range.from, to: range.to, managerId: manager, promoterId: promoter, category: category || null, status: status || null }),
    [api, range.from, range.to, manager, promoter, category, status]);
  const [run] = useAction(toast);

  const totals = useMemo(() => {
    const o = {}; for (const e of data || []) if (e.status === 'approved') o[e.category] = (o[e.category] || 0) + e.amount; return o;
  }, [data]);

  async function doVoid(e) {
    const reason = await confirm({ title: t('void'), requireReason: true, danger: true, message: `${t('cat_' + e.category)} · ${f.money(e.amount)}` });
    if (reason) { await run(() => api.voidLedgerEntry(e.id, reason), t('done')); reload(); }
  }
  async function review(e, decision) {
    const note = decision === 'rejected' ? await confirm({ title: t('reject'), requireReason: true, danger: true }) : true;
    if (note) { await run(() => api.reviewLedgerEntry(e.id, decision, typeof note === 'string' ? note : null), t('done')); reload(); }
  }
  const cols = [
    { label: t('date'), key: 'entry_date' }, { label: t('promoter'), key: 'promoter_name' }, { label: t('category'), value: (r) => t('cat_' + r.category) },
    { label: t('amount'), key: 'amount' }, { label: t('status'), value: (r) => t('as_' + r.status) }, { label: t('notes'), key: 'notes' },
  ];

  return (
    <>
      <PageHead title={t('led_title')} sub={t('led_sub')} actions={<>
        <Button icon="download" disabled={!data?.length} onClick={() => downloadBlob(toCSV(data, cols), 'ledger.csv')}>{t('export_csv')}</Button>
        <Button icon="download" disabled={!data?.length} onClick={async () => downloadBlob(await toXLSX(data, cols, { sheetName: t('led_title') }), 'ledger.xlsx')}>{t('export_xlsx')}</Button>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>{t('add_entry')}</Button>
      </>} />
      <div className="row wrap section" style={{ gap: 8 }}>
        {['withdrawal', 'advance', 'debt_repayment', 'bonus', 'salary_payment'].map((c) => (
          <div key={c} className="card" style={{ padding: '10px 14px', flex: '1 1 150px' }}>
            <div className="tiny faint">{t('cat_' + c)}</div><b className="num">{f.money(totals[c] || 0)}</b>
          </div>
        ))}
      </div>
      <Card className="flush">
        <div className="row wrap" style={{ padding: 'var(--pad)', gap: 10 }}>
          <DateRange value={range} onChange={setRange} />
          <ManagerFilter value={manager} onChange={setManager} />
          <div style={{ width: 220 }}><PromoterPicker value={promoter} onChange={setPromoter} managerId={manager} placeholder={`${t('promoter')}: ${t('all')}`} /></div>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} placeholder={`${t('category')}: ${t('all')}`} style={{ width: 170 }}
            options={[...MANUAL_CATEGORIES, 'salary_payment'].map((c) => ({ value: c, label: t('cat_' + c) }))} />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={`${t('status')}: ${t('all')}`} style={{ width: 160 }}
            options={['pending', 'approved', 'rejected', 'void'].map((s) => ({ value: s, label: t('as_' + s) }))} />
        </div>
        <DataTable rows={data} loading={loading} error={error} onRetry={reload} columns={[
          { key: 'entry_date', label: t('date'), primary: true, render: (r) => f.date(r.entry_date) },
          { key: 'promoter_name', label: t('promoter'), render: (r) => <a href={`#/promoters/${r.promoter_id}`} onClick={(e) => { e.preventDefault(); navigate('/promoters/' + r.promoter_id); }}>{r.promoter_name}</a> },
          { key: 'category', label: t('category'), render: (r) => <Badge tone={CATEGORY_TONE[r.category]} plain>{t('cat_' + r.category)}</Badge> },
          { key: 'amount', label: t('amount'), num: true, render: (r) => <b style={{ textDecoration: ['void', 'rejected'].includes(r.status) ? 'line-through' : undefined }} className={r.status !== 'approved' ? 'faint' : ''}>{f.money(r.amount)}</b> },
          { key: 'status', label: t('status'), render: (r) => <Badge tone={r.status === 'approved' ? 'green' : r.status === 'pending' ? 'amber' : 'red'}>{t('as_' + r.status)}</Badge> },
          { key: 'notes', label: t('notes'), hideMobile: true, render: (r) => <span className="small faint">{r.void_reason ? `${r.notes || ''} — ${r.void_reason}` : r.notes || (r.payroll_id ? t('linked_payroll') : '')}</span> },
          { key: 'act', label: '', sortable: false, stop: true, render: (r) => (
            <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
              {isAdmin && r.status === 'pending' && <><Button size="sm" variant="success" icon="check" onClick={() => review(r, 'approved')}>{t('approve_entry')}</Button><Button size="sm" variant="danger" onClick={() => review(r, 'rejected')}>{t('reject')}</Button></>}
              {['approved', 'pending'].includes(r.status) && !r.payroll_id && r.category !== 'salary_payment' && <Button size="sm" variant="ghost" icon="x" onClick={() => doVoid(r)}>{t('void')}</Button>}
            </span>
          ) },
        ]} />
      </Card>
      {adding && <LedgerEntryForm promoterId={promoter} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </>
  );
}
