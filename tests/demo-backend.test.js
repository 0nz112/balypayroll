// The browser demo backend must enforce the same business rules as the database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const { createDemoBackend } = await import('../src/lib/backend.demo.js');
const { weekStartOf, addDays, baghdadToday } = await import('../src/engine/dates.js');

const api = createDemoBackend();
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code || (console.error(e), false));

test('demo seed + dashboard', async () => {
  const t0 = Date.now();
  await api.signIn('admin@demo.iq');
  assert.ok(Date.now() - t0 < 5000, 'seed is fast');
  const T = baghdadToday();
  const d = await api.getDashboard(addDays(T, -29), T);
  assert.ok(d.kpis.range_registrations > 0);
  assert.equal(d.managers.length, 3);
  assert.equal(d.series.length, 30);
});

test('isolation and duplicate protection', async () => {
  await api.signIn('karrar@demo.iq');
  const mine = await api.listPromoters();
  assert.equal(mine.length, 5);
  await api.signIn('noor@demo.iq');
  const other = await api.listPromoters();
  assert.ok(other.every((p) => p.manager_id === 'demo-m2'));
  await rejects(api.getPromoter(mine[0].id), 'FORBIDDEN');
  await api.signIn('karrar@demo.iq');
  const T = baghdadToday();
  const day = await api.getDay(T);
  const target = day.promoters.find((p) => p.status === 'active');
  const existing = day.regs.find((r) => r.promoter_id === target.id);
  const cur = existing?.reg_count ?? 0;
  await api.saveRegistrations(T, [{ promoter_id: target.id, count: cur + 1 }], existing ? 'تصحيح' : null);
  await rejects(api.saveRegistrations(T, [{ promoter_id: target.id, count: cur + 2 }]), 'DUPLICATE_ENTRY');
  await rejects(api.saveRegistrations(addDays(T, 1), [{ promoter_id: target.id, count: 1 }]), 'FUTURE_DATE');
});

test('locked week, payment, adjustment', async () => {
  await api.signIn('karrar@demo.iq');
  const T = baghdadToday();
  const lastWs = addDays(weekStartOf(T), -7);
  const rows = await api.listPayrolls({ weekStart: lastWs });
  assert.ok(rows.length > 0 && rows.every((r) => r.status === 'approved'));
  const p = rows[0];
  await rejects(api.addLedgerEntry({ promoter_id: p.promoter_id, category: 'withdrawal', amount: 1000, entry_date: addDays(lastWs, 2) }), 'WEEK_LOCKED');
  await rejects(api.payPayroll(p.id, { amount: p.outstanding + 1, method: 'cash' }), 'OVERPAYMENT');
  await api.payPayroll(p.id, { method: 'cash', key: 'k1' });
  assert.deepEqual(await api.payPayroll(p.id, { method: 'cash', key: 'k1' }), { duplicate: true });
  const after = (await api.getPayroll(p.id)).payroll;
  assert.equal(after.status, 'paid'); assert.equal(after.outstanding, 0);
  await api.saveRegistrations(addDays(lastWs, 1), [{ promoter_id: p.promoter_id, count: 20 }], 'تسجيل متأخر');
  assert.equal((await api.getPayroll(p.id)).payroll.needs_recalc, true);
  const adj = await api.adjustPayroll(p.id, 'تسوية');
  assert.notEqual(adj.delta, 0);
  const fin = (await api.getPayroll(p.id)).payroll;
  assert.equal(fin.status, 'adjusted'); assert.equal(fin.net_amount, after.net_amount); // paid record never overwritten
  if (adj.delta > 0) assert.equal(fin.outstanding, adj.delta);
  else { assert.equal(fin.outstanding, 0); assert.equal(adj.carried_to_debt, -adj.delta); } // overpaid → posted as debt
});

test('incentive rules are admin-only and validated', async () => {
  await api.signIn('karrar@demo.iq');
  await rejects(api.saveRule([baghdadToday()], { is_incentive_day: true }), 'FORBIDDEN');
  await api.signIn('admin@demo.iq');
  await rejects(api.saveRule([baghdadToday()], { per_car_amount: -1 }), 'INVALID_RULE');
  const lastWs = addDays(weekStartOf(baghdadToday()), -7);
  await rejects(api.saveRule([lastWs], { is_incentive_day: true }), 'RULE_LOCKED');
});

