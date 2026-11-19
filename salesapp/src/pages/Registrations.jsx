import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useAction, navigate } from '../app/context.js';
import { useI18n } from '../lib/i18n.js';
import { Badge, Button, Card, Empty, ErrorState, Field, Icon, Input, MoneyInput, PageHead, Seg, SkeletonRows, Stepper, Switch, useAsync, useConfirm, useFmt, useToast } from '../ui/ui.jsx';
import { ManagerFilter, SearchBox } from '../app/shared.jsx';
import { baghdadToday, addDays, diffDays, weekStartOf } from '../engine/dates.js';
import { calcDailyIncentive, calcDailyBonus, emptyBonus, BONUS_TIERS } from '../engine/incentives.js';
import { carEarnings, bonusProgress } from '../engine/payroll.js';
import { Ring, celebrate } from '../ui/motion.jsx';

export default function Registrations({ query }) {
  const { api, settings, isAdmin } = useApp();
  const { t, dir } = useI18n();
  const f = useFmt(); const toast = useToast(); const confirm = useConfirm();
  const today = baghdadToday();
  const [date, setDate] = useState(query?.date && query.date <= today ? query.date : today);
  const [manager, setManager] = useState(null);
  const [edits, setEdits] = useState({});
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const { data, loading, error, reload } = useAsync(() => api.getDay(date, manager), [api, date, manager]);
  const [run, busy] = useAction(toast);
  const [bonusDraft, setBonusDraft] = useState(null);
  useEffect(() => { setEdits({}); setBonusDraft(null); }, [date, manager]);
  const plan = data?.plan;
  const savedBonus = useMemo(() => {
    const list = data?.bonuses || [];
    return (isAdmin ? (manager ? list.find((b) => b.manager_id === manager) : list[0]) : list[0]) || null;
  }, [data, isAdmin, manager]);
  const bonusEdit = bonusDraft || (savedBonus ? { ...emptyBonus(), ...savedBonus } : emptyBonus());
  const bonusFor = (p) => (bonusDraft && (!isAdmin || !manager || p.manager_id === manager) ? bonusDraft : (data?.bonuses || []).find((b) => b.manager_id === p.manager_id) || null);
  const setBonus = (patch) => setBonusDraft({ ...bonusEdit, ...patch });
  const bonusSummary = (b) => [...BONUS_TIERS.filter((n) => Number(b['tier' + n]) > 0).map((n) => `${f.num(n)}🚗 ${f.money(b['tier' + n])}`),
    b.extra_enabled && b.extra_amount > 0 ? t('bonus_extra_text', { amount: f.money(b.extra_amount) }) : null].filter(Boolean).join(' · ');
  async function saveBonus(reason) {
    try {
      await api.saveDailyBonus(date, isAdmin ? manager : null, bonusEdit, reason);
      toast.ok(t('bonus_saved')); setBonusDraft(null); reload();
    } catch (e) {
      if (e.code === 'RULE_LOCKED' && !reason) { const r = await confirm({ title: t('daily_bonus'), message: t('err_RULE_LOCKED'), requireReason: true }); if (r) saveBonus(r); }
      else toast.error(e);
    }
  }

  const rows = useMemo(() => {
    if (!data) return [];
    const byP = new Map(data.regs.map((r) => [r.promoter_id, r]));
    return data.promoters.map((p) => {
      const ex = byP.get(p.id);
      const orig = { c: ex?.reg_count ?? 0, a: ex?.active_count ?? 0 };
      const e = edits[p.id] || {};
      const c = e.c ?? orig.c; const a = Math.min(e.a ?? orig.a, c);
      // week totals = other days of this week + today's (edited) values
      const others = (data.week_regs || []).filter((w) => w.promoter_id === p.id && w.work_date !== date);
      const wT = others.reduce((s, w) => s + w.reg_count, 0) + c;
      const wA = others.reduce((s, w) => s + w.active_count, 0) + a;
      const week = carEarnings(plan, wT, wA);
      const inc = calcDailyIncentive(data.rule, c, a, diffDays(date, p.start_date), p.manager_id);
      const bonus = calcDailyBonus(bonusFor(p), c, a);
      return { p, ex, orig, c, a, bonus, changed: c !== orig.c || a !== orig.a, countChanged: c !== orig.c, inc, week, prog: bonusProgress(plan, wT, wA),
        locked: data.locked[p.id], beforeStart: date < p.start_date };
    }).filter((r) => (showInactive || r.p.status === 'active' || r.ex) && (!search || r.p.full_name.includes(search) || r.p.phone.includes(search.replace(/\D/g, '') || '§')));
  }, [data, edits, date, showInactive, search, plan, bonusDraft, manager, isAdmin]); // eslint-disable-line

  const changed = rows.filter((r) => r.changed);
  const totals = rows.reduce((s, r) => ({ c: s.c + r.c, a: s.a + r.a, i: s.i + r.inc + r.bonus, b: s.b + r.bonus, w: s.w + (r.bonus > 0 ? 1 : 0) }), { c: 0, a: 0, i: 0, b: 0, w: 0 });
  const needsReason = changed.some((r) => (r.ex && r.countChanged) || r.locked);
  const setVal = (pid, k, v) => setEdits((e) => ({ ...e, [pid]: { ...e[pid], [k]: v } }));

  async function save() {
    let reason = null;
    if (needsReason) {
      reason = await confirm({ title: t('edit_reason_title'), message: t('existing_locked'), requireReason: true, confirmText: t('save_all') });
      if (!reason) return;
    }
    const entries = changed.map((r) => ({ promoter_id: r.p.id, count: r.c, active: r.a, expected_version: r.ex?.version ?? null }));
    const res = await run(() => api.saveRegistrations(date, entries, reason));
    if (res) {
      const newBonus = changed.some((r) => r.week.bonus_applied && !carEarnings(plan, r.week.total - r.c + r.orig.c, r.week.active - r.a + r.orig.a).bonus_applied);
      toast.ok(t('saved')); if (newBonus) celebrate(); setEdits({}); reload();
    }
  }

  const [prevIcon, nextIcon] = dir === 'rtl' ? ['chevR', 'chevL'] : ['chevL', 'chevR'];
  const rule = data?.rule;
  const pct = totals.c ? Math.round((totals.a * 100) / totals.c) : 0;
  return (
    <>
      <PageHead title={t('reg_title')} sub={plan ? t('plan_rule_text', { min: f.num(plan.bonus_min_cars), pct: f.num(plan.bonus_activity_pct), bonus: f.money(plan.bonus_price), reg: f.money(plan.price_registered), act: f.money(plan.price_active) }) : ''}
        actions={<>
          <ManagerFilter value={manager} onChange={setManager} />
          <div className="row" style={{ gap: 6 }}>
            <Button icon={prevIcon} onClick={() => setDate(addDays(date, -1))} aria-label={t('yesterday')} />
            <Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} style={{ width: 160 }} aria-label={t('reg_date')} />
            <Button icon={nextIcon} onClick={() => setDate(addDays(date, 1))} disabled={date >= today} aria-label={t('today')} />
          </div>
        </>} />

      <div className="grid g4 section stagger">
        <div className="card kpi hero"><div className="kpi-label">{f.weekday(date)}</div><div className="kpi-value" style={{ fontSize: '1.2rem' }}>{f.date(date)}</div>
          <div style={{ marginTop: 8 }}>{rule?.is_incentive_day ? <Badge tone="accent">{t('daily_incentive')}: {f.money(rule.per_car_amount)} / {t('cars')}</Badge> : <Badge>{t('no_incentive_day')}</Badge>}</div></div>
        <div className="card kpi"><div className="kpi-label">{t('cars_registered')}</div><div className="kpi-value num">{f.num(totals.c)}</div></div>
        <div className="card kpi" style={{ '--k': '#10b981' }}><div className="row between"><div><div className="kpi-label">{t('active_cars')}</div><div className="kpi-value num">{f.num(totals.a)}</div></div><Ring value={pct} size={58} /></div></div>
        <div className="card kpi" style={{ '--k': '#f59e0b' }}><div className="kpi-label">{t('incentives_bonuses')}</div><div className="kpi-value num" style={{ fontSize: '1.3rem' }}>{f.money(totals.i)}</div>
          {totals.w > 0 && <div className="kpi-foot">🎁 {f.num(totals.w)} {t('employees')} · {f.money(totals.b)}</div>}</div>
      </div>

      <Card glass className="section" title={<span className="row" style={{ gap: 8 }}>🎁 {t('daily_bonus')} {savedBonus?.enabled && !bonusDraft && <span className="bonus-badge">{bonusSummary(savedBonus)}</span>}</span>}
        sub={t('daily_bonus_sub')}>
        {isAdmin && !manager && <div className="hint" style={{ marginBottom: 10 }}>{t('bonus_for_all_mgrs')}</div>}
        <div className="row wrap between" style={{ gap: 12, marginBottom: 12 }}>
          <Switch checked={!!bonusEdit.enabled} onChange={(c) => setBonus({ enabled: c })} label={t('daily_bonus_enable')} />
          <Seg accent value={bonusEdit.applies_to} onChange={(v) => setBonus({ applies_to: v })} options={[{ value: 'all', label: t('count_all') }, { value: 'active', label: t('count_active') }]} />
        </div>
        <div className={`bonus-tiers ${bonusEdit.enabled ? '' : 'off'}`}>
          {BONUS_TIERS.map((n) => (
            <div key={n} className={`bonus-tier ${Number(bonusEdit['tier' + n]) > 0 ? 'set' : ''}`}>
              <div className="tier-head"><span className="tier-num num">{f.num(n)}</span><span className="small">{t('tier_cars', { n: f.num(n) })}</span></div>
              <MoneyInput value={bonusEdit['tier' + n] || null} placeholder="—" onChange={(v) => setBonus({ ['tier' + n]: v ?? 0 })} />
            </div>
          ))}
          <div className={`bonus-tier extra ${bonusEdit.extra_enabled ? 'set' : ''}`}>
            <div className="tier-head"><span className="tier-num">6+</span><Switch checked={!!bonusEdit.extra_enabled} onChange={(c) => setBonus({ extra_enabled: c })} label={t('extra_from_6')} /></div>
            <MoneyInput value={bonusEdit.extra_amount || null} placeholder={t('extra_per_car')} disabled={!bonusEdit.extra_enabled} onChange={(v) => setBonus({ extra_amount: v ?? 0 })} />
          </div>
        </div>
        <div className="hint" style={{ marginTop: 10 }}>{t('bonus_tiers_hint')}</div>
        {bonusDraft && <div className="row end" style={{ marginTop: 12 }}>
          <span className="small muted grow">{bonusEdit.enabled ? bonusSummary(bonusEdit) : t('bonus_off')}</span>
          <Button variant="ghost" onClick={() => setBonusDraft(null)}>{t('reset')}</Button>
          <Button variant="primary" icon="check" onClick={() => saveBonus(null)}
            disabled={bonusEdit.enabled && !BONUS_TIERS.some((n) => Number(bonusEdit['tier' + n]) > 0) && !(bonusEdit.extra_enabled && bonusEdit.extra_amount > 0)}>{t('save_bonus')}</Button>
        </div>}
      </Card>

      <Card className="flush">
        <div className="row wrap between" style={{ padding: 'var(--pad)', gap: 12 }}>
          <SearchBox value={search} onChange={setSearch} placeholder={t('search_promoters')} />
          <span className="hint hide-mobile">{t('active_hint')}</span>
          <Switch checked={showInactive} onChange={setShowInactive} label={`${t('st_inactive')} / ${t('st_terminated')}`} />
        </div>
        {loading && !data ? <SkeletonRows rows={8} /> : error ? <ErrorState error={error} onRetry={reload} /> : !rows.length ? <Empty icon="users" /> : (
          <div className="reg-list">
            {rows.map((r, idx) => (
              <div key={r.p.id} className={`reg-row ${r.changed ? 'changed' : ''}`} style={{ '--i': idx }}>
                <div className="reg-name">
                  <a href={`#/promoters/${r.p.id}`} onClick={(e) => { e.preventDefault(); navigate('/promoters/' + r.p.id); }}>{r.p.full_name}</a>
                  <div className="tiny faint num">{r.p.phone}{r.p.status !== 'active' && <span className="warn"> · {t('st_' + r.p.status)}</span>}</div>
                </div>
                {r.beforeStart ? <span className="tiny faint">{t('err_BEFORE_START_DATE')}</span> : <>
                  <div className="reg-field"><span className="tiny faint">{t('cars_registered')}</span>
                    <Stepper value={r.c} max={settings.max_daily_registrations} changed={r.countChanged} locked={!!r.locked} label={t('cars_registered')}
                      onChange={(v) => setVal(r.p.id, 'c', v)} /></div>
                  <div className="reg-field"><span className="tiny faint">{t('active_cars')}</span>
                    <Stepper value={r.a} max={r.c} changed={r.a !== r.orig.a} locked={!!r.locked} label={t('active_cars')}
                      onChange={(v) => setVal(r.p.id, 'a', Math.min(v, r.c))} /></div>
                </>}
                <div className="reg-week">
                  <div className="row" style={{ gap: 8 }}>
                    <Ring value={r.week.activity_pct} size={40} stroke={4} tone={r.week.bonus_applied ? 'success' : undefined} />
                    <div className="col" style={{ gap: 0 }}>
                      <span className="tiny faint">{t('week_progress')}</span>
                      <b className="small num">{f.num(r.week.total)} {t('cars')} · {f.num(r.week.active)} ✓</b>
                    </div>
                  </div>
                  <div className="tiny" style={{ marginTop: 4 }}>
                    {r.week.bonus_applied ? <Badge tone="green">{t('bonus_reached', { price: f.money(plan?.bonus_price) })}</Badge>
                      : r.prog ? <span className="faint">{r.prog.needCars ? t('bonus_need_cars', { n: f.num(r.prog.needCars) }) : t('bonus_need_active', { n: f.num(r.prog.needActive) })}</span> : null}
                  </div>
                </div>
                <div className="reg-money">
                  <span className="tiny faint">{t('car_earnings')}</span><b className="num">{f.money(r.week.amount)}</b>
                  {r.inc > 0 && <span className="tiny num" style={{ color: 'var(--accent)' }}>+{f.money(r.inc)}</span>}
                  {r.bonus > 0 && <span className="bonus-badge num">🎁 {f.money(r.bonus)}</span>}
                </div>
                <div className="reg-status">
                  {r.locked ? <Badge tone="amber"><Icon name="lock" size={12} /> {t('week_locked_badge')}</Badge>
                    : r.changed ? <Badge tone="accent">{t('changed')}</Badge> : r.ex ? <Badge tone="green">v{r.ex.version}</Badge> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {changed.length > 0 && (
        <div className="actionbar">
          <Icon name="edit" /><b>{t('unsaved_changes')}: {f.num(changed.length)}</b>
          {needsReason && <Badge tone="amber">{t('edit_requires_reason')}</Badge>}
          <span className="grow" />
          <Button variant="ghost" onClick={() => setEdits({})}>{t('reset')}</Button>
          <Button variant="primary" icon="check" loading={busy} onClick={save}>{t('save_all')}</Button>
        </div>
      )}
    </>
  );
}
