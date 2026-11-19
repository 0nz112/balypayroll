-- =====================================================================
-- Manager-defined daily bonuses + promoter WhatsApp number + inventory report
--
-- Daily bonus: on the registrations screen a sales manager (or the Super Admin
-- for any manager) turns on a bonus for a date and enters it by hand:
--   amount, required number of cars, fixed amount or per car, counting all cars
--   or only active cars. No amounts are predefined.
-- The bonus is part of that day's earnings, so it belongs to that day's payroll
-- week only (weeks never mix). incentive_amount on payrolls includes it;
-- daily_bonus_amount keeps the breakdown.
-- =====================================================================

create table if not exists public.daily_bonuses (
  work_date   date not null,
  manager_id  uuid not null references public.profiles(id),
  enabled     boolean not null default true,
  amount      bigint not null check (amount >= 0),
  min_cars    int not null default 1 check (min_cars >= 1),
  mode        text not null default 'fixed' check (mode in ('fixed', 'per_car')),
  applies_to  text not null default 'all' check (applies_to in ('all', 'active')),
  notes       text,
  version     int not null default 1,
  updated_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (work_date, manager_id)
);
alter table public.daily_bonuses enable row level security;
revoke all on public.daily_bonuses from anon, authenticated;
grant select on public.daily_bonuses to authenticated;
drop policy if exists daily_bonuses_select on public.daily_bonuses;
create policy daily_bonuses_select on public.daily_bonuses for select to authenticated using (public.can_access_manager(manager_id));
drop trigger if exists audit_daily_bonuses on public.daily_bonuses;
create trigger audit_daily_bonuses after insert or update or delete on public.daily_bonuses for each row execute function public.tg_audit();
drop trigger if exists updated_daily_bonuses on public.daily_bonuses;
create trigger updated_daily_bonuses before update on public.daily_bonuses for each row execute function public.tg_set_updated_at();

alter table public.promoters add column if not exists whatsapp text;
alter table public.promoters drop constraint if exists promoters_whatsapp_chk;
alter table public.promoters add constraint promoters_whatsapp_chk check (whatsapp is null or whatsapp ~ '^\+?[0-9]{7,15}$');
alter table public.payrolls add column if not exists daily_bonus_amount bigint not null default 0;

-- Daily bonus for one promoter-day (mirrored by src/engine/incentives.js → calcDailyBonus)
create or replace function public.calc_daily_bonus(p_bonus jsonb, p_count int, p_active int) returns bigint
language plpgsql immutable as $$
declare units int;
begin
  if p_bonus is null or not coalesce((p_bonus->>'enabled')::boolean, false) or coalesce(p_count, 0) <= 0 then return 0; end if;
  units := case when p_bonus->>'applies_to' = 'active' then least(coalesce(p_active, 0), p_count) else p_count end;
  if units < coalesce((p_bonus->>'min_cars')::int, 1) then return 0; end if;
  return case when p_bonus->>'mode' = 'per_car' then units::bigint * coalesce((p_bonus->>'amount')::bigint, 0)
              else coalesce((p_bonus->>'amount')::bigint, 0) end;
end $$;

