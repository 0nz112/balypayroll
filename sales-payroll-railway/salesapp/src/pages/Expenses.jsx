import React, { useMemo, useState } from 'react';
import { useApp, useAction } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { Badge, Button, Card, DataTable, Field, Input, Modal, MoneyInput, PageHead, Seg, Select, Textarea, useAsync, useConfirm, useFmt, useToast, Kpi, Empty, Skeleton, Switch, Icon } from '../ui/ui.jsx';
import { DateRange, ManagerFilter, PromoterPicker } from '../app/shared.jsx';
import { baghdadToday, rangePreset, addDays } from '../engine/dates.js';
import { BarList, Donut, PALETTE } from '../ui/charts.jsx';
import { newKey, toCSV, toXLSX, downloadBlob } from '../lib/export.js';

export default function Expenses() {
  const { api, isAdmin, categories } = useApp();
  const { t, lang } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const [range, setRange] = useState(() => rangePreset('month'));
  const [manager, setManager] = useState(null);
  const [category, setCategory] = useState('');
  const [group, setGroup] = useState('week');
  const [adding, setAdding] = useState(false);
  const list = useAsync(() => api.listExpenses({ from: range.from, to: range.to, managerId: manager, category: category || null }), [api, range.from, range.to, manager, category]);
  const summary = useAsync(() => api.expenseSummary(range.from, range.to, group, manager), [api, range.from, range.to, group, manager]);
  const [run] = useAction(toast);
  const catName = (k) => { const c = categories.find((x) => x.key === k); return c ? (lang === 'ar' ? c.name_ar : c.name_en) : k; };

  const totals = useMemo(() => {
    const ok = (list.data || []).filter((x) => x.status === 'approved');
    return { all: ok.reduce((s, x) => s + x.amount, 0), company: ok.filter((x) => !x.charged_promoter_id).reduce((s, x) => s + x.amount, 0), charged: ok.filter((x) => x.charged_promoter_id).reduce((s, x) => s + x.amount, 0), count: ok.length };
  }, [list.data]);
  const buckets = useMemo(() => {
    const m = new Map(); for (const r of summary.data || []) m.set(r.bucket, (m.get(r.bucket) || 0) + Number(r.total));
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([b, v]) => ({ id: b, label: group === 'month' ? f.month(b) : group === 'week' ? `${f.short(b)} – ${f.short(addDays(b, 6))}` : f.short(b), value: v }));
  }, [summary.data, group, f]);
  const byCat = useMemo(() => {
    const m = new Map(); for (const r of summary.data || []) m.set(r.category, (m.get(r.category) || 0) + Number(r.total));
    return [...m].sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ label: catName(k), value: v, color: PALETTE[i % PALETTE.length] }));
  }, [summary.data]); // eslint-disable-line

  async function doVoid(x) {
    const reason = await confirm({ title: t('void_expense'), requireReason: true, danger: true, message: `${x.description} · ${f.money(x.amount)}` });
    if (reason) { await run(() => api.voidExpense(x.id, reason), t('done')); list.reload(); summary.reload(); }
  }
  async function viewAttachment(x) { try { window.open(await api.attachmentUrl(x.attachment_path), '_blank', 'noopener'); } catch (e) { toast.error(e); } }
  const cols = [{ label: t('date'), key: 'expense_date' }, { label: t('category'), value: (r) => catName(r.category) }, { label: t('description'), key: 'description' },
    { label: t('amount'), key: 'amount' }, { label: t('promoter_deduction'), key: 'promoter_name' }, { label: t('status'), value: (r) => t('as_' + r.status) }];

  return (
    <>
      <PageHead title={t('exp_title')} sub={t('exp_sub')} actions={<>
        <Button icon="download" disabled={!list.data?.length} onClick={() => downloadBlob(toCSV(list.data, cols), 'expenses.csv')}>{t('export_csv')}</Button>
        <Button icon="download" disabled={!list.data?.length} onClick={async () => downloadBlob(await toXLSX(list.data, cols, { sheetName: t('exp_title') }), 'expenses.xlsx')}>{t('export_xlsx')}</Button>
        <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>{t('add_expense')}</Button>
      </>} />
      <div className="row wrap section" style={{ gap: 10 }}>
        <DateRange value={range} onChange={setRange} /><ManagerFilter value={manager} onChange={setManager} />
        <Select value={category} onChange={(e) => setCategory(e.target.value)} placeholder={`${t('category')}: ${t('all')}`} style={{ width: 180 }} options={categories.map((c) => ({ value: c.key, label: lang === 'ar' ? c.name_ar : c.name_en }))} />
      </div>
      <div className="kpi-grid section">
        <Kpi money hero label={t('total')} value={totals.all} icon="receipt" loading={list.loading && !list.data} foot={`${f.num(totals.count)}`} />
        <Kpi money label={t('company_expense')} value={totals.company} icon="shield" color="#14b8a6" loading={list.loading && !list.data} />
        <Kpi money label={t('promoter_deduction')} value={totals.charged} icon="users" color="#f59e0b" loading={list.loading && !list.data} />
      </div>
      <div className="grid g2 section">
        <Card title={t('group_by')} actions={<Seg value={group} onChange={setGroup} accent options={['day', 'week', 'month'].map((g) => ({ value: g, label: t('g_' + g) }))} />}>
          {summary.loading && !summary.data ? <Skeleton h={180} /> : buckets.length ? <div style={{ maxHeight: 300, overflowY: 'auto' }}><BarList items={buckets} money /></div> : <Empty icon="receipt" />}
        </Card>
        <Card title={t('expenses_breakdown')}>{summary.loading && !summary.data ? <Skeleton h={180} /> : byCat.length ? <Donut items={byCat} centerLabel={t('total')} /> : <Empty icon="receipt" />}</Card>
      </div>
      <Card className="flush">
        <DataTable rows={list.data} loading={list.loading} error={list.error} onRetry={list.reload} columns={[
          { key: 'expense_date', label: t('date'), primary: true, render: (r) => f.date(r.expense_date) },
          { key: 'category', label: t('category'), render: (r) => <Badge plain tone={r.category === 'harqiyat' ? 'amber' : r.category === 'fuel' ? 'blue' : ''}>{catName(r.category)}</Badge> },
          { key: 'description', label: t('description'), render: (r) => <span style={{ textDecoration: r.status === 'void' ? 'line-through' : undefined }}>{r.description}</span> },
          { key: 'amount', label: t('amount'), num: true, render: (r) => <b className={r.status === 'void' ? 'faint' : ''}>{f.money(r.amount)}</b> },
          { key: 'promoter_name', label: t('charge_type'), render: (r) => (r.charged_promoter_id ? <Badge tone="amber">{t('promoter_deduction')}: {r.promoter_name}</Badge> : <Badge tone="blue" plain>{t('company_expense')}</Badge>) },
          { key: 'status', label: t('status'), render: (r) => <Badge tone={r.status === 'approved' ? 'green' : 'red'}>{t('as_' + r.status)}</Badge> },
          { key: 'act', label: '', sortable: false, stop: true, render: (r) => (
            <span className="row" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
              {r.attachment_path && <Button size="sm" variant="ghost" icon="paperclip" onClick={() => viewAttachment(r)} aria-label={t('view_attachment')} />}
              {r.status === 'approved' && <Button size="sm" variant="ghost" icon="x" onClick={() => doVoid(r)}>{t('void')}</Button>}
            </span>) },
        ]} />
      </Card>
      {adding && <ExpenseForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); summary.reload(); }} />}
    </>
  );
}