test('car pricing: weekly bonus rate and status updates', async () => {
  await api.signIn('karrar@demo.iq');
  const T = baghdadToday();
  const ws = weekStartOf(T);
  const day = await api.getDay(T);
  const p = day.promoters.find((x) => x.status === 'active');
  const ex = day.regs.find((r) => r.promoter_id === p.id);
  // status-only change (active count) needs no reason
  if (ex && ex.reg_count > 0) {
    const r = await api.saveRegistrations(T, [{ promoter_id: p.id, count: ex.reg_count, active: Math.max(0, ex.active_count === 0 ? 1 : ex.active_count - 1) }]);
    assert.equal(r[0].action, 'updated');
  }
  await rejects(api.saveRegistrations(T, [{ promoter_id: p.id, count: 1, active: 2 }], 'x reason'), 'INVALID_ACTIVE');
  const pay = (await api.listPayrolls({ weekStart: ws })).find((x) => x.promoter_id === p.id);
  if (pay) {
    const expectBonus = pay.reg_count > 5 && pay.active_count * 100 >= 60 * pay.reg_count;
    assert.equal(pay.bonus_applied, expectBonus);
    assert.equal(pay.base_amount, expectBonus ? pay.reg_count * 15000 : (pay.reg_count - pay.active_count) * 3000 + pay.active_count * 6000);
  }
  await api.signIn('admin@demo.iq');
  await rejects(api.savePlan({ effective_from: addDays(ws, -7), price_registered: 3000, price_active: 7000, bonus_price: 15000, bonus_min_cars: 5, bonus_activity_pct: 60 }), 'PLAN_LOCKED');
  await api.savePlan({ effective_from: T, price_registered: 3000, price_active: 7000, bonus_price: 15000, bonus_min_cars: 5, bonus_activity_pct: 60 });
  assert.equal((await api.listPlans())[0].price_active, 7000);
  const debts = await api.listDebtEntries({});
  assert.ok(debts.every((d) => ['opening_debt', 'debt', 'debt_repayment'].includes(d.category)));
});

test('manager daily bonus + inventory report', async () => {
  await api.signIn('noor@demo.iq');
  const T = baghdadToday();
  await rejects(api.saveDailyBonus(T, null, { enabled: true, tier2: -5 }), 'VALIDATION');
  assert.equal(await api.saveDailyBonus(T, 'demo-m1', { enabled: true, tier2: 3000, tier3: 3000, tier4: 3000, tier5: 4000, extra_enabled: true, extra_amount: 500, applies_to: 'all' }), 1); // forced to own team
  const day = await api.getDay(T);
  assert.ok(day.bonuses.length === 1 && day.bonuses[0].manager_id === 'demo-m2');
  const p = day.promoters.find((x) => x.status === 'active');
  const ex = day.regs.find((r) => r.promoter_id === p.id);
  if (!ex) await api.saveRegistrations(T, [{ promoter_id: p.id, count: 5, active: 0 }]);
  else await api.saveRegistrations(T, [{ promoter_id: p.id, count: 5, active: 0 }], 'اختبار');
  const pay = (await api.listPayrolls({ weekStart: weekStartOf(T) })).find((x) => x.promoter_id === p.id);
  assert.equal(pay.daily_bonus_amount, 4000, '5 cars → 5-car amount only');
  const inv = await api.inventoryReport(addDays(T, -6), T);
  assert.ok(inv.promoters.every((x) => x.manager_id === 'demo-m2'));
  assert.ok(inv.days.some((d) => d.promoter_id === p.id && d.date === T && d.bonus === 4000));
  await api.saveRegistrations(T, [{ promoter_id: p.id, count: 8, active: 0 }], 'اختبار');
  const pay8 = (await api.listPayrolls({ weekStart: weekStartOf(T) })).find((x) => x.promoter_id === p.id);
  assert.equal(pay8.daily_bonus_amount, 4000 + 3 * 500, '6th–8th cars add the extra amount');
  await api.signIn('karrar@demo.iq'); const other = (await api.listPromoters())[0].id;
  await api.signIn('noor@demo.iq');
  await rejects(api.inventoryReport(T, T, null, other), 'FORBIDDEN');
});
