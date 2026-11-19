import React, { useState } from 'react';
import { useApp, useAction } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { Badge, Button, Card, DataTable, Field, Input, Modal, MoneyInput, PageHead, Select, Switch, Textarea, useAsync, useConfirm, useFmt, useToast, STATUS_TONE, Alert } from '../ui/ui.jsx';
import { DateRange } from '../app/shared.jsx';
import { rangePreset, baghdadToday, weekStartOf, addDays } from '../engine/dates.js';

// ------------------------------------------------------------------ Managers
export function Managers() {
  const { api, managers, refreshMeta } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const [form, setForm] = useState(null);
  const [pw, setPw] = useState(null);
  const [run, busy] = useAction(toast);
  const { data, loading, error, reload } = useAsync(() => api.listManagers(), [api]);
  const refresh = () => { reload(); refreshMeta(); };

  async function setStatus(m, status) {
    if (status === 'deleted' && m.promoters_count > 0) { toast.error({ code: 'HAS_PROMOTERS' }); return; }
    const reason = await confirm({ title: `${t(status === 'active' ? 'activate' : status === 'suspended' ? 'suspend' : 'delete')} — ${m.full_name}`, requireReason: true, danger: status !== 'active',
      message: status === 'deleted' ? t('delete_manager_hint') : undefined });
    if (reason) { await run(() => api.setManagerStatus(m.id, status, reason), t('done')); refresh(); }
  }
  return (
    <>
      <PageHead title={t('mgr_title')} actions={<Button variant="primary" icon="plus" onClick={() => setForm({})}>{t('add_manager')}</Button>} />
      <Card className="flush">
        <DataTable rows={data} loading={loading} error={error} onRetry={reload} columns={[
          { key: 'full_name', label: t('name'), primary: true, render: (r) => <div>{r.full_name}<div className="tiny faint" dir="ltr" style={{ textAlign: 'start' }}>{r.email}</div></div> },
          { key: 'phone', label: t('phone'), render: (r) => <span className="num faint">{r.phone || '—'}</span> },
          { key: 'promoters_count', label: t('promoters_count'), num: true, render: (r) => f.num(r.promoters_count) },
          { key: 'status', label: t('status'), render: (r) => <Badge tone={STATUS_TONE[r.status]}>{t('acc_' + r.status)}</Badge> },
          { key: 'created_at', label: t('created_at'), hideMobile: true, render: (r) => <span className="faint">{f.dt(r.created_at)}</span> },
          { key: 'act', label: '', sortable: false, stop: true, render: (r) => (
            <span className="row wrap" style={{ gap: 4 }} onClick={(e) => e.stopPropagation()}>
              <Button size="sm" icon="edit" onClick={() => setForm(r)}>{t('edit')}</Button>
              <Button size="sm" variant="ghost" icon="lock" onClick={() => setPw(r)}>{t('reset_password')}</Button>
              {r.status === 'active' ? <Button size="sm" variant="danger" onClick={() => setStatus(r, 'suspended')}>{t('suspend')}</Button> : <Button size="sm" variant="success" onClick={() => setStatus(r, 'active')}>{t('activate')}</Button>}
              <Button size="sm" variant="ghost" icon="x" disabled={r.promoters_count > 0} title={t('delete_manager_hint')} onClick={() => setStatus(r, 'deleted')} />
            </span>) },
        ]} />
      </Card>
      {form && <ManagerForm initial={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
      {pw && <PasswordForm manager={pw} onClose={() => setPw(null)} />}
    </>
  );
}

function ManagerForm({ initial, onClose, onSaved }) {
  const { api } = useApp(); const { t } = useI18n(); const toast = useToast();
  const [run, busy] = useAction(toast);
  const [v, setV] = useState({ full_name: '', phone: '', email: '', password: '', notes: '', ...initial });
  const isNew = !initial.id;
  const valid = v.full_name.trim().length >= 2 && (!isNew || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) && v.password.length >= 8));
  async function save() {
    const r = await run(() => (isNew ? api.createManager({ email: v.email, password: v.password, full_name: v.full_name, phone: v.phone }) : api.updateManager(v.id, { full_name: v.full_name, phone: v.phone, notes: v.notes })), t('saved'));
    if (r) onSaved();
  }
  return (
    <Modal open onClose={onClose} title={isNew ? t('add_manager') : t('edit')}
      footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" loading={busy} disabled={!valid} onClick={save}>{t('save')}</Button></>}>
      <Field label={t('full_name')}><Input value={v.full_name} onChange={(e) => setV((s) => ({ ...s, full_name: e.target.value }))} autoFocus /></Field>
      <Field label={t('phone')}><Input value={v.phone || ''} onChange={(e) => setV((s) => ({ ...s, phone: e.target.value }))} dir="ltr" inputMode="tel" /></Field>
      {isNew && <>
        <Field label={t('email')}><Input type="email" value={v.email} onChange={(e) => setV((s) => ({ ...s, email: e.target.value }))} dir="ltr" /></Field>
        <Field label={t('temp_password')} hint="≥ 8"><Input type="text" value={v.password} onChange={(e) => setV((s) => ({ ...s, password: e.target.value }))} dir="ltr" autoComplete="new-password" /></Field>
      </>}
      {!isNew && <Field label={t('notes')}><Textarea value={v.notes || ''} onChange={(e) => setV((s) => ({ ...s, notes: e.target.value }))} /></Field>}
    </Modal>
  );
}