create or replace function public.compute_payroll(p_promoter uuid, p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ws date := public.week_start_of(p_week);
  v_we date := public.week_start_of(p_week) + 6;
  v_p record; r record; v_rule jsonb; v_inc bigint; v_plan jsonb; v_car jsonb; v_bon jsonb; v_db bigint; v_dbt bigint := 0;
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
    v_bon := null;
    select to_jsonb(b) - array['created_at','updated_at','updated_by'] into v_bon
      from public.daily_bonuses b where b.work_date = r.d and b.manager_id = v_p.manager_id;
    v_db := public.calc_daily_bonus(v_bon, r.c, r.a);
    v_t := v_t + r.c; v_a := v_a + r.a; v_incent := v_incent + v_inc + v_db; v_dbt := v_dbt + v_db;
    v_days := v_days || jsonb_build_object('date', r.d, 'count', r.c, 'active', r.a, 'incentive', v_inc, 'bonus', v_db,
      'incentive_day', coalesce((v_rule->>'is_incentive_day')::boolean, false), 'rule', v_rule,
      'bonus_day', coalesce((v_bon->>'enabled')::boolean, false), 'bonus_rule', v_bon);
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
    'base_amount', v_base, 'incentive_amount', v_incent, 'daily_bonus_amount', v_dbt,
    'bonus_amount', v_bonus, 'correction_amount', v_corr, 'withdrawal_amount', v_wd,
    'advance_amount', v_adv, 'deduction_amount', v_ded, 'debt_repayment_amount', v_debt,
    'gross_amount', v_gross, 'total_deductions', v_tded, 'net_amount', v_gross - v_tded,
    'days', v_days, 'entries', v_entries, 'calc_version', 'v3');
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
      base_amount = (c->>'base_amount')::bigint, incentive_amount = (c->>'incentive_amount')::bigint, daily_bonus_amount = (c->>'daily_bonus_amount')::bigint, bonus_amount = (c->>'bonus_amount')::bigint,
      correction_amount = (c->>'correction_amount')::bigint, withdrawal_amount = (c->>'withdrawal_amount')::bigint,
      advance_amount = (c->>'advance_amount')::bigint, deduction_amount = (c->>'deduction_amount')::bigint,
      debt_repayment_amount = (c->>'debt_repayment_amount')::bigint, gross_amount = (c->>'gross_amount')::bigint,
      total_deductions = (c->>'total_deductions')::bigint, net_amount = (c->>'net_amount')::bigint,
      payable_amount = greatest((c->>'net_amount')::bigint, 0), snapshot = c, calc_version = 'v3',
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
  cols text[] := array['reg_count','active_count','bonus_applied','base_amount','incentive_amount','daily_bonus_amount','bonus_amount','correction_amount',
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
  p.id, p.manager_id, p.full_name, p.phone, p.whatsapp, p.birth_date, p.start_date, p.status, p.notes,
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

-- p_manager: managers are always their own team; the Super Admin passes a manager, or null = every active manager.
create or replace function public.save_daily_bonus(p_date date, p_manager uuid, p jsonb, p_reason text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := public.require_user(); m uuid; n int := 0; r record;
  v_reason text := nullif(btrim(coalesce(p_reason,'')), '');
  v_amt text := coalesce(p->>'amount', '0'); v_min text := coalesce(p->>'min_cars', '1');
begin
  if p_date is null then perform public.raise_app('VALIDATION', 'date'); end if;
  if not public.is_int_text(v_amt) or v_amt::bigint < 0 then perform public.raise_app('VALIDATION', 'amount'); end if;
  if not public.is_int_text(v_min) or v_min::int < 1 then perform public.raise_app('VALIDATION', 'min_cars'); end if;
  if coalesce(p->>'mode', 'fixed') not in ('fixed','per_car') then perform public.raise_app('VALIDATION', 'mode'); end if;
  if coalesce(p->>'applies_to', 'all') not in ('all','active') then perform public.raise_app('VALIDATION', 'applies_to'); end if;
  perform public.set_reason(v_reason);
  for m in
    select id from public.profiles
     where role = 'manager' and status = 'active'
       and (case when v_role = 'super_admin' then (p_manager is null or id = p_manager) else id = auth.uid() end)
  loop
    if exists (select 1 from public.payrolls where manager_id = m and week_start = public.week_start_of(p_date) and status <> 'pending')
       and (v_reason is null or length(v_reason) < 3) then perform public.raise_app('RULE_LOCKED', p_date::text); end if;
    insert into public.daily_bonuses as b (work_date, manager_id, enabled, amount, min_cars, mode, applies_to, notes, updated_by)
    values (p_date, m, coalesce((p->>'enabled')::boolean, true), v_amt::bigint, v_min::int, coalesce(p->>'mode','fixed'),
            coalesce(p->>'applies_to','all'), nullif(p->>'notes',''), auth.uid())
    on conflict (work_date, manager_id) do update set enabled = excluded.enabled, amount = excluded.amount, min_cars = excluded.min_cars,
      mode = excluded.mode, applies_to = excluded.applies_to, notes = excluded.notes, updated_by = excluded.updated_by, version = b.version + 1;
    n := n + 1;
    for r in select promoter_id from public.registrations where work_date = p_date and manager_id = m and reg_count > 0 loop
      perform public.refresh_payroll(r.promoter_id, p_date);
    end loop;
  end loop;
  if n = 0 then perform public.raise_app('FORBIDDEN'); end if;
  return n;
end $$;

-- Promoter create/update with an optional WhatsApp number (defaults to the phone when empty).
create or replace function public.upsert_promoter(p jsonb)
returns public.promoters language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := public.require_user();
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_mgr uuid; v_row public.promoters; v_phone text; v_wa text;
begin
  v_phone := regexp_replace(coalesce(p->>'phone', ''), '[^0-9+]', '', 'g');
  v_wa := nullif(regexp_replace(coalesce(p->>'whatsapp', ''), '[^0-9+]', '', 'g'), '');
  if length(btrim(coalesce(p->>'full_name', ''))) < 2 then perform public.raise_app('VALIDATION', 'full_name'); end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then perform public.raise_app('VALIDATION', 'phone'); end if;
  if v_wa is not null and v_wa !~ '^\+?[0-9]{7,15}$' then perform public.raise_app('VALIDATION', 'whatsapp'); end if;
  if nullif(p->>'start_date', '') is null then perform public.raise_app('VALIDATION', 'start_date'); end if;
  if coalesce(p->>'status', 'active') not in ('active','inactive','terminated') then perform public.raise_app('VALIDATION', 'status'); end if;
  if v_role = 'super_admin' then
    v_mgr := nullif(p->>'manager_id', '')::uuid;
    if v_mgr is null and v_id is not null then select manager_id into v_mgr from public.promoters where id = v_id; end if;
  else
    v_mgr := auth.uid();
  end if;
  if not exists (select 1 from public.profiles where id = v_mgr and role = 'manager' and status = 'active') then
    perform public.raise_app('VALIDATION', 'manager_id');
  end if;
  begin
    if v_id is null then
      insert into public.promoters (manager_id, full_name, phone, whatsapp, birth_date, start_date, status, notes, created_by)
      values (v_mgr, btrim(p->>'full_name'), v_phone, v_wa, nullif(p->>'birth_date','')::date, (p->>'start_date')::date,
              coalesce(p->>'status','active')::public.promoter_status, nullif(p->>'notes',''), auth.uid())
      returning * into v_row;
    else
      perform public.assert_promoter_access(v_id);
      if v_mgr <> (select manager_id from public.promoters where id = v_id) then perform public.raise_app('USE_REASSIGN'); end if;
      update public.promoters set full_name = btrim(p->>'full_name'), phone = v_phone, whatsapp = v_wa,
        birth_date = nullif(p->>'birth_date','')::date, start_date = (p->>'start_date')::date,
        status = coalesce(p->>'status','active')::public.promoter_status, notes = nullif(p->>'notes','')
      where id = v_id returning * into v_row;
    end if;
  exception
    when unique_violation then perform public.raise_app('DUPLICATE_PHONE');
    when check_violation then perform public.raise_app('VALIDATION', 'promoter');
  end;
  return v_row;
end $$;

-- ---------------------------------------------------------------- inventory (جرد)
-- One promoter (p_promoter) or every promoter in scope, for any date range.
-- Day rows carry exact per-day figures; weekly earnings come from the payroll
-- weeks that start inside the range (each week is computed only from its own days).
create or replace function public.inventory_report(p_from date, p_to date, p_manager uuid default null, p_promoter uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_mgr uuid := public.scope_manager(p_manager); v_wf date := public.week_start_of(p_from);
begin
  if p_from is null or p_to is null or p_from > p_to then perform public.raise_app('VALIDATION', 'range'); end if;
  if p_to - p_from > 400 then perform public.raise_app('RANGE_TOO_LARGE'); end if;
  if p_promoter is not null then perform public.assert_promoter_access(p_promoter); end if;
  return jsonb_build_object(
    'from', p_from, 'to', p_to, 'generated_at', now(),
    'promoters', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'full_name', p.full_name, 'phone', p.phone, 'whatsapp', p.whatsapp,
          'manager_id', p.manager_id, 'manager_name', m.full_name, 'status', p.status, 'start_date', p.start_date,
          'debt_balance', public.debt_balance(p.id)) order by p.full_name)
        from public.promoters p join public.profiles m on m.id = p.manager_id
       where p.deleted_at is null and (p_promoter is null or p.id = p_promoter) and (v_mgr is null or p.manager_id = v_mgr)), '[]'),
    'days', coalesce((select jsonb_agg(jsonb_build_object('date', r.work_date, 'promoter_id', r.promoter_id, 'count', r.reg_count, 'active', r.active_count,
          'incentive', public.calc_daily_incentive((select to_jsonb(ir) from public.incentive_rules ir where ir.work_date = r.work_date),
                         r.reg_count, r.active_count, r.work_date - p.start_date, p.manager_id),
          'bonus', public.calc_daily_bonus((select to_jsonb(b) from public.daily_bonuses b where b.work_date = r.work_date and b.manager_id = p.manager_id),
                         r.reg_count, r.active_count)) order by r.work_date, p.full_name)
        from public.registrations r join public.promoters p on p.id = r.promoter_id
       where r.work_date between p_from and p_to and r.reg_count > 0 and p.deleted_at is null
         and (p_promoter is null or r.promoter_id = p_promoter) and (v_mgr is null or r.manager_id = v_mgr)), '[]'),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object('promoter_id', o.promoter_id, 'week_start', o.week_start, 'week_end', o.week_end, 'pay_date', o.pay_date,
          'reg_count', o.reg_count, 'active_count', o.active_count, 'bonus_applied', o.bonus_applied, 'base_amount', o.base_amount,
          'incentive_amount', o.incentive_amount, 'daily_bonus_amount', o.daily_bonus_amount, 'bonus_amount', o.bonus_amount,
          'withdrawal_amount', o.withdrawal_amount, 'advance_amount', o.advance_amount, 'deduction_amount', o.deduction_amount,
          'debt_repayment_amount', o.debt_repayment_amount, 'correction_amount', o.correction_amount, 'gross_amount', o.gross_amount,
          'total_deductions', o.total_deductions, 'effective_net', o.effective_net, 'paid_total', o.paid_total, 'outstanding', o.outstanding,
          'status', o.status) order by o.week_start, o.promoter_name)
        from public.payroll_overview o
       where o.week_start between v_wf and p_to and (p_promoter is null or o.promoter_id = p_promoter) and (v_mgr is null or o.manager_id = v_mgr)), '[]'),
    'plan', public.plan_for_week(p_to));
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.calc_daily_bonus(jsonb, int, int), public.save_daily_bonus(date, uuid, jsonb, text),
  public.upsert_promoter(jsonb), public.inventory_report(date, date, uuid, uuid) to authenticated;
