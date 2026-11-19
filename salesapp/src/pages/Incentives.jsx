import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useAction } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { Alert, Badge, Button, Card, Field, Icon, Input, MoneyInput, PageHead, Seg, Switch, Textarea, useAsync, useConfirm, useFmt, useToast, Skeleton } from '../ui/ui.jsx';
import { addDays, baghdadToday, weekStartOf } from '../engine/dates.js';
import { emptyRule, normalizeRule, calcDailyIncentive } from '../engine/incentives.js';

const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // Saturday first

export default function Incentives() {
  const { api, isAdmin, settings, managers } = useApp();
  const { t, lang, dir } = useI18n(); const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const today = baghdadToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const first = `${month}-01`;
  const gridStart = weekStartOf(first);
  const days = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart]);
  const gridEnd = days[41];
  const rules = useAsync(() => api.listRules(gridStart, gridEnd), [api, gridStart, gridEnd]);
  const locked = useAsync(() => api.lockedWeeks(gridStart, gridEnd), [api, gridStart, gridEnd]);
  const byDate = useMemo(() => Object.fromEntries((rules.data || []).map((r) => [r.work_date, r])), [rules.data]);
  const lockedSet = useMemo(() => new Set(locked.data || []), [locked.data]);
  const [sel, setSel] = useState(new Set([today]));
  const [draft, setDraft] = useState(() => emptyRule());
  const [clip, setClip] = useState(null);
  const [run, busy] = useAction(toast);

  // when a single configured day is selected, load its rule into the editor
  useEffect(() => {
    if (sel.size !== 1) return;
    const d = [...sel][0]; const r = byDate[d];
    if (r) setDraft(fillRule(r));
  }, [sel, byDate]);

  const selArr = [...sel].sort();
  const anyLocked = selArr.some((d) => lockedSet.has(weekStartOf(d)));
  let ruleError = null; let norm = null;
  try { norm = normalizeRule(draft); } catch (e) { ruleError = e.detail; }

  const toggle = (d) => setSel((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; });
  const selectWeekday = (dow) => setSel(new Set(days.filter((d) => d.slice(0, 7) === month && new Date(d + 'T00:00:00Z').getUTCDay() === dow)));

  async function save() {
    let reason = null;
    if (anyLocked) { reason = await confirm({ title: t('nav_incentives'), message: t('rule_locked_hint'), requireReason: true }); if (!reason) return; }
    const n = await run(() => api.saveRule(selArr, norm, reason));
    if (n !== undefined) { toast.ok(`${t('saved')} — ${f.num(n)}`); rules.reload(); }
  }
  async function clear() {
    const reason = await confirm({ title: t('clear_rule'), requireReason: anyLocked, danger: true, message: selArr.map(f.short).join('، ') });
    if (!reason) return;
    await run(() => api.clearRule(selArr, typeof reason === 'string' ? reason : null), t('done')); rules.reload();
  }

  const [prevIcon, nextIcon] = dir === 'rtl' ? ['chevR', 'chevL'] : ['chevL', 'chevR'];
  const shiftMonth = (k) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); setMonth(d.toISOString().slice(0, 7)); };

  return (
    <>
      <PageHead title={t('inc_title')} sub={t('inc_sub')} />
      {!isAdmin && <div className="section"><Alert>{t('read_only_rules')}</Alert></div>}
      <div className={`grid ${isAdmin ? 'split' : ''}`}>
        <Card glass title={f.month(first)} actions={<div className="row"><Button size="sm" icon={prevIcon} onClick={() => shiftMonth(-1)} /><Button size="sm" variant="ghost" onClick={() => setMonth(today.slice(0, 7))}>{t('today')}</Button><Button size="sm" icon={nextIcon} onClick={() => shiftMonth(1)} /></div>}>
          {rules.loading && !rules.data ? <Skeleton h={380} /> : (
            <div className="cal">
              {WEEK_ORDER.map((dow) => <div key={dow} className="cal-h" onClick={() => isAdmin && selectWeekday(dow)} title={isAdmin ? t('select_weekday') : undefined}>{f.weekday(days[WEEK_ORDER.indexOf(dow)]).slice(0, lang === 'ar' ? 10 : 3)}</div>)}
              {days.map((d) => {
                const r = byDate[d];
                const top = r?.is_incentive_day ? Number(r.per_car_amount) || 0 : 0;
                return (
                  <button key={d} type="button" className={`cal-d ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''} ${r?.is_incentive_day ? 'inc' : ''} ${sel.has(d) ? 'sel' : ''}`}
                    onClick={() => (isAdmin ? toggle(d) : setSel(new Set([d])))}>
                    <span className="cal-num num">{f.num(Number(d.slice(8)))}</span>
                    {r?.is_incentive_day && <span className="cal-tag">{t('incentive_day')}</span>}
                    {r?.is_incentive_day && top > 0 && <span className="cal-tag num" style={{ color: 'var(--text-2)' }}>+{f.moneyPlain(top)}{r.applies_to === 'active' ? ' ✓' : ''}</span>}
                    {lockedSet.has(weekStartOf(d)) && <Icon name="lock" size={12} className="cal-lock" />}
                  </button>
                );
              })}
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 12, gap: 12 }}>
            <span className="legend"><span><i style={{ background: 'var(--accent)' }} />{t('incentive_day')}</span><span><i style={{ background: 'var(--surface-3)' }} />{t('no_incentive_day')}</span><span><Icon name="lock" size={12} style={{ color: 'var(--warning)' }} /> {t('week_locked_badge')}</span></span>
          </div>
          {!isAdmin && sel.size === 1 && <RuleSummary rule={byDate[[...sel][0]]} date={[...sel][0]} />}
        </Card>

        {isAdmin && (
          <div className="grid" style={{ alignContent: 'start' }}>
            <Card title={t('selected_dates')} sub={selArr.length ? selArr.slice(0, 6).map(f.short).join('، ') + (selArr.length > 6 ? ` +${selArr.length - 6}` : '') : '—'}
              actions={<><Button size="sm" variant="ghost" icon="copy" onClick={() => setClip(norm)} disabled={!norm}>{t('copy_rule')}</Button><Button size="sm" variant="ghost" onClick={() => clip && setDraft(fillRule(clip))} disabled={!clip}>{t('paste_rule')}</Button></>}>
              <Field label={t('inc_day_type')}>
                <Seg accent value={draft.is_incentive_day ? 'y' : 'n'} onChange={(v) => setDraft((d) => ({ ...d, is_incentive_day: v === 'y' }))} options={[{ value: 'y', label: t('incentive_day') }, { value: 'n', label: t('no_incentive_day') }]} />
              </Field>
              {draft.is_incentive_day && <>
                <div className="hint" style={{ margin: '8px 0 12px' }}>{t('daily_inc_sub')}</div>
                <div className="grid g2">
                  <Field label={t('per_car_amount')}><MoneyInput value={draft.per_car_amount} onChange={(n) => setDraft((d) => ({ ...d, per_car_amount: n ?? 0 }))} /></Field>
                  <Field label={t('min_cars')}><Input type="number" min={1} value={draft.min_cars} onChange={(e) => setDraft((d) => ({ ...d, min_cars: Math.max(1, parseInt(e.target.value || '1', 10)) }))} /></Field>
                </div>
                <Field label={t('applies_to')} className="">
                  <Seg accent value={draft.applies_to} onChange={(v) => setDraft((d) => ({ ...d, applies_to: v }))} options={[{ value: 'all', label: t('applies_to_all') }, { value: 'active', label: t('applies_to_active') }]} />
                </Field>
                <hr className="divider" />
                <div className="grid g2">
                  <Field label={t('min_tenure')}><Input type="number" min={0} value={draft.min_tenure_days} onChange={(e) => setDraft((d) => ({ ...d, min_tenure_days: Math.max(0, parseInt(e.target.value || '0', 10)) }))} /></Field>
                  <Field label={t('applies_to')}>
                    <div className="row wrap" style={{ gap: 6 }}>
                      <button type="button" className={`chip ${!draft.manager_ids?.length ? 'on' : ''}`} onClick={() => setDraft((d) => ({ ...d, manager_ids: null }))}>{t('all_managers')}</button>
                      {managers.map((m) => <button type="button" key={m.id} className={`chip ${draft.manager_ids?.includes(m.id) ? 'on' : ''}`}
                        onClick={() => setDraft((d) => { const st = new Set(d.manager_ids || []); st.has(m.id) ? st.delete(m.id) : st.add(m.id); return { ...d, manager_ids: st.size ? [...st] : null }; })}>{m.full_name}</button>)}
                    </div>
                  </Field>
                </div>
              </>}
              <Field label={t('notes')}><Textarea value={draft.notes || ''} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} maxLength={300} /></Field>
              {anyLocked && <Alert tone="warn">{t('rule_locked_hint')}</Alert>}
              {ruleError && <Alert tone="error">{t('err_INVALID_RULE', { detail: ruleError })}</Alert>}
              <div className="row wrap end" style={{ marginTop: 12 }}>
                <Button variant="danger" icon="x" onClick={clear} disabled={!selArr.length || !selArr.some((d) => byDate[d]?.is_incentive_day)} loading={busy}>{t('clear_rule')}</Button>
                <Button variant="primary" icon="check" onClick={save} disabled={!selArr.length || !!ruleError} loading={busy}>{t('apply_to_selected', { n: f.num(selArr.length) })}</Button>
              </div>
            </Card>
            <PreviewCard rule={norm} />
          </div>
        )}
      </div>
    </>
  );
}

