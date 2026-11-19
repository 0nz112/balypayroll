-- =====================================================================
-- Car pricing model (replaces per-registration base rate + tier incentives)
--
-- Daily entry per promoter: reg_count (cars registered that day) and
-- active_count (how many of those cars became active = completed 3 trips).
--
-- Weekly earnings per promoter (week = Saturday → Friday, paid Tuesday):
--   T = cars in the week, A = active cars in the week, R = T − A
--   if bonus enabled and T > bonus_min_cars and A ≥ bonus_activity_pct% of T
--        car earnings = T × bonus_price                  (e.g. 15,000 for every car)
--   else car earnings = R × price_registered + A × price_active   (e.g. 3,000 / 6,000)
-- Prices come from pricing_plans (effective from a week start), so changing
-- prices never rewrites earlier weeks.
--
-- Daily incentives: per calendar date, an amount per car registered that day
-- (all cars or active cars only), optionally from a minimum number of cars.
-- Each week is computed only from its own seven days — weeks never mix.
-- =====================================================================

-- ---------------------------------------------------------------- pricing plans
create table if not exists public.pricing_plans (
  id                  uuid primary key default gen_random_uuid(),
  effective_from      date not null unique check (extract(dow from effective_from) = 6),
  price_registered    bigint not null check (price_registered >= 0),
  price_active        bigint not null check (price_active >= 0),
  bonus_enabled       boolean not null default true,
  bonus_price         bigint not null check (bonus_price >= 0),
  bonus_min_cars      int not null default 5 check (bonus_min_cars >= 0),
  bonus_activity_pct  int not null default 60 check (bonus_activity_pct between 0 and 100),
  notes               text,
  updated_by          uuid references public.profiles(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
insert into public.pricing_plans (effective_from, price_registered, price_active, bonus_enabled, bonus_price, bonus_min_cars, bonus_activity_pct, notes)
values (date '2020-01-04', 3000, 6000, true, 15000, 5, 60, 'التسعير الأساسي')
on conflict (effective_from) do nothing;

alter table public.pricing_plans enable row level security;
revoke all on public.pricing_plans from anon, authenticated;
grant select on public.pricing_plans to authenticated;
drop policy if exists pricing_plans_select on public.pricing_plans;
create policy pricing_plans_select on public.pricing_plans for select to authenticated using (public.my_role() is not null);
drop trigger if exists audit_pricing_plans on public.pricing_plans;
create trigger audit_pricing_plans after insert or update or delete on public.pricing_plans for each row execute function public.tg_audit();
drop trigger if exists updated_pricing_plans on public.pricing_plans;
create trigger updated_pricing_plans before update on public.pricing_plans for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------- columns
alter table public.registrations add column if not exists active_count int not null default 0;
alter table public.registrations drop constraint if exists registrations_active_le_total;
alter table public.registrations add constraint registrations_active_le_total check (active_count >= 0 and active_count <= reg_count);
alter table public.registrations alter column rate set default 0;

alter table public.registration_history add column if not exists old_active int;
alter table public.registration_history add column if not exists new_active int;

alter table public.incentive_rules add column if not exists per_car_amount bigint not null default 0;
alter table public.incentive_rules add column if not exists applies_to text not null default 'all';
alter table public.incentive_rules add column if not exists min_cars int not null default 1;
alter table public.incentive_rules drop constraint if exists incentive_rules_new_fields;
alter table public.incentive_rules add constraint incentive_rules_new_fields
  check (per_car_amount >= 0 and applies_to in ('all', 'active') and min_cars >= 1);

alter table public.payrolls add column if not exists active_count int not null default 0;
alter table public.payrolls add column if not exists bonus_applied boolean not null default false;

-- ---------------------------------------------------------------- engine
create or replace function public.plan_for_week(p_week date) returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(pp) - array['created_at','updated_at','updated_by','id']
    from public.pricing_plans pp
   where pp.effective_from <= public.week_start_of(p_week)
   order by pp.effective_from desc limit 1
$$;

-- Weekly car earnings (mirrored by src/engine/payroll.js → carEarnings)
create or replace function public.calc_car_earnings(p_plan jsonb, p_total int, p_active int) returns jsonb
language plpgsql immutable as $$
declare
  t int := greatest(coalesce(p_total, 0), 0);
  a int := least(greatest(coalesce(p_active, 0), 0), greatest(coalesce(p_total, 0), 0));
  bonus boolean;
begin
  bonus := coalesce((p_plan->>'bonus_enabled')::boolean, false)
           and t > coalesce((p_plan->>'bonus_min_cars')::int, 5)
           and a * 100 >= coalesce((p_plan->>'bonus_activity_pct')::int, 60) * t;
  return jsonb_build_object(
    'total', t, 'active', a, 'registered_only', t - a,
    'activity_pct', case when t = 0 then 0 else round(a * 100.0 / t)::int end,
    'bonus_applied', bonus,
    'amount', case when bonus then t::bigint * coalesce((p_plan->>'bonus_price')::bigint, 0)
                   else (t - a)::bigint * coalesce((p_plan->>'price_registered')::bigint, 0)
                        + a::bigint * coalesce((p_plan->>'price_active')::bigint, 0) end);
end $$;

-- Daily incentive for one promoter-day (mirrored by src/engine/incentives.js)
create or replace function public.calc_daily_incentive(p_rule jsonb, p_count int, p_active int, p_tenure_days int, p_manager uuid)
returns bigint language plpgsql immutable as $$
declare units int;
begin
  if p_rule is null or coalesce(p_count, 0) <= 0 then return 0; end if;
  if not coalesce((p_rule->>'is_incentive_day')::boolean, false) then return 0; end if;
  if jsonb_typeof(p_rule->'manager_ids') = 'array' and jsonb_array_length(p_rule->'manager_ids') > 0
     and not coalesce((p_rule->'manager_ids') ? coalesce(p_manager::text, ''), false) then return 0; end if;
  if coalesce(p_tenure_days, 0) < coalesce((p_rule->>'min_tenure_days')::int, 0) then return 0; end if;
  if p_count < coalesce((p_rule->>'min_cars')::int, 1) then return 0; end if;
  units := case when p_rule->>'applies_to' = 'active' then least(coalesce(p_active, 0), p_count) else p_count end;
  return units::bigint * coalesce((p_rule->>'per_car_amount')::bigint, 0);
end $$;

create or replace function public.normalize_incentive_rule(p jsonb) returns jsonb
language plpgsql immutable as $$
declare v_amt text; v_min text; v_ten text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then perform public.raise_app('INVALID_RULE', 'payload'); end if;
  v_amt := coalesce(p->>'per_car_amount', '0'); v_min := coalesce(p->>'min_cars', '1'); v_ten := coalesce(p->>'min_tenure_days', '0');
  if not public.is_int_text(v_amt) or v_amt::bigint < 0 then perform public.raise_app('INVALID_RULE', 'per_car_amount'); end if;
  if not public.is_int_text(v_min) or v_min::int < 1 then perform public.raise_app('INVALID_RULE', 'min_cars'); end if;
  if not public.is_int_text(v_ten) or v_ten::int < 0 then perform public.raise_app('INVALID_RULE', 'min_tenure_days'); end if;
  if coalesce(p->>'applies_to', 'all') not in ('all', 'active') then perform public.raise_app('INVALID_RULE', 'applies_to'); end if;
  return jsonb_build_object(
    'is_incentive_day', coalesce((p->>'is_incentive_day')::boolean, false),
    'per_car_amount', v_amt::bigint, 'applies_to', coalesce(p->>'applies_to', 'all'), 'min_cars', v_min::int,
    'min_tenure_days', v_ten::int,
    'manager_ids', case when jsonb_typeof(p->'manager_ids') = 'array' and jsonb_array_length(p->'manager_ids') > 0 then p->'manager_ids' else null end,
    'notes', p->>'notes');
end $$;

drop function if exists public.preview_incentive(jsonb, int[], int, uuid);
drop function if exists public.calc_incentive(jsonb, int, int, uuid);

create or replace function public.compute_payroll(p_promoter uuid, p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ws date := public.week_start_of(p_week);
  v_we date := public.week_start_of(p_week) + 6;
  v_p record; r record; v_rule jsonb; v_inc bigint; v_plan jsonb; v_car jsonb;
  v_days jsonb := '[]'::jsonb; v_entries jsonb := '[]'::jsonb;
  v_t int := 0; v_a int := 0; v_incent bigint := 0; v_base bigint;
  v_bonus bigint := 0; v_corr bigint := 0; v_wd bigint := 0; v_adv bigint := 0; v_ded bigint := 0; v_debt bigint := 0;
  v_gross bigint; v_tded bigint;
begin
  select id, manager_id, start_date into v_p from public.promoters where id = p_promoter;
  if not found then perform public.raise_app('NOT_FOUND', 'promoter'); end if;
  v_plan := public.plan_for_week(v_ws);

  for r in
    select g.d::date as d, coalesce(reg.reg_count, 0) as c, coalesce(reg.active_count, 0) as a
      from generate_series(v_ws::timestamp, v_we::timestamp, interval '1 day') g(d)
      left join public.registrations reg on reg.promoter_id = p_promoter and reg.work_date = g.d::date
     order by 1
  loop
    v_rule := null;
    select to_jsonb(ir) - array['created_at','updated_at','updated_by','tiers','extra_enabled','extra_amount','extra_basis','include_top_tier']
      into v_rule from public.incentive_rules ir where ir.work_date = r.d;
    v_inc := public.calc_daily_incentive(v_rule, r.c, r.a, r.d - v_p.start_date, v_p.manager_id);
    v_t := v_t + r.c; v_a := v_a + r.a; v_incent := v_incent + v_inc;
    v_days := v_days || jsonb_build_object('date', r.d, 'count', r.c, 'active', r.a, 'incentive', v_inc,
      'incentive_day', coalesce((v_rule->>'is_incentive_day')::boolean, false), 'rule', v_rule);
  end loop;
  v_car := public.calc_car_earnings(v_plan, v_t, v_a);
  v_base := (v_car->>'amount')::bigint;

  for r in
    select id, category, amount, entry_date, notes from public.ledger_entries
     where promoter_id = p_promoter and week_start = v_ws and status = 'approved'
       and category in ('debt_repayment','withdrawal','advance','expense_charge','deduction','bonus','correction')
     order by entry_date, created_at, id
  loop
    case r.category
      when 'bonus' then v_bonus := v_bonus + r.amount;
      when 'correction' then v_corr := v_corr + r.amount;
      when 'withdrawal' then v_wd := v_wd + r.amount;
      when 'advance' then v_adv := v_adv + r.amount;
      when 'debt_repayment' then v_debt := v_debt + r.amount;
      else v_ded := v_ded + r.amount;
    end case;
    v_entries := v_entries || jsonb_build_object('id', r.id, 'category', r.category, 'amount', r.amount, 'date', r.entry_date, 'notes', r.notes);
  end loop;

  v_gross := v_base + v_incent + v_bonus + greatest(v_corr, 0);
  v_tded := v_wd + v_adv + v_ded + v_debt + greatest(-v_corr, 0);
  return jsonb_build_object(
    'promoter_id', p_promoter, 'manager_id', v_p.manager_id,
    'week_start', v_ws, 'week_end', v_we, 'pay_date', v_ws + 10,
    'reg_count', v_t, 'active_count', v_a, 'registered_only', v_t - v_a,
    'activity_pct', (v_car->>'activity_pct')::int, 'bonus_applied', (v_car->>'bonus_applied')::boolean,
    'plan', v_plan,
    'base_amount', v_base, 'incentive_amount', v_incent,
    'bonus_amount', v_bonus, 'correction_amount', v_corr, 'withdrawal_amount', v_wd,
    'advance_amount', v_adv, 'deduction_amount', v_ded, 'debt_repayment_amount', v_debt,
    'gross_amount', v_gross, 'total_deductions', v_tded, 'net_amount', v_gross - v_tded,
    'days', v_days, 'entries', v_entries, 'calc_version', 'v2');
end $$;

create or replace function public.refresh_payroll(p_promoter uuid, p_week date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c jsonb; v_id uuid; v_status public.payroll_status;
begin
  c := public.compute_payroll(p_promoter, p_week);
  select id, status into v_id, v_status from public.payrolls
   where promoter_id = p_promoter and week_start = (c->>'week_start')::date for update;
  if v_id is null then
    if (c->>'reg_count')::int = 0 and jsonb_array_length(c->'entries') = 0 then return null; end if;
    insert into public.payrolls (promoter_id, manager_id, week_start) values
      (p_promoter, (c->>'manager_id')::uuid, (c->>'week_start')::date) returning id into v_id;
    v_status := 'pending';
  end if;
  if v_status = 'pending' then
    update public.payrolls set
      reg_count = (c->>'reg_count')::int, active_count = (c->>'active_count')::int, bonus_applied = (c->>'bonus_applied')::boolean,
      base_amount = (c->>'base_amount')::bigint, incentive_amount = (c->>'incentive_amount')::bigint, bonus_amount = (c->>'bonus_amount')::bigint,
      correction_amount = (c->>'correction_amount')::bigint, withdrawal_amount = (c->>'withdrawal_amount')::bigint,
      advance_amount = (c->>'advance_amount')::bigint, deduction_amount = (c->>'deduction_amount')::bigint,
      debt_repayment_amount = (c->>'debt_repayment_amount')::bigint, gross_amount = (c->>'gross_amount')::bigint,
      total_deductions = (c->>'total_deductions')::bigint, net_amount = (c->>'net_amount')::bigint,
      payable_amount = greatest((c->>'net_amount')::bigint, 0), snapshot = c, calc_version = 'v2',
      needs_recalc = false, computed_at = now()
    where id = v_id;
  elsif (c->>'net_amount')::bigint is distinct from (
        select net_amount + coalesce((select sum(delta) from public.payroll_adjustments a where a.payroll_id = v_id), 0)
          from public.payrolls where id = v_id) then
    update public.payrolls set needs_recalc = true where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.tg_payroll_guard() returns trigger
language plpgsql as $$
declare
  cols text[] := array['reg_count','active_count','bonus_applied','base_amount','incentive_amount','bonus_amount','correction_amount',
    'withdrawal_amount','advance_amount','deduction_amount','debt_repayment_amount','gross_amount',
    'total_deductions','net_amount','snapshot','promoter_id','week_start'];
  c text;
begin
  if old.status <> 'pending' then
    foreach c in array cols loop
      if (to_jsonb(old)->c) is distinct from (to_jsonb(new)->c) then perform public.raise_app('PAYROLL_LOCKED', c); end if;
    end loop;
  end if;
  if new.manager_id <> old.manager_id and coalesce(current_setting('app.reassign', true), '') <> 'on' then
    perform public.raise_app('IMMUTABLE_RECORD', 'payrolls.manager_id');
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- views (recreated to pick up new columns)
drop view if exists public.promoter_balances;
drop view if exists public.payroll_overview;
create view public.payroll_overview with (security_invoker = true) as
select
  p.*,
  pr.full_name  as promoter_name,
  pr.phone      as promoter_phone,
  m.full_name   as manager_name,
  public.payroll_month_of(p.week_start) as payroll_month,
  coalesce(adj.delta, 0) as adjustments_total,
  p.net_amount + coalesce(adj.delta, 0) as effective_net,
  case when p.status = 'pending' then greatest(p.net_amount, 0)
       else p.payable_amount + coalesce(adj.delta, 0) + coalesce(adj.carried, 0) end as effective_payable,
  coalesce(pay.total, 0) as paid_total,
  (case when p.status = 'pending' then greatest(p.net_amount, 0)
        else p.payable_amount + coalesce(adj.delta, 0) + coalesce(adj.carried, 0) end) - coalesce(pay.total, 0) as outstanding
from public.payrolls p
join public.promoters pr on pr.id = p.promoter_id
join public.profiles m on m.id = p.manager_id
left join lateral (select sum(delta) delta, sum(carried_to_debt) carried from public.payroll_adjustments a where a.payroll_id = p.id) adj on true
left join lateral (select sum(amount) total from public.payroll_payments pp where pp.payroll_id = p.id) pay on true;

create view public.promoter_balances with (security_invoker = true) as
select
  p.id, p.manager_id, p.full_name, p.phone, p.birth_date, p.start_date, p.status, p.notes,
  p.created_at, p.updated_at,
  m.full_name as manager_name,
  coalesce(r.lifetime, 0)  as lifetime_registrations,
  coalesce(r.lifetime_active, 0) as lifetime_active,
  r.last_date as last_registration_date,
  coalesce(l.opening_debt, 0) as opening_debt,
  coalesce(l.new_debt, 0) as new_debt,
  coalesce(l.debt_repaid, 0) as debt_repaid,
  coalesce(l.opening_debt, 0) + coalesce(l.new_debt, 0) - coalesce(l.debt_repaid, 0) as debt_balance,
  coalesce(l.withdrawals, 0) as withdrawals_total,
  coalesce(l.advances, 0) as advances_total,
  coalesce(l.bonuses, 0) as bonuses_total,
  coalesce(l.salary_paid, 0) as salary_paid_total,
  coalesce(u.unpaid, 0) as unpaid_salary
from public.promoters p
join public.profiles m on m.id = p.manager_id
left join lateral (
  select sum(reg_count) lifetime, sum(active_count) lifetime_active, max(work_date) filter (where reg_count > 0) last_date
    from public.registrations x where x.promoter_id = p.id) r on true
left join lateral (
  select
    sum(amount) filter (where category = 'opening_debt') opening_debt,
    sum(amount) filter (where category = 'debt') new_debt,
    sum(amount) filter (where category = 'debt_repayment') debt_repaid,
    sum(amount) filter (where category = 'withdrawal') withdrawals,
    sum(amount) filter (where category = 'advance') advances,
    sum(amount) filter (where category = 'bonus') bonuses,
    sum(amount) filter (where category = 'salary_payment') salary_paid
  from public.ledger_entries e where e.promoter_id = p.id and e.status = 'approved') l on true
left join lateral (
  select sum(outstanding) unpaid from public.payroll_overview o
   where o.promoter_id = p.id and o.status in ('approved','adjusted')) u on true
where p.deleted_at is null;

revoke all on public.payroll_overview, public.promoter_balances from anon;
grant select on public.payroll_overview, public.promoter_balances to authenticated;

-- ---------------------------------------------------------------- registrations
-- entries: [{"promoter_id": "...", "count": 4, "active": 2, "expected_version": 1}]
-- Changing an existing day's car COUNT needs a reason. Updating how many of those
-- cars became active (status) is normal daily work and needs no reason — unless
-- the week's payroll is already approved/paid (then a reason is required).
create or replace function public.save_registrations(p_date date, p_entries jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e jsonb; v_pid uuid; v_cnt int; v_act int; v_ver int; v_mgr uuid; v_start date;
  v_existing public.registrations; v_max int; v_locked boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_results jsonb := '[]'::jsonb; v_action text;
begin
  perform public.require_user();
  if p_date is null or p_date > public.baghdad_today() then perform public.raise_app('FUTURE_DATE'); end if;
  if jsonb_typeof(p_entries) <> 'array' then perform public.raise_app('VALIDATION', 'entries'); end if;
  select max_daily_registrations into v_max from public.settings where id = 1;
  perform public.set_reason(v_reason);

  for e in select * from jsonb_array_elements(p_entries) loop
    v_pid := (e->>'promoter_id')::uuid;
    if not public.is_int_text(e->>'count') then perform public.raise_app('INVALID_COUNT', v_pid::text); end if;
    v_cnt := (e->>'count')::int;
    if e ? 'active' and e->>'active' is not null and not public.is_int_text(e->>'active') then perform public.raise_app('INVALID_COUNT', v_pid::text); end if;
    v_ver := nullif(e->>'expected_version', '')::int;
    if v_cnt < 0 or v_cnt > v_max then perform public.raise_app('INVALID_COUNT', v_pid::text); end if;

    v_mgr := public.assert_promoter_access(v_pid);
    select start_date into v_start from public.promoters where id = v_pid;
    if p_date < v_start then perform public.raise_app('BEFORE_START_DATE', v_pid::text); end if;
    v_locked := public.week_locked(v_pid, p_date);

    select * into v_existing from public.registrations where promoter_id = v_pid and work_date = p_date for update;
    v_act := coalesce(nullif(e->>'active', '')::int, v_existing.active_count, 0);
    if v_act < 0 or v_act > v_cnt then perform public.raise_app('INVALID_ACTIVE', v_pid::text); end if;

    if v_existing.id is null then
      if v_cnt = 0 then v_action := 'skipped';
      else
        if v_locked and v_reason is null then perform public.raise_app('WEEK_LOCKED', v_pid::text); end if;
        insert into public.registrations (promoter_id, manager_id, work_date, reg_count, active_count, rate, notes, created_by, updated_by)
        values (v_pid, v_mgr, p_date, v_cnt, v_act, 0, nullif(e->>'notes',''), auth.uid(), auth.uid())
        returning * into v_existing;
        insert into public.registration_history (registration_id, promoter_id, manager_id, work_date, old_count, new_count, old_rate, new_rate, old_active, new_active, reason, changed_by)
        values (v_existing.id, v_pid, v_mgr, p_date, null, v_cnt, null, 0, null, v_act, v_reason, auth.uid());
        v_action := 'created';
      end if;
    elsif v_existing.reg_count = v_cnt and v_existing.active_count = v_act then
      v_action := 'unchanged';
    else
      if v_existing.reg_count <> v_cnt and (v_reason is null or length(v_reason) < 3) then perform public.raise_app('DUPLICATE_ENTRY', v_pid::text); end if;
      if v_locked and (v_reason is null or length(v_reason) < 3) then perform public.raise_app('WEEK_LOCKED', v_pid::text); end if;
      if v_ver is not null and v_ver <> v_existing.version then perform public.raise_app('CONFLICT', v_pid::text); end if;
      insert into public.registration_history (registration_id, promoter_id, manager_id, work_date, old_count, new_count, old_rate, new_rate, old_active, new_active, reason, changed_by)
      values (v_existing.id, v_pid, v_mgr, p_date, v_existing.reg_count, v_cnt, v_existing.rate, v_existing.rate, v_existing.active_count, v_act, v_reason, auth.uid());
      update public.registrations set reg_count = v_cnt, active_count = v_act, version = version + 1, updated_by = auth.uid(),
             notes = coalesce(nullif(e->>'notes',''), notes)
       where id = v_existing.id returning * into v_existing;
      v_action := 'updated';
    end if;

    if v_action in ('created','updated') then perform public.refresh_payroll(v_pid, p_date); end if;
    v_results := v_results || jsonb_build_object('promoter_id', v_pid, 'action', v_action,
                   'version', v_existing.version, 'count', coalesce(v_existing.reg_count, 0), 'active', coalesce(v_existing.active_count, 0));
  end loop;
  return v_results;
end $$;

-- ---------------------------------------------------------------- incentive rules (daily, per car)
create or replace function public.save_incentive_rule(p_dates date[], p_rule jsonb, p_reason text default null)
returns int language plpgsql security definer set search_path = public as $$
declare v jsonb; d date; n int := 0; v_reason text := nullif(btrim(coalesce(p_reason,'')), ''); r record;
begin
  perform public.require_admin();
  v := public.normalize_incentive_rule(p_rule);
  if p_dates is null or array_length(p_dates, 1) is null then perform public.raise_app('VALIDATION', 'dates'); end if;
  perform public.set_reason(v_reason);
  foreach d in array p_dates loop
    if exists (select 1 from public.payrolls where week_start = public.week_start_of(d) and status <> 'pending')
       and (v_reason is null or length(v_reason) < 3) then perform public.raise_app('RULE_LOCKED', d::text); end if;
    insert into public.incentive_rules as ir (work_date, is_incentive_day, tiers, per_car_amount, applies_to, min_cars, min_tenure_days, manager_ids, notes, updated_by)
    values (d, (v->>'is_incentive_day')::boolean, '[]'::jsonb, (v->>'per_car_amount')::bigint, v->>'applies_to', (v->>'min_cars')::int,
            (v->>'min_tenure_days')::int,
            case when v->'manager_ids' is null or v->'manager_ids' = 'null'::jsonb then null else array(select jsonb_array_elements_text(v->'manager_ids'))::uuid[] end,
            v->>'notes', auth.uid())
    on conflict (work_date) do update set
      is_incentive_day = excluded.is_incentive_day, per_car_amount = excluded.per_car_amount, applies_to = excluded.applies_to,
      min_cars = excluded.min_cars, min_tenure_days = excluded.min_tenure_days, manager_ids = excluded.manager_ids,
      notes = excluded.notes, updated_by = excluded.updated_by, version = ir.version + 1;
    n := n + 1;
    for r in select distinct promoter_id from public.registrations where work_date = d and reg_count > 0 loop
      perform public.refresh_payroll(r.promoter_id, d);
    end loop;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- pricing plan RPCs (Super Admin)
create or replace function public.save_pricing_plan(p jsonb, p_reason text default null)
returns public.pricing_plans language plpgsql security definer set search_path = public as $$
declare
  v_from date := public.week_start_of(coalesce(nullif(p->>'effective_from','')::date, public.baghdad_today()));
  v_next date; v_row public.pricing_plans; r record; k text;
  v_reason text := nullif(btrim(coalesce(p_reason,'')), '');
begin
  perform public.require_admin();
  foreach k in array array['price_registered','price_active','bonus_price','bonus_min_cars','bonus_activity_pct'] loop
    if not public.is_int_text(p->>k) or (p->>k)::bigint < 0 then perform public.raise_app('VALIDATION', k); end if;
  end loop;
  if (p->>'bonus_activity_pct')::int > 100 then perform public.raise_app('VALIDATION', 'bonus_activity_pct'); end if;
  select min(effective_from) into v_next from public.pricing_plans where effective_from > v_from;
  if exists (select 1 from public.payrolls where status <> 'pending' and week_start >= v_from and (v_next is null or week_start < v_next))
     and (v_reason is null or length(v_reason) < 3) then
    perform public.raise_app('PLAN_LOCKED', v_from::text);
  end if;
  perform public.set_reason(v_reason);
  insert into public.pricing_plans as pp (effective_from, price_registered, price_active, bonus_enabled, bonus_price, bonus_min_cars, bonus_activity_pct, notes, updated_by)
  values (v_from, (p->>'price_registered')::bigint, (p->>'price_active')::bigint, coalesce((p->>'bonus_enabled')::boolean, true),
          (p->>'bonus_price')::bigint, (p->>'bonus_min_cars')::int, (p->>'bonus_activity_pct')::int, nullif(p->>'notes',''), auth.uid())
  on conflict (effective_from) do update set price_registered = excluded.price_registered, price_active = excluded.price_active,
    bonus_enabled = excluded.bonus_enabled, bonus_price = excluded.bonus_price, bonus_min_cars = excluded.bonus_min_cars,
    bonus_activity_pct = excluded.bonus_activity_pct, notes = excluded.notes, updated_by = excluded.updated_by
  returning * into v_row;
  for r in select distinct promoter_id, week_start from public.registrations
            where week_start >= v_from and (v_next is null or week_start < v_next) loop
    perform public.refresh_payroll(r.promoter_id, r.week_start);
  end loop;
  return v_row;
end $$;

create or replace function public.delete_pricing_plan(p_effective_from date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v_next date; r record;
begin
  perform public.require_admin();
  if length(btrim(coalesce(p_reason,''))) < 3 then perform public.raise_app('REASON_REQUIRED'); end if;
  if p_effective_from = (select min(effective_from) from public.pricing_plans) then perform public.raise_app('PLAN_REQUIRED'); end if;
  select min(effective_from) into v_next from public.pricing_plans where effective_from > p_effective_from;
  perform public.set_reason(p_reason);
  delete from public.pricing_plans where effective_from = p_effective_from;
  if not found then perform public.raise_app('NOT_FOUND'); end if;
  for r in select distinct promoter_id, week_start from public.registrations
            where week_start >= p_effective_from and (v_next is null or week_start < v_next) loop
    perform public.refresh_payroll(r.promoter_id, r.week_start);
  end loop;
end $$;

-- ---------------------------------------------------------------- dashboard & report
create or replace function public.get_dashboard(p_from date, p_to date, p_manager uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_mgr uuid := public.scope_manager(p_manager);
  v_today date := public.baghdad_today();
  v_ws date := public.week_start_of(public.baghdad_today());
  v_ms date := date_trunc('month', public.baghdad_today())::date;
  v_wf date := public.week_start_of(p_from);
  k jsonb; v_series jsonb; v_managers jsonb; v_top jsonb; v_exp_cat jsonb; v_weeks jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then perform public.raise_app('VALIDATION', 'range'); end if;
  if p_to - p_from > 800 then perform public.raise_app('RANGE_TOO_LARGE'); end if;

  with reg as (select * from public.registrations r where (v_mgr is null or r.manager_id = v_mgr)),
       rng as (select * from reg where work_date between p_from and p_to),
       led as (select * from public.ledger_entries where status = 'approved' and (v_mgr is null or manager_id = v_mgr)),
       pay as (select * from public.payroll_overview where (v_mgr is null or manager_id = v_mgr)),
       wk as (select * from pay where week_start between v_wf and p_to)
  select jsonb_build_object(
    'today',          (select coalesce(sum(reg_count),0) from reg where work_date = v_today),
    'today_active',   (select coalesce(sum(active_count),0) from reg where work_date = v_today),
    'last_24h',       (select coalesce(sum(reg_count),0) from reg where greatest(created_at, updated_at) >= now() - interval '24 hours'),
    'this_week',      (select coalesce(sum(reg_count),0) from reg where work_date between v_ws and v_ws + 6),
    'this_week_active', (select coalesce(sum(active_count),0) from reg where work_date between v_ws and v_ws + 6),
    'this_month',     (select coalesce(sum(reg_count),0) from reg where work_date >= v_ms and work_date <= v_today),
    'range_registrations', (select coalesce(sum(reg_count),0) from rng),
    'range_active',   (select coalesce(sum(active_count),0) from rng),
    'range_revenue',  (select coalesce(sum(base_amount),0) from wk),
    'range_incentives', (select coalesce(sum(incentive_amount),0) from wk),
    'bonus_weeks',    (select count(*) from wk where bonus_applied),
    'payroll_liabilities', (select coalesce(sum(outstanding),0) from pay where status in ('pending','approved','adjusted')),
    'unpaid_salaries', (select coalesce(sum(outstanding),0) from pay where status in ('approved','adjusted')),
    'paid_salaries',  (select coalesce(sum(pp.amount),0) from public.payroll_payments pp where (v_mgr is null or pp.manager_id = v_mgr)
                        and (pp.paid_at at time zone 'Asia/Baghdad')::date between p_from and p_to),
    'outstanding_debts', (select coalesce(sum(case when category in ('opening_debt','debt') then amount when category='debt_repayment' then -amount end),0) from led),
    'withdrawals',    (select coalesce(sum(amount),0) from led where category in ('withdrawal','advance') and entry_date between p_from and p_to),
    'expenses',       (select coalesce(sum(amount),0) from public.expenses e where e.status = 'approved' and (v_mgr is null or e.manager_id = v_mgr) and e.expense_date between p_from and p_to),
    'active_promoters', (select count(*) from public.promoters p where p.deleted_at is null and p.status = 'active' and (v_mgr is null or p.manager_id = v_mgr))
  ) into k;

  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'registrations', regs, 'active', act) order by d), '[]') into v_series
    from (select g.d::date d, coalesce(sum(r.reg_count),0) regs, coalesce(sum(r.active_count),0) act
            from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
            left join public.registrations r on r.work_date = g.d::date and (v_mgr is null or r.manager_id = v_mgr)
           group by 1) s;

  select coalesce(jsonb_agg(jsonb_build_object('week_start', week_start, 'earnings', earn, 'incentives', inc, 'cars', cars, 'active', act) order by week_start), '[]') into v_weeks
    from (select week_start, sum(base_amount) earn, sum(incentive_amount) inc, sum(reg_count) cars, sum(active_count) act
            from public.payroll_overview where (v_mgr is null or manager_id = v_mgr) and week_start between v_wf and p_to group by 1) w;

  select coalesce(jsonb_agg(x order by (x->>'registrations')::bigint desc), '[]') into v_managers from (
    select jsonb_build_object('manager_id', m.id, 'manager_name', m.full_name,
      'registrations', coalesce((select sum(reg_count) from public.registrations r where r.manager_id = m.id and r.work_date between p_from and p_to),0),
      'active', coalesce((select sum(active_count) from public.registrations r where r.manager_id = m.id and r.work_date between p_from and p_to),0),
      'revenue', coalesce((select sum(base_amount + incentive_amount) from public.payrolls y where y.manager_id = m.id and y.week_start between v_wf and p_to),0),
      'promoters', (select count(*) from public.promoters p where p.manager_id = m.id and p.deleted_at is null and p.status = 'active'),
      'expenses', coalesce((select sum(amount) from public.expenses e where e.manager_id = m.id and e.status='approved' and e.expense_date between p_from and p_to),0)) x
    from public.profiles m where m.role = 'manager' and (v_mgr is null or m.id = v_mgr)
      and (m.status = 'active' or exists (select 1 from public.promoters p where p.manager_id = m.id))) t;

  select coalesce(jsonb_agg(x), '[]') into v_top from (
    select jsonb_build_object('promoter_id', p.id, 'full_name', p.full_name, 'manager_name', m.full_name,
           'registrations', sum(r.reg_count), 'active', sum(r.active_count),
           'revenue', coalesce((select sum(base_amount + incentive_amount) from public.payrolls y where y.promoter_id = p.id and y.week_start between v_wf and p_to), 0),
           'days', count(*) filter (where r.reg_count > 0)) x
      from public.registrations r join public.promoters p on p.id = r.promoter_id join public.profiles m on m.id = p.manager_id
     where r.work_date between p_from and p_to and (v_mgr is null or r.manager_id = v_mgr)
     group by p.id, p.full_name, m.full_name having sum(r.reg_count) > 0
     order by sum(r.reg_count) desc, p.full_name limit 10) t;

  select coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount', amt) order by amt desc), '[]') into v_exp_cat
    from (select category, sum(amount) amt from public.expenses where status = 'approved'
           and (v_mgr is null or manager_id = v_mgr) and expense_date between p_from and p_to group by category) e;

  return jsonb_build_object('kpis', k, 'series', v_series, 'weeks', v_weeks, 'managers', v_managers, 'top_promoters', v_top,
                            'expenses_by_category', v_exp_cat, 'plan', public.plan_for_week(v_today), 'generated_at', now());
end $$;

drop function if exists public.report_performance(date, date, uuid);
create function public.report_performance(p_from date, p_to date, p_manager uuid default null)
returns table (promoter_id uuid, full_name text, phone text, manager_name text, status public.promoter_status,
               registrations bigint, active bigint, activity_pct int, days_worked bigint, bonus_weeks bigint,
               base_amount bigint, incentive_amount bigint, withdrawals bigint, deductions bigint, bonuses bigint, debt_balance bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_mgr uuid := public.scope_manager(p_manager); v_wf date := public.week_start_of(p_from);
begin
  return query
  select p.id, p.full_name, p.phone, m.full_name, p.status,
    coalesce(r.regs, 0)::bigint, coalesce(r.act, 0)::bigint,
    case when coalesce(r.regs, 0) = 0 then 0 else round(r.act * 100.0 / r.regs)::int end,
    coalesce(r.days, 0)::bigint,
    coalesce(y.bonus_weeks, 0)::bigint, coalesce(y.base, 0)::bigint, coalesce(y.inc, 0)::bigint,
    (select coalesce(sum(l.amount),0) from public.ledger_entries l where l.promoter_id = p.id and l.status='approved'
       and l.category in ('withdrawal','advance') and l.entry_date between p_from and p_to)::bigint,
    (select coalesce(sum(l.amount),0) from public.ledger_entries l where l.promoter_id = p.id and l.status='approved'
       and l.category in ('deduction','expense_charge','debt_repayment') and l.entry_date between p_from and p_to)::bigint,
    (select coalesce(sum(l.amount),0) from public.ledger_entries l where l.promoter_id = p.id and l.status='approved'
       and l.category = 'bonus' and l.entry_date between p_from and p_to)::bigint,
    public.debt_balance(p.id)
  from public.promoters p
  join public.profiles m on m.id = p.manager_id
  left join lateral (select sum(x.reg_count) regs, sum(x.active_count) act, count(*) filter (where x.reg_count > 0) days
                       from public.registrations x where x.promoter_id = p.id and x.work_date between p_from and p_to) r on true
  left join lateral (select count(*) filter (where z.bonus_applied) bonus_weeks, sum(z.base_amount) base, sum(z.incentive_amount) inc
                       from public.payrolls z where z.promoter_id = p.id and z.week_start between v_wf and p_to) y on true
  where p.deleted_at is null and (v_mgr is null or p.manager_id = v_mgr)
  order by 6 desc, 2;
end $$;

-- ---------------------------------------------------------------- privileges
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.plan_for_week(date), public.calc_car_earnings(jsonb, int, int), public.calc_daily_incentive(jsonb, int, int, int, uuid),
  public.normalize_incentive_rule(jsonb), public.save_pricing_plan(jsonb, text), public.delete_pricing_plan(date, text),
  public.report_performance(date, date, uuid), public.get_dashboard(date, date, uuid), public.save_registrations(date, jsonb, text),
  public.save_incentive_rule(date[], jsonb, text)
to authenticated;
revoke execute on function public.compute_payroll(uuid, date), public.refresh_payroll(uuid, date) from authenticated;
