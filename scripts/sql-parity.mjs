// Generates SQL asserting the database engine returns exactly the same results as
// the JS engine for the shared fixtures. Runs in a rolled-back transaction.
//   node scripts/sql-parity.mjs | psql -v ON_ERROR_STOP=1 "$DATABASE_URL"
import fs from 'node:fs';

const F = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/engine_cases.json', import.meta.url)));
const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v) => (v === null ? 'null' : `${q(JSON.stringify(v))}::jsonb`);
const out = ['begin;',
  `create or replace function pg_temp.check(label text, got anyelement, want anyelement) returns void language plpgsql as $$
begin if got is distinct from want then raise exception 'PARITY FAIL %: got % want %', label, got, want; end if; end $$;`];

F.car_cases.forEach((c, i) => {
  const call = `public.calc_car_earnings(${j(F.plans[c.plan])}, ${c.total}, ${c.active})`;
  out.push(`select pg_temp.check('car#${i}.amount', (${call}->>'amount')::bigint, ${c.amount}::bigint);`);
  out.push(`select pg_temp.check('car#${i}.bonus', (${call}->>'bonus_applied')::boolean, ${c.bonus});`);
  out.push(`select pg_temp.check('car#${i}.pct', (${call}->>'activity_pct')::int, ${c.pct});`);
});
F.incentive_cases.forEach((c, i) => {
  const rule = c.rule ? `public.normalize_incentive_rule(${j(F.rules[c.rule])})` : 'null::jsonb';
  out.push(`select pg_temp.check('incentive#${i}', public.calc_daily_incentive(${rule}, ${c.count}, ${c.active}, ${c.tenure}, ${c.manager ? q(c.manager) + '::uuid' : 'null'}), ${c.expected}::bigint);`);
});
F.bonus_cases.forEach((c, i) => {
  out.push(`select pg_temp.check('bonus#${i}', public.calc_daily_bonus(${c.rule ? j(F.bonus_rules[c.rule]) : 'null::jsonb'}, ${c.count}, ${c.active}), ${c.expected}::bigint);`);
});
F.date_cases.forEach((c, i) => {
  out.push(`select pg_temp.check('week_start#${i}', public.week_start_of('${c.date}'), '${c.week_start}'::date);`);
  out.push(`select pg_temp.check('week_end#${i}', public.week_end_of('${c.date}'), '${c.week_end}'::date);`);
  out.push(`select pg_temp.check('pay_date#${i}', public.pay_date_of('${c.date}'), '${c.pay_date}'::date);`);
  out.push(`select pg_temp.check('month#${i}', public.payroll_month_of('${c.date}'), '${c.payroll_month}'::date);`);
});

const P = F.payroll_case; const mgr = P.promoter.manager_id; const plan = F.plans[P.plan];
out.push(`delete from public.pricing_plans;`);
out.push(`insert into public.pricing_plans (effective_from, price_registered, price_active, bonus_enabled, bonus_price, bonus_min_cars, bonus_activity_pct)
  values ('${plan.effective_from}', ${plan.price_registered}, ${plan.price_active}, ${plan.bonus_enabled}, ${plan.bonus_price}, ${plan.bonus_min_cars}, ${plan.bonus_activity_pct});`);
out.push(`insert into auth.users (id, email, raw_app_meta_data) values ('${mgr}', 'parity@test.local', '{"status":"active"}');`);
out.push(`insert into public.promoters (id, manager_id, full_name, phone, start_date) values ('${P.promoter.id}', '${mgr}', 'Parity', '07700000999', '${P.promoter.start_date}');`);
for (const r of P.registrations) {
  out.push(`insert into public.registrations (promoter_id, manager_id, work_date, reg_count, active_count, rate) values ('${P.promoter.id}', '${mgr}', '${r.work_date}', ${r.reg_count}, ${r.active_count}, 0);`);
}
for (const [d, k] of Object.entries(P.rules)) {
  out.push(`insert into public.incentive_rules (work_date, is_incentive_day, per_car_amount, applies_to, min_cars, min_tenure_days)
    select '${d}', (n->>'is_incentive_day')::boolean, (n->>'per_car_amount')::bigint, n->>'applies_to', (n->>'min_cars')::int, (n->>'min_tenure_days')::int
      from (select public.normalize_incentive_rule(${j(F.rules[k])}) n) s;`);
}
for (const [d, k] of Object.entries(P.bonuses || {})) {
  const b = F.bonus_rules[k];
  out.push(`insert into public.daily_bonuses (work_date, manager_id, enabled, amount, tier2, tier3, tier4, tier5, extra_enabled, extra_amount, applies_to) values ('${d}', '${mgr}', ${b.enabled}, 0, ${b.tier2}, ${b.tier3}, ${b.tier4}, ${b.tier5}, ${b.extra_enabled}, ${b.extra_amount}, '${b.applies_to}');`);
}
P.ledger.forEach((e, i) => {
  out.push(`insert into public.ledger_entries (promoter_id, manager_id, entry_date, category, amount, status, created_at) values ('${P.promoter.id}', '${mgr}', '${e.entry_date}', '${e.category}', ${e.amount}, '${e.status}', now() + interval '${i} second');`);
});
out.push(`create temp table parity_out as select public.compute_payroll('${P.promoter.id}', '${P.week}') c;`);
for (const [k, v] of Object.entries(P.expected)) out.push(`select pg_temp.check('payroll.${k}', (select c->>'${k}' from parity_out), ${q(String(v))});`);
out.push(`select pg_temp.check('payroll.days', (select jsonb_array_length(c->'days') from parity_out), 7);`);
out.push(`select pg_temp.check('payroll.entries', (select jsonb_array_length(c->'entries') from parity_out), 7);`);
out.push(`\\echo 'SQL/JS parity: ${F.car_cases.length} car-pricing, ${F.incentive_cases.length} incentive, ${F.bonus_cases.length} daily-bonus, ${F.date_cases.length} date cases and the payroll week all match'`);
out.push('rollback;');
console.log(out.join('\n'));
