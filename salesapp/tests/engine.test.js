// Run: npm test   (uses Node's built-in test runner, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calcDailyIncentive, normalizeRule, emptyRule, calcDailyBonus, emptyBonus } from '../src/engine/incentives.js';
import { computePayroll, debtBalance, payrollEffective, carEarnings, planForWeek, bonusProgress } from '../src/engine/payroll.js';
import { weekStartOf, weekEndOf, payDateOf, payrollMonthOf, payrollWeeksOfMonth, eachDay, addDays, baghdadToday } from '../src/engine/dates.js';
import { toIQD, formatIQD } from '../src/engine/money.js';

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/engine_cases.json', import.meta.url)));

test('weekly car earnings (shared with SQL parity)', () => {
  for (const c of F.car_cases) {
    const r = carEarnings(F.plans[c.plan], c.total, c.active);
    assert.equal(r.amount, c.amount, JSON.stringify(c));
    assert.equal(r.bonus_applied, c.bonus, JSON.stringify(c));
    assert.equal(r.activity_pct, c.pct, JSON.stringify(c));
  }
});

test('daily incentive cases (shared with SQL parity)', () => {
  for (const c of F.incentive_cases) {
    const rule = c.rule ? normalizeRule(F.rules[c.rule]) : null;
    assert.equal(calcDailyIncentive(rule, c.count, c.active, c.tenure, c.manager), c.expected, JSON.stringify(c));
  }
});

test('manager daily bonus cases (shared with SQL parity)', () => {
  for (const c of F.bonus_cases) assert.equal(calcDailyBonus(c.rule ? F.bonus_rules[c.rule] : null, c.count, c.active), c.expected, JSON.stringify(c));
  for (let n = 0; n < 20; n++) assert.equal(calcDailyBonus(emptyBonus(), n, n), 0, 'disabled by default, no preset amount');
});

test('no incentive amounts are invented: default rule pays nothing', () => {
  const r = normalizeRule(emptyRule());
  for (let n = 0; n < 20; n++) assert.equal(calcDailyIncentive(r, n, n, 999, null), 0);
});

test('rule validation rejects bad input', () => {
  assert.throws(() => normalizeRule({ per_car_amount: -1 }), /INVALID_RULE/);
  assert.throws(() => normalizeRule({ per_car_amount: 1.5 }), /INVALID_RULE/);
  assert.throws(() => normalizeRule({ min_cars: 0 }), /INVALID_RULE/);
  assert.throws(() => normalizeRule({ applies_to: 'x' }), /INVALID_RULE/);
});

test('plan selection by week start; bonus progress hints', () => {
  const plans = [F.plans.default, { ...F.plans.default, effective_from: '2026-11-14', price_active: 7000 }];
  assert.equal(planForWeek(plans, '2026-11-13').price_active, 6000);
  assert.equal(planForWeek(plans, '2026-11-14').price_active, 7000);
  assert.equal(planForWeek(plans, '2026-11-20').price_active, 7000);
  assert.deepEqual(bonusProgress(F.plans.default, 4, 4), { needCars: 2, needActive: 0, reached: false });
  assert.deepEqual(bonusProgress(F.plans.default, 6, 2), { needCars: 0, needActive: 2, reached: false });
  assert.deepEqual(bonusProgress(F.plans.default, 6, 4), { needCars: 0, needActive: 0, reached: true });
});

test('payroll weeks: Saturday→Friday, paid next Tuesday, month by Friday', () => {
  for (const c of F.date_cases) {
    assert.equal(weekStartOf(c.date), c.week_start, c.date);
    assert.equal(weekEndOf(c.date), c.week_end, c.date);
    assert.equal(payDateOf(c.date), c.pay_date, c.date);
    assert.equal(payrollMonthOf(c.date), c.payroll_month, c.date);
  }
});

test('every day of several years maps to exactly one week and one payroll month', () => {
  const seen = new Map();
  for (const d of eachDay('2025-01-01', '2028-12-31')) {
    const ws = weekStartOf(d);
    assert.equal(new Date(ws + 'T00:00:00Z').getUTCDay(), 6, 'week starts Saturday');
    assert.ok(d >= ws && d <= addDays(ws, 6));
    if (!seen.has(ws)) seen.set(ws, 0);
    seen.set(ws, seen.get(ws) + 1);
  }
  for (const [ws, n] of seen) if (ws > '2025-01-01' && ws < '2028-12-20') assert.equal(n, 7, ws);
  // Monthly cycles: each week appears in exactly one month; 4 or 5 weeks per month.
  const all = new Set();
  for (let y = 2025; y <= 2028; y++) for (let m = 1; m <= 12; m++) {
    const weeks = payrollWeeksOfMonth(`${y}-${String(m).padStart(2, '0')}`);
    assert.ok(weeks.length === 4 || weeks.length === 5);
    for (const w of weeks) { assert.ok(!all.has(w.week_start), 'no duplicate week'); all.add(w.week_start); }
  }
  // consecutive: no gaps
  const sorted = [...all].sort();
  for (let i = 1; i < sorted.length; i++) assert.equal(addDays(sorted[i - 1], 7), sorted[i]);
});