function ExpenseForm({ onClose, onSaved }) {
  const { api, isAdmin, managers, categories } = useApp();
  const { t, lang } = useI18n(); const toast = useToast();
  const [run, busy] = useAction(toast);
  const [key] = useState(newKey);
  const [v, setV] = useState({ category: 'harqiyat', description: '', amount: null, expense_date: baghdadToday(), manager_id: null, charge: false, charged_promoter_id: null });
  const [file, setFile] = useState(null);
  const mid = isAdmin ? v.manager_id : undefined;
  const valid = v.amount > 0 && v.description.trim().length >= 2 && (!isAdmin || v.manager_id) && (!v.charge || v.charged_promoter_id) && (!file || file.size <= 5 * 1024 * 1024);
  async function save() {
    const r = await run(() => api.addExpense({ category: v.category, description: v.description, amount: v.amount, expense_date: v.expense_date, manager_id: v.manager_id,
      charged_promoter_id: v.charge ? v.charged_promoter_id : null, idempotency_key: key }, file), t('saved'));
    if (r) onSaved();
  }
  return (
    <Modal open onClose={onClose} title={t('add_expense')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={save}>{t('save')}</Button></>}>
      {isAdmin && <Field label={t('manager')}><Select value={v.manager_id || ''} onChange={(e) => setV((s) => ({ ...s, manager_id: e.target.value || null, charged_promoter_id: null }))} placeholder={t('select_manager')} options={managers.map((m) => ({ value: m.id, label: m.full_name }))} /></Field>}
      <Field label={t('category')}>
        <div className="row wrap" style={{ gap: 6 }}>{categories.map((c) => <button type="button" key={c.key} className={`chip ${v.category === c.key ? 'on' : ''}`} onClick={() => setV((s) => ({ ...s, category: c.key }))}>{lang === 'ar' ? c.name_ar : c.name_en}</button>)}</div>
      </Field>
      <Field label={t('description')}><Input value={v.description} onChange={(e) => setV((s) => ({ ...s, description: e.target.value }))} maxLength={200} /></Field>
      <div className="grid g2">
        <Field label={t('amount')}><MoneyInput value={v.amount} onChange={(n) => setV((s) => ({ ...s, amount: n }))} /></Field>
        <Field label={t('date')}><Input type="date" value={v.expense_date} max={baghdadToday()} onChange={(e) => setV((s) => ({ ...s, expense_date: e.target.value }))} /></Field>
      </div>
      <Field label={`${t('attachment')} (${t('optional')})`} hint="JPG · PNG · WEBP · PDF ≤ 5MB">
        <Input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)} style={{ paddingTop: 8 }} />
      </Field>
      <Switch checked={v.charge} onChange={(c) => setV((s) => ({ ...s, charge: c }))} label={t('charge_to_promoter')} />
      {v.charge && (!isAdmin || v.manager_id) && <Field label={t('promoter')}><PromoterPicker value={v.charged_promoter_id} managerId={mid} onChange={(id) => setV((s) => ({ ...s, charged_promoter_id: id }))} /></Field>}
    </Modal>
  );
}
