// Weekly payroll engine — exact mirror of public.compute_payroll() / calc_car_earnings() in SQL.
//
// Week = Saturday → Friday (paid the following Tuesday). Only the seven days of
// that week are used, so weeks never mix.
//   T = cars registered in the week, A = of those, active (3 trips), R = T − A
//   bonus  (enabled, T > bonus_min_cars, A ≥ bonus_activity_pct% of T) → T × bonus_price
//   else                                                               → R × price_registered + A × price_active
import { weekStartOf, addDays, diffDays } from './dates.js';
import { calcDailyIncentive, calcDailyBonus } from './incentives.js';

export const PAYROLL_CATEGORIES = ['debt_repayment', 'withdrawal', 'advance', 'expense_charge', 'deduction', 'bonus', 'correction'];
export const DEBT_IN = ['opening_debt', 'debt'];
export const DEFAULT_PLAN = { effective_from: '2020-01-04', price_registered: 3000, price_active: 6000, bonus_enabled: true, bonus_price: 15000, bonus_min_cars: 5, bonus_activity_pct: 60 };

export function planForWeek(plans, week) {
  const ws = weekStartOf(week);
  return [...(plans || [])].filter((p) => p.effective_from <= ws).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] || null;
}

export function carEarnings(plan, total, active) {
  const t = Math.max(total || 0, 0);
  const a = Math.min(Math.max(active || 0, 0), t);
  const bonus = !!plan?.bonus_enabled && t > (plan?.bonus_min_cars ?? 5) && a * 100 >= (plan?.bonus_activity_pct ?? 60) * t;
  return {
    total: t, active: a, registered_only: t - a,
    activity_pct: t === 0 ? 0 : Math.round((a * 100) / t),
    bonus_applied: bonus,
    amount: bonus ? t * (plan?.bonus_price ?? 0) : (t - a) * (plan?.price_registered ?? 0) + a * (plan?.price_active ?? 0),
  };
}

/** What a promoter still needs this week to reach the bonus rate (for live hints). */
export function bonusProgress(plan, total, active) {
  if (!plan?.bonus_enabled) return null;
  const needCars = Math.max(0, (plan.bonus_min_cars ?? 5) + 1 - total);
  const t = Math.max(total, (plan.bonus_min_cars ?? 5) + 1);
  const needActive = Math.max(0, Math.ceil(((plan.bonus_activity_pct ?? 60) * t) / 100) - active);
  return { needCars, needActive, reached: needCars === 0 && needActive === 0 };
}

export function computePayroll({ promoter, week, registrations = [], rules = {}, bonuses = {}, ledger = [], plan }) {
  const ws = weekStartOf(week);
  const byDate = new Map(registrations.map((r) => [r.work_date, r]));
  const days = []; let T = 0, A = 0, incentive = 0, dailyBonus = 0;
  for (let i = 0; i < 7; i++) {
    const d = addDays(ws, i);
    const r = byDate.get(d);
    const c = r ? r.reg_count : 0; const a = r ? (r.active_count || 0) : 0;
    const rule = rules[d] ?? null;
    const inc = calcDailyIncentive(rule, c, a, diffDays(d, promoter.start_date), promoter.manager_id);
    const bonusRule = bonuses[d] ?? null; // the promoter's manager's bonus for that date
    const db = calcDailyBonus(bonusRule, c, a);
    T += c; A += a; incentive += inc + db; dailyBonus += db;
    days.push({ date: d, count: c, active: a, incentive: inc, bonus: db, incentive_day: !!rule?.is_incentive_day, rule, bonus_day: !!bonusRule?.enabled, bonus_rule: bonusRule });
  }
  const car = carEarnings(plan, T, A);
  const sums = { bonus: 0, correction: 0, withdrawal: 0, advance: 0, debt_repayment: 0, deduction: 0 };
  const entries = ledger
    .filter((e) => e.status === 'approved' && PAYROLL_CATEGORIES.includes(e.category) && weekStartOf(e.entry_date) === ws)
    .sort((x, y) => x.entry_date.localeCompare(y.entry_date) || String(x.created_at ?? '').localeCompare(String(y.created_at ?? '')) || String(x.id).localeCompare(String(y.id)));
  for (const e of entries) { if (e.category in sums) sums[e.category] += e.amount; else sums.deduction += e.amount; }
  const gross = car.amount + incentive + sums.bonus + Math.max(sums.correction, 0);
  const totalDed = sums.withdrawal + sums.advance + sums.deduction + sums.debt_repayment + Math.max(-sums.correction, 0);
  return {
    promoter_id: promoter.id, manager_id: promoter.manager_id,
    week_start: ws, week_end: addDays(ws, 6), pay_date: addDays(ws, 10),
    reg_count: T, active_count: car.active, registered_only: car.registered_only, activity_pct: car.activity_pct, bonus_applied: car.bonus_applied,
    plan: plan || null,
    base_amount: car.amount, incentive_amount: incentive, daily_bonus_amount: dailyBonus,
    bonus_amount: sums.bonus, correction_amount: sums.correction, withdrawal_amount: sums.withdrawal,
    advance_amount: sums.advance, deduction_amount: sums.deduction, debt_repayment_amount: sums.debt_repayment,
    gross_amount: gross, total_deductions: totalDed, net_amount: gross - totalDed,
    days, entries: entries.map((e) => ({ id: e.id, category: e.category, amount: e.amount, date: e.entry_date, notes: e.notes ?? null })),
    calc_version: 'v3',
  };
}

export function debtBalance(ledger) {
  return ledger.filter((e) => e.status === 'approved').reduce((s, e) =>
    s + (DEBT_IN.includes(e.category) ? e.amount : e.category === 'debt_repayment' ? -e.amount : 0), 0);
}

export function payrollEffective(p, adjustments = [], payments = []) {
  const delta = adjustments.reduce((s, a) => s + a.delta, 0);
  const carried = adjustments.reduce((s, a) => s + (a.carried_to_debt || 0), 0);
  const paid = payments.reduce((s, x) => s + x.amount, 0);
  const effective_payable = p.status === 'pending' ? Math.max(p.net_amount, 0) : p.payable_amount + delta + carried;
  return { adjustments_total: delta, effective_net: p.net_amount + delta, effective_payable, paid_total: paid, outstanding: effective_payable - paid };
}