test('payroll computation (shared with SQL parity)', () => {
  const c = F.payroll_case;
  const rules = Object.fromEntries(Object.entries(c.rules).map(([d, k]) => [d, normalizeRule(F.rules[k])]));
  const bonuses = Object.fromEntries(Object.entries(c.bonuses || {}).map(([d, k]) => [d, F.bonus_rules[k]]));
  const out = computePayroll({ promoter: c.promoter, week: c.week, registrations: c.registrations, rules, bonuses, ledger: c.ledger, plan: F.plans[c.plan] });
  for (const [k, v] of Object.entries(c.expected)) assert.equal(out[k], v, k);
  assert.equal(out.days.length, 7);
  assert.equal(out.days[0].date, '2026-11-07');
  assert.equal(out.days[6].date, '2026-11-13');
  // registrations of other weeks never leak in
  assert.ok(!out.days.some((d) => d.date === '2026-11-06' || d.date === '2026-11-14'));
  // void / pending / non-payroll entries excluded
  assert.deepEqual(out.entries.map((e) => e.id).sort(), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7']);
  // determinism
  assert.deepEqual(out, computePayroll({ promoter: c.promoter, week: '2026-11-13', registrations: [...c.registrations].reverse(), rules, bonuses, ledger: [...c.ledger].reverse(), plan: F.plans[c.plan] }));
});

test('all amounts are integers', () => {
  const c = F.payroll_case;
  const rules = Object.fromEntries(Object.entries(c.rules).map(([d, k]) => [d, normalizeRule(F.rules[k])]));
  const bonuses = Object.fromEntries(Object.entries(c.bonuses || {}).map(([d, k]) => [d, F.bonus_rules[k]]));
  const out = computePayroll({ promoter: c.promoter, week: c.week, registrations: c.registrations, rules, bonuses, ledger: c.ledger, plan: F.plans[c.plan] });
  for (const k of Object.keys(c.expected)) if (typeof out[k] === 'number') assert.ok(Number.isSafeInteger(out[k]), k);
});

test('debt balance keeps old debt separate from withdrawals', () => {
  const l = [
    { category: 'opening_debt', amount: 200000, status: 'approved' },
    { category: 'debt', amount: 50000, status: 'approved' },
    { category: 'debt_repayment', amount: 30000, status: 'approved' },
    { category: 'withdrawal', amount: 40000, status: 'approved' },
    { category: 'debt', amount: 70000, status: 'void' },
  ];
  assert.equal(debtBalance(l), 220000);
});

test('effective payroll figures with adjustment and payments', () => {
  const p = { status: 'adjusted', net_amount: 100000, payable_amount: 100000 };
  const e = payrollEffective(p, [{ delta: -20000, carried_to_debt: 0 }], [{ amount: 100000 }]);
  assert.equal(e.effective_net, 80000);
  assert.equal(e.outstanding, -20000);
  const e2 = payrollEffective(p, [{ delta: -20000, carried_to_debt: 20000 }], [{ amount: 100000 }]);
  assert.equal(e2.outstanding, 0);
  const neg = payrollEffective({ status: 'pending', net_amount: -5000, payable_amount: 0 });
  assert.equal(neg.outstanding, 0);
});

test('money parsing accepts Arabic digits and rejects decimals', () => {
  assert.equal(toIQD('١٥٬٠٠٠'), 15000);
  assert.equal(toIQD('15,000'), 15000);
  assert.throws(() => toIQD('15.5'));
  assert.throws(() => toIQD(1.5));
  assert.match(formatIQD(15000, 'en'), /15,000 IQD/);
});

test('Baghdad date is UTC+3', () => {
  assert.equal(baghdadToday(new Date('2026-11-11T21:30:00Z')), '2026-11-12');
  assert.equal(baghdadToday(new Date('2026-11-11T20:59:00Z')), '2026-11-11');
});