function PasswordForm({ manager, onClose }) {
  const { api } = useApp(); const { t } = useI18n(); const toast = useToast();
  const [run, busy] = useAction(toast);
  const [pw, setPw] = useState('');
  return (
    <Modal open onClose={onClose} title={`${t('reset_password')} — ${manager.full_name}`}
      footer={<><Button variant="ghost" onClick={onClose}>{t('cancel')}</Button><Button variant="primary" loading={busy} disabled={pw.length < 8} onClick={async () => { if (await run(() => api.resetPassword(manager.id, pw), t('done'))) onClose(); }}>{t('save')}</Button></>}>
      <Field label={t('temp_password')} hint="≥ 8"><Input value={pw} onChange={(e) => setPw(e.target.value)} dir="ltr" autoComplete="new-password" /></Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ Audit
export function Audit() {
  const { api } = useApp(); const { t } = useI18n(); const f = useFmt();
  const [range, setRange] = useState(() => rangePreset('last_30'));
  const [table, setTable] = useState('');
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(null);
  const { data, loading, error, reload } = useAsync(() => api.listAudit({ table: table || null, from: range.from, to: range.to, limit: 50, offset: page * 50 }), [api, table, range.from, range.to, page]);
  const tables = ['promoters', 'registrations', 'ledger_entries', 'payrolls', 'payroll_payments', 'payroll_adjustments', 'incentive_rules', 'expenses', 'profiles', 'settings', 'auth.users'];
  return (
    <>
      <PageHead title={t('audit_title')} sub={t('audit_sub')} />
      <div className="row wrap section" style={{ gap: 10 }}>
        <DateRange value={range} onChange={(r) => { setRange(r); setPage(0); }} />
        <Select value={table} onChange={(e) => { setTable(e.target.value); setPage(0); }} placeholder={`${t('table')}: ${t('all')}`} style={{ width: 200 }} options={tables.map((x) => ({ value: x, label: x }))} />
      </div>
      <Card className="flush">
        <DataTable rows={data} loading={loading} error={error} onRetry={reload} onRowClick={setOpen} columns={[
          { key: 'at', label: t('date'), primary: true, render: (r) => f.dt(r.at) },
          { key: 'action', label: t('action'), render: (r) => <Badge tone={r.action === 'INSERT' ? 'green' : r.action === 'UPDATE' ? 'blue' : 'red'}>{t('a_' + r.action) === 'a_' + r.action ? r.action : t('a_' + r.action)}</Badge> },
          { key: 'table_name', label: t('table'), render: (r) => <code className="small">{r.table_name}</code> },
          { key: 'row_id', label: 'ID', hideMobile: true, render: (r) => <code className="tiny faint">{String(r.row_id || '').slice(0, 8)}</code> },
          { key: 'actor', label: t('actor'), hideMobile: true, render: (r) => <code className="tiny faint">{String(r.actor || 'system').slice(0, 8)}</code> },
          { key: 'reason', label: t('reason'), render: (r) => <span className="small">{r.reason || '—'}</span> },
        ]} />
        <div className="row end" style={{ padding: 12 }}>
          <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>{t('prev')}</Button>
          <span className="small faint num">{f.num(page + 1)}</span>
          <Button size="sm" disabled={(data?.length || 0) < 50} onClick={() => setPage((p) => p + 1)}>{t('next')}</Button>
        </div>
      </Card>
      {open && <Modal open size="wide" onClose={() => setOpen(null)} title={`${open.table_name} · ${open.action}`}>
        <div className="small faint">{f.dt(open.at)} · {open.reason || ''}</div>
        <Diff a={open.old_data} b={open.new_data} />
      </Modal>}
    </>
  );
}

function Diff({ a, b }) {
  const { t } = useI18n();
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter((k) => !['snapshot', 'old_snapshot', 'new_snapshot'].includes(k));
  const show = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <div className="table-wrap"><table className="table"><thead><tr><th>{t('key')}</th><th>{t('old_value')}</th><th>{t('new_value')}</th></tr></thead>
      <tbody>{keys.map((k) => { const ch = JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k]); return (
        <tr key={k} className={ch && a ? 'selected' : ''}><td><code className="small">{k}</code></td><td className="small faint" style={{ whiteSpace: 'normal', maxWidth: 280, wordBreak: 'break-word' }}>{a ? show(a[k]) : ''}</td><td className="small" style={{ whiteSpace: 'normal', maxWidth: 280, wordBreak: 'break-word' }}>{b ? show(b[k]) : ''}</td></tr>
      ); })}</tbody></table></div>
  );
}