function fillRule(r) {
  return { ...emptyRule(), is_incentive_day: !!r.is_incentive_day, per_car_amount: Number(r.per_car_amount) || 0, applies_to: r.applies_to || 'all',
    min_cars: Number(r.min_cars) || 1, min_tenure_days: Number(r.min_tenure_days) || 0, manager_ids: r.manager_ids?.length ? [...r.manager_ids] : null, notes: r.notes || '' };
}

function PreviewCard({ rule }) {
  const { t } = useI18n(); const f = useFmt();
  const [count, setCount] = useState(4);
  const [active, setActive] = useState(2);
  const [tenure, setTenure] = useState(90);
  const counts = [1, 2, 3, 4, 5, 6, 8, 10];
  return (
    <Card title={t('preview')} sub={t('preview_hint')} icon="sparkles">
      <div className="grid g3">
        <Field label={t('cars_registered')}><Input type="number" min={0} max={200} value={count} onChange={(e) => setCount(Math.max(0, parseInt(e.target.value || '0', 10)))} /></Field>
        <Field label={t('active_cars')}><Input type="number" min={0} max={count} value={active} onChange={(e) => setActive(Math.min(count, Math.max(0, parseInt(e.target.value || '0', 10))))} /></Field>
        <Field label={t('test_tenure')}><Input type="number" min={0} value={tenure} onChange={(e) => setTenure(Math.max(0, parseInt(e.target.value || '0', 10)))} /></Field>
      </div>
      {rule && <div className="kpi hero card" style={{ marginTop: 12, padding: 14 }}>
        <div className="row between" style={{ fontSize: '1.1rem' }}><span>{t('daily_incentive')}</span><b className="num" style={{ color: 'var(--accent)' }}>{f.money(calcDailyIncentive(rule, count, active, tenure, null))}</b></div>
      </div>}
      {rule && <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="table"><thead><tr><th>{t('cars')}</th><th className="n">{t('applies_to_all')}</th><th className="n">{t('applies_to_active')} (50%)</th></tr></thead>
          <tbody>{counts.map((c) => (
            <tr key={c} className={c === count ? 'selected' : ''}><td className="num">{f.num(c)}</td>
              <td className="n num">{f.money(calcDailyIncentive({ ...rule, applies_to: 'all' }, c, Math.floor(c / 2), tenure, null))}</td>
              <td className="n num">{f.money(calcDailyIncentive({ ...rule, applies_to: 'active' }, c, Math.floor(c / 2), tenure, null))}</td></tr>
          ))}</tbody></table>
      </div>}
    </Card>
  );
}

function RuleSummary({ rule, date }) {
  const { t } = useI18n(); const f = useFmt();
  if (!rule?.is_incentive_day) return <div style={{ marginTop: 14 }}><Badge>{f.date(date)} — {t('no_incentive_day')}</Badge></div>;
  return (
    <div className="card" style={{ marginTop: 14, padding: 14 }}>
      <b>{f.date(date)} — {t('incentive_day')}</b>
      <div className="m-kv"><span>{t('per_car_amount')}</span><b className="num">{f.money(rule.per_car_amount)}</b></div>
      <div className="m-kv"><span>{t('applies_to')}</span><b>{rule.applies_to === 'active' ? t('applies_to_active') : t('applies_to_all')}</b></div>
      <div className="m-kv"><span>{t('min_cars')}</span><b className="num">{f.num(rule.min_cars)}</b></div>
    </div>
  );
}