// ------------------------------------------------------------------ System settings
export function SystemSettings() {
  const { api, settings, categories, refreshMeta } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast();
  const [run, busy] = useAction(toast);
  const [v, setV] = useState(settings);
  const [cat, setCat] = useState({ key: '', ar: '', en: '' });
  const dirty = JSON.stringify(v) !== JSON.stringify(settings);
  async function save() { if (await run(() => api.updateSettings(v), t('saved'))) refreshMeta(); }
  async function addCat() { if (await run(() => api.addExpenseCategory(cat.key.trim().toLowerCase(), cat.ar.trim(), cat.en.trim()), t('saved')) !== undefined) { setCat({ key: '', ar: '', en: '' }); refreshMeta(); } }
  return (
    <>
      <PageHead title={t('set_title')} />
      <PricingCard />
      <div className="grid g2" style={{ marginTop: 'var(--gap)' }}>
        <Card title={t('system_settings')} icon="settings">
          <div className="grid" style={{ gap: 14 }}>
            <Field label={t('company_name')}><Input value={v.company_name} onChange={(e) => setV((s) => ({ ...s, company_name: e.target.value }))} /></Field>
            <Field label={t('max_daily')}><Input type="number" min={1} max={1000} value={v.max_daily_registrations} onChange={(e) => setV((s) => ({ ...s, max_daily_registrations: Math.max(1, parseInt(e.target.value || '1', 10)) }))} /></Field>
            <Switch checked={v.ledger_requires_approval} onChange={(c) => setV((s) => ({ ...s, ledger_requires_approval: c }))} label={t('ledger_approval')} />
            <div className="grid g2">
              <Field label={t('timezone')}><Input value="Asia/Baghdad (UTC+3)" disabled dir="ltr" /></Field>
              <Field label={t('currency')}><Input value="IQD — دينار عراقي" disabled /></Field>
            </div>
            <div className="row end"><Button variant="primary" icon="check" disabled={!dirty} loading={busy} onClick={save}>{t('save')}</Button></div>
          </div>
        </Card>
        <Card title={t('expense_categories')} icon="receipt">
          <div className="grid" style={{ gap: 6 }}>
            {categories.map((c) => <div key={c.key} className="m-kv" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}><span><code className="small">{c.key}</code></span><span>{c.name_ar} · <span className="faint">{c.name_en}</span></span></div>)}
          </div>
          <hr className="divider" />
          <div className="grid g3">
            <Field label={t('key')} hint="a-z 0-9 _"><Input value={cat.key} onChange={(e) => setCat((s) => ({ ...s, key: e.target.value }))} dir="ltr" /></Field>
            <Field label={t('name_ar')}><Input value={cat.ar} onChange={(e) => setCat((s) => ({ ...s, ar: e.target.value }))} /></Field>
            <Field label={t('name_en')}><Input value={cat.en} onChange={(e) => setCat((s) => ({ ...s, en: e.target.value }))} dir="ltr" /></Field>
          </div>
          <div className="row end" style={{ marginTop: 10 }}><Button icon="plus" disabled={!/^[a-z0-9_]{2,40}$/.test(cat.key) || !cat.ar || !cat.en} loading={busy} onClick={addCat}>{t('add_category')}</Button></div>
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Car pricing plans
function PricingCard() {
  const { api } = useApp();
  const { t } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const [run, busy] = useAction(toast);
  const plans = useAsync(() => api.listPlans(), [api]);
  const current = (plans.data || []).find((p) => p.effective_from <= weekStartOf(baghdadToday()));
  const [v, setV] = useState(null);
  const edit = (p) => setV({ ...(p || current || {}), effective_from: p ? p.effective_from : weekStartOf(baghdadToday()) });
  const set = (k) => (n) => setV((s) => ({ ...s, [k]: n ?? 0 }));
  async function save(reason) {
    try { await api.savePlan(v, reason); toast.ok(t('saved')); setV(null); plans.reload(); }
    catch (e) {
      if (e.code === 'PLAN_LOCKED' && !reason) { const r = await confirm({ title: t('pricing'), message: t('err_PLAN_LOCKED'), requireReason: true }); if (r) save(r); }
      else toast.error(e);
    }
  }
  async function del(p) {
    const r = await confirm({ title: t('delete'), requireReason: true, danger: true, message: `${t('effective_from')} ${f.date(p.effective_from)}` });
    if (r && await run(() => api.deletePlan(p.effective_from, r), t('done')) !== undefined) plans.reload();
  }
  const P = v || current;
  return (
    <Card title={t('pricing')} sub={t('pricing_sub')} icon="money" glass actions={!v && <Button variant="primary" icon="plus" onClick={() => edit(null)}>{t('add_plan')}</Button>}>
      {P && <div className="pricing-hero stagger">
        <div className="price-tile"><span className="tiny faint">{t('registered_only')}</span><b className="num">{f.money(P.price_registered)}</b></div>
        <div className="price-tile ok"><span className="tiny faint">{t('active_cars')}</span><b className="num">{f.money(P.price_active)}</b></div>
        <div className="price-tile bonus"><span className="tiny faint">{t('bonus_rate')}</span><b className="num">{f.money(P.bonus_price)}</b>
          <span className="tiny">{t('bonus_min_cars')} {f.num(P.bonus_min_cars)} · {t('bonus_activity_pct')} {f.num(P.bonus_activity_pct)}</span></div>
      </div>}
      {P && <div className="small muted" style={{ marginTop: 10 }}>{t('plan_rule_text', { min: f.num(P.bonus_min_cars), pct: f.num(P.bonus_activity_pct), bonus: f.money(P.bonus_price), reg: f.money(P.price_registered), act: f.money(P.price_active) })}</div>}
      {v && <div className="grid" style={{ gap: 12, marginTop: 14 }}>
        <div className="grid g3">
          <Field label={t('price_registered')}><MoneyInput value={v.price_registered} onChange={set('price_registered')} /></Field>
          <Field label={t('price_active')}><MoneyInput value={v.price_active} onChange={set('price_active')} /></Field>
          <Field label={t('bonus_price')}><MoneyInput value={v.bonus_price} onChange={set('bonus_price')} /></Field>
          <Field label={t('bonus_min_cars')}><Input type="number" min={0} value={v.bonus_min_cars} onChange={(e) => set('bonus_min_cars')(Math.max(0, parseInt(e.target.value || '0', 10)))} /></Field>
          <Field label={t('bonus_activity_pct')}><Input type="number" min={0} max={100} value={v.bonus_activity_pct} onChange={(e) => set('bonus_activity_pct')(Math.min(100, Math.max(0, parseInt(e.target.value || '0', 10))))} /></Field>
          <Field label={t('effective_from')} hint={`${f.weekday(weekStartOf(v.effective_from))} ${f.date(weekStartOf(v.effective_from))} → ${f.date(addDays(weekStartOf(v.effective_from), 6))}`}>
            <Input type="date" value={v.effective_from} onChange={(e) => e.target.value && setV((s) => ({ ...s, effective_from: e.target.value }))} /></Field>
        </div>
        <Switch checked={v.bonus_enabled !== false} onChange={(c) => setV((s) => ({ ...s, bonus_enabled: c }))} label={t('bonus_enabled')} />
        <div className="row end"><Button variant="ghost" onClick={() => setV(null)}>{t('cancel')}</Button><Button variant="primary" icon="check" loading={busy} onClick={() => save(null)}>{t('save')}</Button></div>
      </div>}
      <hr className="divider" />
      <div className="small muted" style={{ marginBottom: 6 }}>{t('plans_history')}</div>
      <DataTable rows={(plans.data || []).map((p) => ({ ...p, id: p.effective_from }))} loading={plans.loading} error={plans.error} onRetry={plans.reload} columns={[
        { key: 'effective_from', label: t('effective_from'), primary: true, render: (r) => <span>{f.date(r.effective_from)} {r === current || r.effective_from === current?.effective_from ? <Badge tone="accent">{t('current_plan')}</Badge> : null}</span> },
        { key: 'price_registered', label: t('registered_only'), num: true, render: (r) => f.money(r.price_registered) },
        { key: 'price_active', label: t('active_cars'), num: true, render: (r) => f.money(r.price_active) },
        { key: 'bonus_price', label: t('bonus_rate'), num: true, render: (r) => (r.bonus_enabled ? `${f.money(r.bonus_price)} · ${f.num(r.bonus_min_cars)}+ · ${f.num(r.bonus_activity_pct)}%` : '—') },
        { key: 'act', label: '', sortable: false, stop: true, render: (r) => <span className="row" style={{ gap: 4 }}><Button size="sm" icon="edit" onClick={() => edit(r)}>{t('edit')}</Button>
          {r.effective_from !== [...(plans.data || [])].map((x) => x.effective_from).sort()[0] && <Button size="sm" variant="ghost" icon="x" onClick={() => del(r)} />}</span> },
      ]} />
    </Card>
  );
}
