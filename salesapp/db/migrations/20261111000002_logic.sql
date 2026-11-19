-- =====================================================================
-- Business logic: guards, audit, engine, RPCs
-- Every write goes through a SECURITY DEFINER function that validates
-- input and checks permissions on the server. Tables expose no direct
-- INSERT/UPDATE/DELETE policies to clients (see RLS migration).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Error helper: messages are stable codes the UI translates.
-- ---------------------------------------------------------------------
create or replace function public.raise_app(p_code text, p_detail text default null)
returns void language plpgsql as $$
begin
  raise exception '%', p_code using errcode = 'P0001', detail = coalesce(p_detail, '');
end $$;

-- ---------------------------------------------------------------------
-- Identity & permission helpers
-- ---------------------------------------------------------------------
create or replace function public.my_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and status = 'active'
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role() = 'super_admin', false)
$$;

create or replace function public.can_access_manager(p_manager uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.my_role() = 'manager' and p_manager = auth.uid())
$$;

create or replace function public.require_user() returns public.app_role
language plpgsql stable security definer set search_path = public as $$
declare v public.app_role;
begin
  if auth.uid() is null then perform public.raise_app('NOT_AUTHENTICATED'); end if;
  v := public.my_role();
  if v is null then perform public.raise_app('ACCOUNT_INACTIVE'); end if;
  return v;
end $$;

create or replace function public.require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_user();
  if not public.is_admin() then perform public.raise_app('FORBIDDEN'); end if;
end $$;

create or replace function public.assert_manager_access(p_manager uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_access_manager(p_manager) then perform public.raise_app('FORBIDDEN'); end if;
end $$;

-- Returns the manager of an existing, non-deleted promoter after checking access.
create or replace function public.assert_promoter_access(p_promoter uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  select manager_id into v from public.promoters where id = p_promoter and deleted_at is null;
  if v is null then perform public.raise_app('NOT_FOUND', 'promoter'); end if;
  perform public.assert_manager_access(v);
  return v;
end $$;

-- Resolve which manager(s) a query is scoped to: managers are always forced
-- to themselves; admins may pass a manager id or null (all).
create or replace function public.scope_manager(p_manager uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare r public.app_role := public.require_user();
begin
  if r = 'super_admin' then return p_manager; end if;
  return auth.uid();
end $$;

create or replace function public.set_reason(p_reason text) returns void
language sql as $$ select set_config('app.audit_reason', coalesce(p_reason, ''), true) $$;

create or replace function public.is_int_text(t text) returns boolean
language sql immutable as $$ select t ~ '^-?[0-9]{1,15}$' $$;

-- ---------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------
create or replace function public.tg_set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

create or replace function public.tg_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and v_old = v_new then return new; end if;
  insert into public.audit_log (actor, action, table_name, row_id, manager_id, old_data, new_data, reason)
  values (
    auth.uid(), tg_op, tg_table_name,
    coalesce(v_new->>'id', v_old->>'id', v_new->>'work_date', v_old->>'work_date', v_new->>'user_id'),
    nullif(coalesce(v_new->>'manager_id', v_old->>'manager_id'), '')::uuid,
    v_old, v_new, nullif(current_setting('app.audit_reason', true), '')
  );
  return coalesce(new, old);
end $$;

create or replace function public.tg_forbid() returns trigger
language plpgsql as $$
begin
  raise exception 'IMMUTABLE_RECORD' using errcode = 'P0001', detail = tg_table_name || ':' || tg_op;
end $$;

-- Ledger entries are append-only. Only status transitions, payroll linking
-- and (during an admin reassignment) manager_id may change.
create or replace function public.tg_ledger_guard() returns trigger
language plpgsql as $$
declare a jsonb; b jsonb;
begin
  a := to_jsonb(old) - array['status','approved_by','approved_at','payroll_id','void_reason','manager_id','week_start'];
  b := to_jsonb(new) - array['status','approved_by','approved_at','payroll_id','void_reason','manager_id','week_start'];
  if a <> b then perform public.raise_app('IMMUTABLE_RECORD', 'ledger_entries'); end if;
  if new.manager_id <> old.manager_id and coalesce(current_setting('app.reassign', true), '') <> 'on' then
    perform public.raise_app('IMMUTABLE_RECORD', 'ledger_entries.manager_id');
  end if;
  if old.status in ('rejected','void') and new.status <> old.status then
    perform public.raise_app('IMMUTABLE_RECORD', 'ledger_entries.status');
  end if;
  return new;
end $$;

-- Payroll money columns can only change while the payroll is pending.
create or replace function public.tg_payroll_guard() returns trigger
language plpgsql as $$
declare
  cols text[] := array['reg_count','base_amount','incentive_amount','bonus_amount','correction_amount',
    'withdrawal_amount','advance_amount','deduction_amount','debt_repayment_amount','gross_amount',
    'total_deductions','net_amount','snapshot','promoter_id','week_start'];
  c text;
begin
  if old.status <> 'pending' then
    foreach c in array cols loop
      if (to_jsonb(old)->c) is distinct from (to_jsonb(new)->c) then
        perform public.raise_app('PAYROLL_LOCKED', c);
      end if;
    end loop;
  end if;
  if new.manager_id <> old.manager_id and coalesce(current_setting('app.reassign', true), '') <> 'on' then
    perform public.raise_app('IMMUTABLE_RECORD', 'payrolls.manager_id');
  end if;
  return new;
end $$;

create or replace function public.tg_registration_guard() returns trigger
language plpgsql as $$
begin
  if new.promoter_id <> old.promoter_id or new.work_date <> old.work_date or new.rate <> old.rate then
    perform public.raise_app('IMMUTABLE_RECORD', 'registrations');
  end if;
  if new.manager_id <> old.manager_id and coalesce(current_setting('app.reassign', true), '') <> 'on' then
    perform public.raise_app('IMMUTABLE_RECORD', 'registrations.manager_id');
  end if;
  return new;
end $$;

create or replace function public.tg_expense_guard() returns trigger
language plpgsql as $$
declare a jsonb; b jsonb;
begin
  a := to_jsonb(old) - array['status','void_reason','ledger_entry_id','week_start'];
  b := to_jsonb(new) - array['status','void_reason','ledger_entry_id','week_start'];
  if a <> b then perform public.raise_app('IMMUTABLE_RECORD', 'expenses'); end if;
  return new;
end $$;

-- New auth users get a profile. Role comes from app_metadata (server-controlled,
-- never from user-editable user_metadata). Accounts start suspended unless the
-- admin Edge Function marks them active.
create or replace function public.tg_handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := 'manager';
  v_status public.account_status := 'suspended';
begin
  if (new.raw_app_meta_data->>'role') = 'super_admin' then v_role := 'super_admin'; end if;
  if (new.raw_app_meta_data->>'status') = 'active' then v_status := 'active'; end if;
  insert into public.profiles (id, email, full_name, phone, role, status)
  values (new.id, new.email,
          coalesce(new.raw_app_meta_data->>'full_name', split_part(coalesce(new.email,''), '@', 1)),
          new.raw_app_meta_data->>'phone', v_role, v_status)
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.tg_handle_new_user();

-- Attach triggers
do $$
declare t text;
begin
  foreach t in array array['profiles','settings','promoters','registrations','incentive_rules','payrolls',
                           'ledger_entries','expenses','expense_categories','payroll_payments','payroll_adjustments'] loop
    execute format('drop trigger if exists audit_%1$s on public.%1$s', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$s for each row execute function public.tg_audit()', t);
  end loop;
  foreach t in array array['profiles','settings','promoters','registrations','incentive_rules','payrolls','user_preferences'] loop
    execute format('drop trigger if exists updated_%1$s on public.%1$s', t);
    execute format('create trigger updated_%1$s before update on public.%1$s for each row execute function public.tg_set_updated_at()', t);
  end loop;
  -- Never physically delete financial / history rows
  foreach t in array array['registrations','registration_history','payrolls','payroll_payments','payroll_adjustments',
                           'ledger_entries','expenses','audit_log','promoters','incentive_rules_history'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists nodelete_%1$s on public.%1$s', t);
      execute format('create trigger nodelete_%1$s before delete on public.%1$s for each row execute function public.tg_forbid()', t);
    end if;
  end loop;
  foreach t in array array['registration_history','payroll_payments','payroll_adjustments','audit_log'] loop
    execute format('drop trigger if exists noupdate_%1$s on public.%1$s', t);
    execute format('create trigger noupdate_%1$s before update on public.%1$s for each row execute function public.tg_forbid()', t);
  end loop;
end $$;

drop trigger if exists guard_ledger on public.ledger_entries;
create trigger guard_ledger before update on public.ledger_entries for each row execute function public.tg_ledger_guard();
drop trigger if exists guard_payroll on public.payrolls;
create trigger guard_payroll before update on public.payrolls for each row execute function public.tg_payroll_guard();
drop trigger if exists guard_registration on public.registrations;
create trigger guard_registration before update on public.registrations for each row execute function public.tg_registration_guard();
drop trigger if exists guard_expense on public.expenses;
create trigger guard_expense before update on public.expenses for each row execute function public.tg_expense_guard();

-- =====================================================================
-- INCENTIVE ENGINE  (mirrored exactly by src/engine/incentives.js)
-- =====================================================================
-- Tier amount, honouring the tier's own eligibility conditions.
create or replace function public.tier_amount(p_tier jsonb, p_tenure_days int) returns bigint
language sql immutable as $$
  select case
    when p_tier is null then 0
    when not coalesce((p_tier->>'enabled')::boolean, true) then 0
    when coalesce(p_tenure_days, 0) < coalesce((p_tier->>'min_tenure_days')::int, 0) then 0
    else coalesce((p_tier->>'amount')::bigint, 0)
  end
$$;

-- Incentive earned by one promoter for one day with p_count registrations.
--   * No rule, or rule not an incentive day           → 0
--   * Rule restricted to managers that exclude p_manager → 0
--   * Tenure below rule.min_tenure_days               → 0
--   * 2..5 registrations                              → that tier's configured amount
--   * > 5 registrations                               → (top tier amount if include_top_tier)
--        + extra_amount × units, units = count-5 (beyond_threshold) or count (all_registrations)
create or replace function public.calc_incentive(p_rule jsonb, p_count int, p_tenure_days int, p_manager uuid)
returns bigint language plpgsql immutable as $$
declare
  c_threshold constant int := 5;
  v_tier jsonb; v_amt bigint := 0; v_units int;
begin
  if p_rule is null or p_count is null or p_count < 2 then return 0; end if;
  if not coalesce((p_rule->>'is_incentive_day')::boolean, false) then return 0; end if;
  if jsonb_typeof(p_rule->'manager_ids') = 'array' and jsonb_array_length(p_rule->'manager_ids') > 0
     and not coalesce((p_rule->'manager_ids') ? coalesce(p_manager::text, ''), false) then
    return 0;
  end if;
  if coalesce(p_tenure_days, 0) < coalesce((p_rule->>'min_tenure_days')::int, 0) then return 0; end if;

  if p_count <= c_threshold then
    select t into v_tier from jsonb_array_elements(coalesce(p_rule->'tiers', '[]')) t
     where (t->>'count')::int = p_count limit 1;
    return public.tier_amount(v_tier, p_tenure_days);
  end if;

  if coalesce((p_rule->>'include_top_tier')::boolean, true) then
    select t into v_tier from jsonb_array_elements(coalesce(p_rule->'tiers', '[]')) t
     where (t->>'count')::int = c_threshold limit 1;
    v_amt := public.tier_amount(v_tier, p_tenure_days);
  end if;
  if coalesce((p_rule->>'extra_enabled')::boolean, false) then
    v_units := case when p_rule->>'extra_basis' = 'all_registrations' then p_count else p_count - c_threshold end;
    v_amt := v_amt + v_units::bigint * coalesce((p_rule->>'extra_amount')::bigint, 0);
  end if;
  return v_amt;
end $$;

-- Validates & normalises a rule payload. Raises INVALID_RULE on bad input.
create or replace function public.normalize_incentive_rule(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  v_tiers jsonb := '[]'::jsonb; t jsonb; c int; seen int[] := '{}';
  v_amount text; v_extra text; v_ten text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then perform public.raise_app('INVALID_RULE', 'payload'); end if;
  for t in select * from jsonb_array_elements(coalesce(p->'tiers', '[]')) loop
    c := (t->>'count')::int;
    if c is null or c < 2 or c > 5 or c = any(seen) then perform public.raise_app('INVALID_RULE', 'tier count'); end if;
    v_amount := coalesce(t->>'amount', '0');
    v_ten := coalesce(t->>'min_tenure_days', '0');
    if not public.is_int_text(v_amount) or v_amount::bigint < 0 then perform public.raise_app('INVALID_RULE', 'tier amount'); end if;
    if not public.is_int_text(v_ten) or v_ten::int < 0 then perform public.raise_app('INVALID_RULE', 'tier tenure'); end if;
    seen := seen || c;
    v_tiers := v_tiers || jsonb_build_object('count', c, 'amount', v_amount::bigint,
      'enabled', coalesce((t->>'enabled')::boolean, true), 'min_tenure_days', v_ten::int);
  end loop;
  select coalesce(jsonb_agg(x order by (x->>'count')::int), '[]') into v_tiers from jsonb_array_elements(v_tiers) x;
  v_extra := coalesce(p->>'extra_amount', '0');
  if not public.is_int_text(v_extra) or v_extra::bigint < 0 then perform public.raise_app('INVALID_RULE', 'extra amount'); end if;
  if coalesce(p->>'extra_basis', 'beyond_threshold') not in ('beyond_threshold', 'all_registrations') then
    perform public.raise_app('INVALID_RULE', 'extra basis');
  end if;
  if not public.is_int_text(coalesce(p->>'min_tenure_days','0')) or coalesce((p->>'min_tenure_days')::int,0) < 0 then
    perform public.raise_app('INVALID_RULE', 'min tenure');
  end if;
  return jsonb_build_object(
    'is_incentive_day', coalesce((p->>'is_incentive_day')::boolean, false),
    'tiers', v_tiers,
    'extra_enabled', coalesce((p->>'extra_enabled')::boolean, false),
    'extra_amount', v_extra::bigint,
    'extra_basis', coalesce(p->>'extra_basis', 'beyond_threshold'),
    'include_top_tier', coalesce((p->>'include_top_tier')::boolean, true),
    'min_tenure_days', coalesce((p->>'min_tenure_days')::int, 0),
    'manager_ids', case when jsonb_typeof(p->'manager_ids') = 'array' and jsonb_array_length(p->'manager_ids') > 0
                        then p->'manager_ids' else null end,
    'notes', p->>'notes');
end $$;

-- Preview a rule (unsaved) against several counts. Pure — saves nothing.
create or replace function public.preview_incentive(p_rule jsonb, p_counts int[], p_tenure_days int default 9999, p_manager uuid default null)
returns table (reg_count int, incentive bigint, base bigint, total bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_rule jsonb; v_rate bigint;
begin
  perform public.require_user();
  v_rule := public.normalize_incentive_rule(p_rule);
  select base_rate into v_rate from public.settings where id = 1;
  return query
    select c, public.calc_incentive(v_rule, c, p_tenure_days, p_manager), c::bigint * v_rate,
           c::bigint * v_rate + public.calc_incentive(v_rule, c, p_tenure_days, p_manager)
      from unnest(p_counts) c;
end $$;

-- =====================================================================
-- PAYROLL ENGINE (mirrored exactly by src/engine/payroll.js)
-- =====================================================================
create or replace function public.compute_payroll(p_promoter uuid, p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_ws date := public.week_start_of(p_week);
  v_we date := public.week_start_of(p_week) + 6;
  v_p record; r record; v_rule jsonb; v_inc bigint;
  v_days jsonb := '[]'::jsonb; v_entries jsonb := '[]'::jsonb;
  v_reg int := 0; v_base bigint := 0; v_incent bigint := 0;
  v_bonus bigint := 0; v_corr bigint := 0; v_wd bigint := 0; v_adv bigint := 0; v_ded bigint := 0; v_debt bigint := 0;
  v_gross bigint; v_tded bigint;
begin
  select id, manager_id, start_date into v_p from public.promoters where id = p_promoter;
  if not found then perform public.raise_app('NOT_FOUND', 'promoter'); end if;

  for r in
    select g.d::date as d, reg.reg_count, reg.rate
      from generate_series(v_ws::timestamp, v_we::timestamp, interval '1 day') g(d)
      left join public.registrations reg on reg.promoter_id = p_promoter and reg.work_date = g.d::date
     order by 1
  loop
    v_rule := null;
    select to_jsonb(ir) - array['created_at','updated_at','updated_by'] into v_rule
      from public.incentive_rules ir where ir.work_date = r.d;
    v_inc := case when coalesce(r.reg_count, 0) > 0
                  then public.calc_incentive(v_rule, r.reg_count, r.d - v_p.start_date, v_p.manager_id) else 0 end;
    v_reg := v_reg + coalesce(r.reg_count, 0);
    v_base := v_base + coalesce(r.reg_count, 0)::bigint * coalesce(r.rate, 0);
    v_incent := v_incent + v_inc;
    v_days := v_days || jsonb_build_object(
      'date', r.d, 'count', coalesce(r.reg_count, 0), 'rate', coalesce(r.rate, 0),
      'base', coalesce(r.reg_count, 0)::bigint * coalesce(r.rate, 0), 'incentive', v_inc,
      'incentive_day', coalesce((v_rule->>'is_incentive_day')::boolean, false), 'rule', v_rule);
  end loop;

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
    v_entries := v_entries || jsonb_build_object('id', r.id, 'category', r.category, 'amount', r.amount,
                                                 'date', r.entry_date, 'notes', r.notes);
  end loop;

  v_gross := v_base + v_incent + v_bonus + greatest(v_corr, 0);
  v_tded := v_wd + v_adv + v_ded + v_debt + greatest(-v_corr, 0);

  return jsonb_build_object(
    'promoter_id', p_promoter, 'manager_id', v_p.manager_id,
    'week_start', v_ws, 'week_end', v_we, 'pay_date', v_ws + 10,
    'reg_count', v_reg, 'base_amount', v_base, 'incentive_amount', v_incent,
    'bonus_amount', v_bonus, 'correction_amount', v_corr, 'withdrawal_amount', v_wd,
    'advance_amount', v_adv, 'deduction_amount', v_ded, 'debt_repayment_amount', v_debt,
    'gross_amount', v_gross, 'total_deductions', v_tded, 'net_amount', v_gross - v_tded,
    'days', v_days, 'entries', v_entries, 'calc_version', 'v1');
end $$;

-- Upsert/refresh the pending payroll for one promoter-week (internal).
create or replace function public.refresh_payroll(p_promoter uuid, p_week date)
returns uuid language plpgsql security definer set search_path = public as $$
declare c jsonb; v_id uuid; v_status public.payroll_status; v_old_net bigint;
begin
  c := public.compute_payroll(p_promoter, p_week);
  select id, status, net_amount into v_id, v_status, v_old_net from public.payrolls
   where promoter_id = p_promoter and week_start = (c->>'week_start')::date for update;

  if v_id is null then
    if (c->>'reg_count')::int = 0 and jsonb_array_length(c->'entries') = 0 then return null; end if;
    insert into public.payrolls (promoter_id, manager_id, week_start) values
      (p_promoter, (c->>'manager_id')::uuid, (c->>'week_start')::date) returning id into v_id;
    v_status := 'pending';
  end if;

  if v_status = 'pending' then
    update public.payrolls set
      reg_count = (c->>'reg_count')::int, base_amount = (c->>'base_amount')::bigint,
      incentive_amount = (c->>'incentive_amount')::bigint, bonus_amount = (c->>'bonus_amount')::bigint,
      correction_amount = (c->>'correction_amount')::bigint, withdrawal_amount = (c->>'withdrawal_amount')::bigint,
      advance_amount = (c->>'advance_amount')::bigint, deduction_amount = (c->>'deduction_amount')::bigint,
      debt_repayment_amount = (c->>'debt_repayment_amount')::bigint, gross_amount = (c->>'gross_amount')::bigint,
      total_deductions = (c->>'total_deductions')::bigint, net_amount = (c->>'net_amount')::bigint,
      payable_amount = greatest((c->>'net_amount')::bigint, 0), snapshot = c,
      needs_recalc = false, computed_at = now()
    where id = v_id;
  elsif (c->>'net_amount')::bigint is distinct from (
        select net_amount + coalesce((select sum(delta) from public.payroll_adjustments a where a.payroll_id = v_id), 0)
          from public.payrolls where id = v_id) then
    update public.payrolls set needs_recalc = true where id = v_id;
  end if;
  return v_id;
end $$;

-- Effective figures for a payroll including adjustments and payments.
create or replace view public.payroll_overview with (security_invoker = true) as
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

-- Promoter list with balances
create or replace view public.promoter_balances with (security_invoker = true) as
select
  p.id, p.manager_id, p.full_name, p.phone, p.birth_date, p.start_date, p.status, p.notes,
  p.created_at, p.updated_at,
  m.full_name as manager_name,
  coalesce(r.lifetime, 0)  as lifetime_registrations,
  coalesce(r.last_date, null) as last_registration_date,
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
  select sum(reg_count) lifetime, max(work_date) filter (where reg_count > 0) last_date
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

create or replace function public.debt_balance(p_promoter uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case when category in ('opening_debt','debt') then amount
                           when category = 'debt_repayment' then -amount else 0 end), 0)
    from public.ledger_entries where promoter_id = p_promoter and status = 'approved'
$$;

create or replace function public.week_locked(p_promoter uuid, p_date date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payrolls where promoter_id = p_promoter
                 and week_start = public.week_start_of(p_date) and status <> 'pending')
$$;

-- =====================================================================
-- RPC: Promoters
-- =====================================================================
create or replace function public.upsert_promoter(p jsonb)
returns public.promoters language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := public.require_user();
  v_id uuid := nullif(p->>'id', '')::uuid;
  v_mgr uuid; v_row public.promoters; v_phone text;
begin
  v_phone := regexp_replace(coalesce(p->>'phone', ''), '[^0-9+]', '', 'g');
  if length(btrim(coalesce(p->>'full_name', ''))) < 2 then perform public.raise_app('VALIDATION', 'full_name'); end if;
  if v_phone !~ '^\+?[0-9]{7,15}$' then perform public.raise_app('VALIDATION', 'phone'); end if;
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
      insert into public.promoters (manager_id, full_name, phone, birth_date, start_date, status, notes, created_by)
      values (v_mgr, btrim(p->>'full_name'), v_phone, nullif(p->>'birth_date','')::date, (p->>'start_date')::date,
              coalesce(p->>'status','active')::public.promoter_status, nullif(p->>'notes',''), auth.uid())
      returning * into v_row;
    else
      perform public.assert_promoter_access(v_id);
      if v_mgr <> (select manager_id from public.promoters where id = v_id) then
        perform public.raise_app('USE_REASSIGN');
      end if;
      update public.promoters set full_name = btrim(p->>'full_name'), phone = v_phone,
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

-- Soft delete (only when the promoter has no financial history) — otherwise deactivate.
create or replace function public.archive_promoter(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_promoter_access(p_id);
  if length(btrim(coalesce(p_reason,''))) < 3 then perform public.raise_app('REASON_REQUIRED'); end if;
  if exists (select 1 from public.registrations where promoter_id = p_id and reg_count > 0)
     or exists (select 1 from public.ledger_entries where promoter_id = p_id and status = 'approved') then
    perform public.raise_app('HAS_HISTORY');
  end if;
  perform public.set_reason(p_reason);
  update public.promoters set deleted_at = now(), status = 'terminated' where id = p_id;
end $$;

create or replace function public.reassign_promoters(p_to uuid, p_ids uuid[], p_reason text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public.require_admin();
  if not exists (select 1 from public.profiles where id = p_to and role = 'manager' and status = 'active') then
    perform public.raise_app('VALIDATION', 'manager_id');
  end if;
  perform public.set_reason(coalesce(p_reason, 'reassign'));
  perform set_config('app.reassign', 'on', true);
  update public.promoters set manager_id = p_to where id = any(p_ids) and deleted_at is null;
  get diagnostics n = row_count;
  update public.registrations set manager_id = p_to where promoter_id = any(p_ids);
  update public.ledger_entries set manager_id = p_to where promoter_id = any(p_ids);
  update public.payrolls set manager_id = p_to where promoter_id = any(p_ids);
  perform set_config('app.reassign', 'off', true);
  return n;
end $$;

-- =====================================================================
-- RPC: Registrations
-- p_entries: [{"promoter_id": "...", "count": 3, "expected_version": 1, "notes": ""}]
-- Existing entries change only with an explicit reason (authorized edit).
-- =====================================================================
create or replace function public.save_registrations(p_date date, p_entries jsonb, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e jsonb; v_pid uuid; v_cnt int; v_ver int; v_mgr uuid; v_start date;
  v_existing public.registrations; v_rate bigint; v_max int; v_locked boolean;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_results jsonb := '[]'::jsonb; v_action text;
begin
  perform public.require_user();
  if p_date is null or p_date > public.baghdad_today() then perform public.raise_app('FUTURE_DATE'); end if;
  if jsonb_typeof(p_entries) <> 'array' then perform public.raise_app('VALIDATION', 'entries'); end if;
  select base_rate, max_daily_registrations into v_rate, v_max from public.settings where id = 1;
  perform public.set_reason(v_reason);

  for e in select * from jsonb_array_elements(p_entries) loop
    v_pid := (e->>'promoter_id')::uuid;
    if not public.is_int_text(e->>'count') then perform public.raise_app('INVALID_COUNT', v_pid::text); end if;
    v_cnt := (e->>'count')::int;
    v_ver := nullif(e->>'expected_version', '')::int;
    if v_cnt < 0 or v_cnt > v_max then perform public.raise_app('INVALID_COUNT', v_pid::text); end if;

    v_mgr := public.assert_promoter_access(v_pid);
    select start_date into v_start from public.promoters where id = v_pid;
    if p_date < v_start then perform public.raise_app('BEFORE_START_DATE', v_pid::text); end if;
    v_locked := public.week_locked(v_pid, p_date);

    select * into v_existing from public.registrations where promoter_id = v_pid and work_date = p_date for update;
    if v_existing.id is null then
      if v_cnt = 0 then v_action := 'skipped';
      else
        if v_locked and v_reason is null then perform public.raise_app('WEEK_LOCKED', v_pid::text); end if;
        insert into public.registrations (promoter_id, manager_id, work_date, reg_count, rate, notes, created_by, updated_by)
        values (v_pid, v_mgr, p_date, v_cnt, v_rate, nullif(e->>'notes',''), auth.uid(), auth.uid())
        returning * into v_existing;
        insert into public.registration_history (registration_id, promoter_id, manager_id, work_date, old_count, new_count, old_rate, new_rate, reason, changed_by)
        values (v_existing.id, v_pid, v_mgr, p_date, null, v_cnt, null, v_existing.rate, v_reason, auth.uid());
        v_action := 'created';
      end if;
    elsif v_existing.reg_count = v_cnt then
      v_action := 'unchanged';
    else
      if v_reason is null or length(v_reason) < 3 then perform public.raise_app('DUPLICATE_ENTRY', v_pid::text); end if;
      if v_ver is not null and v_ver <> v_existing.version then perform public.raise_app('CONFLICT', v_pid::text); end if;
      insert into public.registration_history (registration_id, promoter_id, manager_id, work_date, old_count, new_count, old_rate, new_rate, reason, changed_by)
      values (v_existing.id, v_pid, v_mgr, p_date, v_existing.reg_count, v_cnt, v_existing.rate, v_existing.rate, v_reason, auth.uid());
      update public.registrations set reg_count = v_cnt, version = version + 1, updated_by = auth.uid(),
             notes = coalesce(nullif(e->>'notes',''), notes)
       where id = v_existing.id returning * into v_existing;
      v_action := 'updated';
    end if;

    if v_action in ('created','updated') then perform public.refresh_payroll(v_pid, p_date); end if;
    v_results := v_results || jsonb_build_object('promoter_id', v_pid, 'action', v_action,
                   'version', v_existing.version, 'count', coalesce(v_existing.reg_count, 0));
  end loop;
  return v_results;
end $$;

-- =====================================================================
-- RPC: Incentive rules (Super Admin)
-- =====================================================================
create or replace function public.save_incentive_rule(p_dates date[], p_rule jsonb, p_reason text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v jsonb; d date; n int := 0; v_reason text := nullif(btrim(coalesce(p_reason,'')), '');
  v_locked boolean; r record;
begin
  perform public.require_admin();
  v := public.normalize_incentive_rule(p_rule);
  if p_dates is null or array_length(p_dates, 1) is null then perform public.raise_app('VALIDATION', 'dates'); end if;
  perform public.set_reason(v_reason);
  foreach d in array p_dates loop
    v_locked := exists (select 1 from public.payrolls where week_start = public.week_start_of(d) and status <> 'pending');
    if v_locked and (v_reason is null or length(v_reason) < 3) then perform public.raise_app('RULE_LOCKED', d::text); end if;
    insert into public.incentive_rules as ir (work_date, is_incentive_day, tiers, extra_enabled, extra_amount, extra_basis,
        include_top_tier, min_tenure_days, manager_ids, notes, updated_by)
    values (d, (v->>'is_incentive_day')::boolean, v->'tiers', (v->>'extra_enabled')::boolean, (v->>'extra_amount')::bigint,
        (v->>'extra_basis')::public.extra_basis, (v->>'include_top_tier')::boolean, (v->>'min_tenure_days')::int,
        case when v->'manager_ids' is null or v->'manager_ids' = 'null'::jsonb then null
             else array(select jsonb_array_elements_text(v->'manager_ids'))::uuid[] end,
        v->>'notes', auth.uid())
    on conflict (work_date) do update set
        is_incentive_day = excluded.is_incentive_day, tiers = excluded.tiers, extra_enabled = excluded.extra_enabled,
        extra_amount = excluded.extra_amount, extra_basis = excluded.extra_basis, include_top_tier = excluded.include_top_tier,
        min_tenure_days = excluded.min_tenure_days, manager_ids = excluded.manager_ids, notes = excluded.notes,
        updated_by = excluded.updated_by, version = ir.version + 1;
    n := n + 1;
    -- refresh pending payrolls; flag locked ones for authorized adjustment
    for r in select distinct promoter_id from public.registrations where work_date = d and reg_count > 0 loop
      perform public.refresh_payroll(r.promoter_id, d);
    end loop;
  end loop;
  return n;
end $$;

create or replace function public.clear_incentive_rule(p_dates date[], p_reason text default null)
returns int language plpgsql security definer set search_path = public as $$
declare d date; n int := 0; r record; v_reason text := nullif(btrim(coalesce(p_reason,'')), '');
begin
  perform public.require_admin();
  perform public.set_reason(v_reason);
  foreach d in array p_dates loop
    if exists (select 1 from public.payrolls where week_start = public.week_start_of(d) and status <> 'pending')
       and (v_reason is null or length(v_reason) < 3) then
      perform public.raise_app('RULE_LOCKED', d::text);
    end if;
    update public.incentive_rules set is_incentive_day = false, version = version + 1, updated_by = auth.uid()
     where work_date = d and is_incentive_day;
    if found then n := n + 1; end if;
    for r in select distinct promoter_id from public.registrations where work_date = d and reg_count > 0 loop
      perform public.refresh_payroll(r.promoter_id, d);
    end loop;
  end loop;
  return n;
end $$;

-- =====================================================================
-- RPC: Payroll workflow  pending → approved → paid → (adjusted)
-- =====================================================================
create or replace function public.preview_payroll(p_promoter uuid, p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.assert_promoter_access(p_promoter);
  return public.compute_payroll(p_promoter, p_week);
end $$;

create or replace function public.generate_payrolls(p_week date, p_manager uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ws date := public.week_start_of(p_week); v_mgr uuid := public.scope_manager(p_manager);
  r record; n int := 0; v_id uuid;
begin
  if v_ws > public.baghdad_today() then perform public.raise_app('FUTURE_DATE'); end if;
  for r in
    select p.id from public.promoters p where p.deleted_at is null and (v_mgr is null or p.manager_id = v_mgr)
       and (exists (select 1 from public.registrations x where x.promoter_id = p.id and x.week_start = v_ws and x.reg_count > 0)
            or exists (select 1 from public.ledger_entries l where l.promoter_id = p.id and l.week_start = v_ws and l.status = 'approved'
                       and l.category in ('debt_repayment','withdrawal','advance','expense_charge','deduction','bonus','correction'))
            or exists (select 1 from public.payrolls y where y.promoter_id = p.id and y.week_start = v_ws))
  loop
    v_id := public.refresh_payroll(r.id, v_ws);
    if v_id is not null then n := n + 1; end if;
  end loop;
  return jsonb_build_object('week_start', v_ws, 'payrolls', n);
end $$;

create or replace function public.approve_payrolls(p_ids uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare v public.payrolls; n int := 0; v_entry uuid; v_pid uuid;
begin
  perform public.require_user();
  foreach v_pid in array p_ids loop
    select * into v from public.payrolls where id = v_pid for update;
    if v.promoter_id is null then perform public.raise_app('NOT_FOUND', 'payroll'); end if;
    perform public.assert_manager_access(v.manager_id);
    if v.status <> 'pending' then perform public.raise_app('INVALID_STATUS', v.id::text); end if;
    if v.week_start + 6 >= public.baghdad_today() then perform public.raise_app('WEEK_NOT_ENDED', v.id::text); end if;
    if exists (select 1 from public.ledger_entries where promoter_id = v.promoter_id and week_start = v.week_start and status = 'pending') then
      perform public.raise_app('PENDING_ENTRIES', v.id::text);
    end if;
    perform public.refresh_payroll(v.promoter_id, v.week_start);
    select * into v from public.payrolls where id = v.id;
    update public.ledger_entries set payroll_id = v.id
     where promoter_id = v.promoter_id and week_start = v.week_start and status = 'approved' and payroll_id is null
       and category in ('debt_repayment','withdrawal','advance','expense_charge','deduction','bonus','correction');
    v_entry := null;
    if v.net_amount < 0 then
      insert into public.ledger_entries (promoter_id, manager_id, entry_date, category, amount, notes, status, created_by, approved_by, approved_at, idempotency_key)
      values (v.promoter_id, v.manager_id, v.pay_date, 'debt', -v.net_amount,
              'ترحيل رصيد سالب من أسبوع ' || v.week_start::text, 'approved', auth.uid(), auth.uid(), now(), 'carry:' || v.id::text)
      returning id into v_entry;
    end if;
    update public.payrolls set status = 'approved', approved_by = auth.uid(), approved_at = now(),
           carry_forward_debt = greatest(-net_amount, 0), payable_amount = greatest(net_amount, 0),
           carry_entry_id = v_entry
     where id = v.id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.reopen_payroll(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.payrolls;
begin
  select * into v from public.payrolls where id = p_id for update;
  if v.id is null then perform public.raise_app('NOT_FOUND', 'payroll'); end if;
  perform public.assert_manager_access(v.manager_id);
  if v.status <> 'approved' then perform public.raise_app('INVALID_STATUS'); end if;
  if exists (select 1 from public.payroll_payments where payroll_id = p_id) then perform public.raise_app('HAS_PAYMENTS'); end if;
  if length(btrim(coalesce(p_reason,''))) < 3 then perform public.raise_app('REASON_REQUIRED'); end if;
  perform public.set_reason(p_reason);
  update public.ledger_entries set payroll_id = null where payroll_id = p_id;
  if v.carry_entry_id is not null then
    update public.ledger_entries set status = 'void', void_reason = 'reopen payroll' where id = v.carry_entry_id;
  end if;
  update public.payrolls set status = 'pending', approved_by = null, approved_at = null,
         carry_forward_debt = 0, carry_entry_id = null where id = p_id;
  perform public.refresh_payroll(v.promoter_id, v.week_start);
end $$;

create or replace function public.pay_payroll(p_id uuid, p_amount bigint, p_method public.payment_method,
  p_reference text default null, p_paid_at timestamptz default null, p_notes text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o record; v_amt bigint; v_pay uuid; v_new_out bigint;
begin
  perform public.require_user();
  if p_idempotency_key is not null and exists (select 1 from public.payroll_payments where idempotency_key = p_idempotency_key) then
    return jsonb_build_object('duplicate', true);
  end if;
  perform 1 from public.payrolls where id = p_id for update;
  select * into o from public.payroll_overview where id = p_id;
  if o.id is null then perform public.raise_app('NOT_FOUND', 'payroll'); end if;
  perform public.assert_manager_access(o.manager_id);
  if o.status not in ('approved','adjusted') then perform public.raise_app('INVALID_STATUS'); end if;
  if p_method is null then perform public.raise_app('VALIDATION', 'method'); end if;
  v_amt := coalesce(p_amount, o.outstanding);
  if o.outstanding = 0 and coalesce(p_amount, 0) = 0 then
    update public.payrolls set status = case when o.status = 'adjusted' then 'adjusted'::public.payroll_status else 'paid' end,
           paid_at = coalesce(p_paid_at, now()), payment_method = p_method, payment_reference = p_reference where id = p_id;
    return jsonb_build_object('paid', 0, 'outstanding', 0);
  end if;
  if v_amt <= 0 then perform public.raise_app('VALIDATION', 'amount'); end if;
  if v_amt > o.outstanding then perform public.raise_app('OVERPAYMENT', o.outstanding::text); end if;

  insert into public.payroll_payments (payroll_id, promoter_id, manager_id, amount, method, reference, paid_at, notes, idempotency_key, created_by)
  values (p_id, o.promoter_id, o.manager_id, v_amt, p_method, nullif(p_reference,''), coalesce(p_paid_at, now()), p_notes, p_idempotency_key, auth.uid())
  returning id into v_pay;
  insert into public.ledger_entries (promoter_id, manager_id, entry_date, category, amount, notes, status, payroll_id, created_by, approved_by, approved_at, idempotency_key)
  values (o.promoter_id, o.manager_id, (coalesce(p_paid_at, now()) at time zone 'Asia/Baghdad')::date, 'salary_payment', v_amt,
          'دفع راتب أسبوع ' || o.week_start::text, 'approved', p_id, auth.uid(), auth.uid(), now(), 'pay:' || v_pay::text);
  v_new_out := o.outstanding - v_amt;
  update public.payrolls set
    status = case when v_new_out = 0 then (case when o.status = 'adjusted' then 'adjusted' else 'paid' end)::public.payroll_status else status end,
    paid_at = coalesce(p_paid_at, now()), payment_method = p_method, payment_reference = nullif(p_reference,'')
  where id = p_id;
  return jsonb_build_object('payment_id', v_pay, 'paid', v_amt, 'outstanding', v_new_out);
end $$;

-- Recalculate a paid payroll without overwriting it: records an adjustment.
create or replace function public.adjust_payroll(p_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o record; c jsonb; v_prev bigint; v_new bigint; v_delta bigint; v_out bigint; v_carry bigint := 0; v_debt uuid; v_adj uuid;
begin
  perform public.require_user();
  if length(btrim(coalesce(p_reason,''))) < 3 then perform public.raise_app('REASON_REQUIRED'); end if;
  perform 1 from public.payrolls where id = p_id for update;
  select * into o from public.payroll_overview where id = p_id;
  if o.id is null then perform public.raise_app('NOT_FOUND', 'payroll'); end if;
  perform public.assert_manager_access(o.manager_id);
  if o.status not in ('paid','adjusted') then perform public.raise_app('INVALID_STATUS'); end if;
  perform public.set_reason(p_reason);
  c := public.compute_payroll(o.promoter_id, o.week_start);
  v_prev := o.effective_net;
  v_new := (c->>'net_amount')::bigint;
  v_delta := v_new - v_prev;
  if v_delta = 0 then
    update public.payrolls set needs_recalc = false where id = p_id;
    return jsonb_build_object('delta', 0);
  end if;
  v_out := o.outstanding + v_delta;
  if v_out < 0 then
    v_carry := -v_out;
    insert into public.ledger_entries (promoter_id, manager_id, entry_date, category, amount, notes, status, created_by, approved_by, approved_at)
    values (o.promoter_id, o.manager_id, public.baghdad_today(), 'debt', v_carry,
            'فرق تسوية راتب أسبوع ' || o.week_start::text || ': ' || p_reason, 'approved', auth.uid(), auth.uid(), now())
    returning id into v_debt;
  end if;
  insert into public.payroll_adjustments (payroll_id, manager_id, previous_net, new_net, delta, carried_to_debt, debt_entry_id, old_snapshot, new_snapshot, reason, created_by)
  values (p_id, o.manager_id, v_prev, v_new, v_delta, v_carry, v_debt, o.snapshot, c, p_reason, auth.uid())
  returning id into v_adj;
  update public.payrolls set status = 'adjusted', needs_recalc = false where id = p_id;
  return jsonb_build_object('adjustment_id', v_adj, 'delta', v_delta, 'carried_to_debt', v_carry, 'outstanding', greatest(v_out, 0));
end $$;

-- =====================================================================
-- RPC: Ledger
-- =====================================================================
create or replace function public.add_ledger_entry(p jsonb)
returns public.ledger_entries language plpgsql security definer set search_path = public as $$
declare
  v_pid uuid := (p->>'promoter_id')::uuid; v_mgr uuid; v_cat public.ledger_category; v_amt bigint; v_date date;
  v_row public.ledger_entries; v_key text := nullif(p->>'idempotency_key',''); v_status public.approval_status;
  v_affects boolean;
begin
  perform public.require_user();
  if v_key is not null then
    select * into v_row from public.ledger_entries where idempotency_key = v_key;
    if v_row.id is not null then return v_row; end if;
  end if;
  v_mgr := public.assert_promoter_access(v_pid);
  begin v_cat := (p->>'category')::public.ledger_category;
  exception when others then perform public.raise_app('VALIDATION', 'category'); end;
  if v_cat = 'salary_payment' then perform public.raise_app('VALIDATION', 'category'); end if;
  if not public.is_int_text(p->>'amount') then perform public.raise_app('VALIDATION', 'amount'); end if;
  v_amt := (p->>'amount')::bigint;
  if (v_cat = 'correction' and v_amt = 0) or (v_cat <> 'correction' and v_amt <= 0) then perform public.raise_app('VALIDATION', 'amount'); end if;
  v_date := coalesce(nullif(p->>'entry_date','')::date, public.baghdad_today());
  if v_date > public.baghdad_today() then perform public.raise_app('FUTURE_DATE'); end if;
  v_affects := v_cat in ('debt_repayment','withdrawal','advance','expense_charge','deduction','bonus','correction');
  if v_affects and public.week_locked(v_pid, v_date) then perform public.raise_app('WEEK_LOCKED'); end if;
  if v_cat = 'debt_repayment' and v_amt > public.debt_balance(v_pid) then perform public.raise_app('EXCEEDS_DEBT', public.debt_balance(v_pid)::text); end if;
  if length(btrim(coalesce(p->>'notes',''))) = 0 and v_cat in ('correction','deduction') then perform public.raise_app('REASON_REQUIRED'); end if;

  v_status := case when (select ledger_requires_approval from public.settings where id = 1) and not public.is_admin()
                   then 'pending' else 'approved' end;
  insert into public.ledger_entries (promoter_id, manager_id, entry_date, category, amount, notes, status, created_by,
                                     approved_by, approved_at, idempotency_key, expense_id)
  values (v_pid, v_mgr, v_date, v_cat, v_amt, nullif(p->>'notes',''), v_status, auth.uid(),
          case when v_status = 'approved' then auth.uid() end, case when v_status = 'approved' then now() end,
          v_key, nullif(p->>'expense_id','')::uuid)
  returning * into v_row;
  if v_affects then perform public.refresh_payroll(v_pid, v_date); end if;
  return v_row;
end $$;

create or replace function public.review_ledger_entry(p_id uuid, p_decision public.approval_status, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v public.ledger_entries;
begin
  perform public.require_admin();
  select * into v from public.ledger_entries where id = p_id for update;
  if v.id is null then perform public.raise_app('NOT_FOUND'); end if;
  if v.status <> 'pending' or p_decision not in ('approved','rejected') then perform public.raise_app('INVALID_STATUS'); end if;
  if p_decision = 'approved' and v.category = 'debt_repayment' and v.amount > public.debt_balance(v.promoter_id) then
    perform public.raise_app('EXCEEDS_DEBT');
  end if;
  perform public.set_reason(p_note);
  update public.ledger_entries set status = p_decision, approved_by = auth.uid(), approved_at = now(),
         void_reason = case when p_decision = 'rejected' then p_note end
   where id = p_id;
  perform public.refresh_payroll(v.promoter_id, v.entry_date);
end $$;

create or replace function public.void_ledger_entry(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.ledger_entries;
begin
  perform public.require_user();
  if length(btrim(coalesce(p_reason,''))) < 3 then perform public.raise_app('REASON_REQUIRED'); end if;
  select * into v from public.ledger_entries where id = p_id for update;
  if v.id is null then perform public.raise_app('NOT_FOUND'); end if;
  perform public.assert_manager_access(v.manager_id);
  if v.status in ('void','rejected') then perform public.raise_app('INVALID_STATUS'); end if;
  if v.payroll_id is not null or v.category = 'salary_payment' then perform public.raise_app('ENTRY_CONSUMED'); end if;
  if v.category in ('debt_repayment','withdrawal','advance','expense_charge','deduction','bonus','correction')
     and public.week_locked(v.promoter_id, v.entry_date) then perform public.raise_app('WEEK_LOCKED'); end if;
  if v.category in ('opening_debt','debt') and public.debt_balance(v.promoter_id) - v.amount < 0 then
    perform public.raise_app('DEBT_NEGATIVE');
  end if;
  perform public.set_reason(p_reason);
  update public.ledger_entries set status = 'void', void_reason = p_reason where id = p_id;
  perform public.refresh_payroll(v.promoter_id, v.entry_date);
end $$;

-- =====================================================================
-- RPC: Expenses
-- =====================================================================
create or replace function public.add_expense(p jsonb)
returns public.expenses language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := public.require_user(); v_mgr uuid; v_row public.expenses; v_key text := nullif(p->>'idempotency_key','');
  v_pid uuid := nullif(p->>'charged_promoter_id','')::uuid; v_entry public.ledger_entries; v_date date;
begin
  if v_key is not null then
    select * into v_row from public.expenses where idempotency_key = v_key;
    if v_row.id is not null then return v_row; end if;
  end if;
  v_mgr := case when v_role = 'super_admin' then nullif(p->>'manager_id','')::uuid else auth.uid() end;
  if not exists (select 1 from public.profiles where id = v_mgr and role = 'manager') then perform public.raise_app('VALIDATION', 'manager_id'); end if;
  if not public.is_int_text(p->>'amount') or (p->>'amount')::bigint <= 0 then perform public.raise_app('VALIDATION', 'amount'); end if;
  if not exists (select 1 from public.expense_categories where key = p->>'category') then perform public.raise_app('VALIDATION', 'category'); end if;
  if length(btrim(coalesce(p->>'description',''))) < 2 then perform public.raise_app('VALIDATION', 'description'); end if;
  v_date := coalesce(nullif(p->>'expense_date','')::date, public.baghdad_today());
  if v_date > public.baghdad_today() then perform public.raise_app('FUTURE_DATE'); end if;
  if v_pid is not null and (select manager_id from public.promoters where id = v_pid and deleted_at is null) is distinct from v_mgr then
    perform public.raise_app('VALIDATION', 'charged_promoter_id');
  end if;

  insert into public.expenses (manager_id, expense_date, category, description, amount, attachment_path, charged_promoter_id, idempotency_key, created_by)
  values (v_mgr, v_date, p->>'category', btrim(p->>'description'), (p->>'amount')::bigint,
          nullif(p->>'attachment_path',''), v_pid, v_key, auth.uid())
  returning * into v_row;
  if v_pid is not null then
    v_entry := public.add_ledger_entry(jsonb_build_object('promoter_id', v_pid, 'category', 'expense_charge',
               'amount', v_row.amount, 'entry_date', v_row.expense_date, 'notes', v_row.description, 'expense_id', v_row.id,
               'idempotency_key', 'exp:' || v_row.id::text));
    update public.expenses set ledger_entry_id = v_entry.id where id = v_row.id returning * into v_row;
  end if;
  return v_row;
end $$;

create or replace function public.void_expense(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare v public.expenses;
begin
  perform public.require_user();
  if length(btrim(coalesce(p_reason,''))) < 3 then perform public.raise_app('REASON_REQUIRED'); end if;
  select * into v from public.expenses where id = p_id for update;
  if v.id is null then perform public.raise_app('NOT_FOUND'); end if;
  perform public.assert_manager_access(v.manager_id);
  if v.status = 'void' then perform public.raise_app('INVALID_STATUS'); end if;
  if v.ledger_entry_id is not null then perform public.void_ledger_entry(v.ledger_entry_id, p_reason); end if;
  perform public.set_reason(p_reason);
  update public.expenses set status = 'void', void_reason = p_reason where id = p_id;
end $$;

-- =====================================================================
-- RPC: Dashboard & reports
-- =====================================================================
create or replace function public.get_dashboard(p_from date, p_to date, p_manager uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_mgr uuid := public.scope_manager(p_manager);
  v_today date := public.baghdad_today();
  v_ws date := public.week_start_of(public.baghdad_today());
  v_ms date := date_trunc('month', public.baghdad_today())::date;
  k jsonb; v_series jsonb; v_managers jsonb; v_top jsonb; v_exp_cat jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then perform public.raise_app('VALIDATION', 'range'); end if;
  if p_to - p_from > 800 then perform public.raise_app('RANGE_TOO_LARGE'); end if;

  with reg as (
    select r.*, p.start_date from public.registrations r join public.promoters p on p.id = r.promoter_id
     where (v_mgr is null or r.manager_id = v_mgr)
  ), rng as (
    select reg.*, public.calc_incentive((select to_jsonb(ir) from public.incentive_rules ir where ir.work_date = reg.work_date),
                                       reg.reg_count, reg.work_date - reg.start_date, reg.manager_id) inc
      from reg where work_date between p_from and p_to
  ), led as (
    select * from public.ledger_entries where status = 'approved' and (v_mgr is null or manager_id = v_mgr)
  ), pay as (
    select * from public.payroll_overview where (v_mgr is null or manager_id = v_mgr)
  )
  select jsonb_build_object(
    'today',          (select coalesce(sum(reg_count),0) from reg where work_date = v_today),
    'last_24h',       (select coalesce(sum(reg_count),0) from reg where greatest(created_at, updated_at) >= now() - interval '24 hours'),
    'this_week',      (select coalesce(sum(reg_count),0) from reg where work_date between v_ws and v_ws + 6),
    'this_month',     (select coalesce(sum(reg_count),0) from reg where work_date >= v_ms and work_date <= v_today),
    'range_registrations', (select coalesce(sum(reg_count),0) from rng),
    'range_revenue',  (select coalesce(sum(reg_count::bigint * rate),0) from rng),
    'range_incentives', (select coalesce(sum(inc),0) from rng),
    'payroll_liabilities', (select coalesce(sum(outstanding),0) from pay where status in ('pending','approved','adjusted')),
    'unpaid_salaries', (select coalesce(sum(outstanding),0) from pay where status in ('approved','adjusted')),
    'paid_salaries',  (select coalesce(sum(pp.amount),0) from public.payroll_payments pp
                        where (v_mgr is null or pp.manager_id = v_mgr)
                          and (pp.paid_at at time zone 'Asia/Baghdad')::date between p_from and p_to),
    'outstanding_debts', (select coalesce(sum(case when category in ('opening_debt','debt') then amount when category='debt_repayment' then -amount end),0) from led),
    'withdrawals',    (select coalesce(sum(amount),0) from led where category in ('withdrawal','advance') and entry_date between p_from and p_to),
    'expenses',       (select coalesce(sum(amount),0) from public.expenses e where e.status = 'approved'
                        and (v_mgr is null or e.manager_id = v_mgr) and e.expense_date between p_from and p_to),
    'active_promoters', (select count(*) from public.promoters p where p.deleted_at is null and p.status = 'active'
                        and (v_mgr is null or p.manager_id = v_mgr))
  ) into k;

  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'registrations', regs, 'revenue', rev) order by d), '[]') into v_series
    from (select g.d::date d, coalesce(sum(r.reg_count),0) regs, coalesce(sum(r.reg_count::bigint * r.rate),0) rev
            from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g(d)
            left join public.registrations r on r.work_date = g.d::date and (v_mgr is null or r.manager_id = v_mgr)
           group by 1) s;

  select coalesce(jsonb_agg(x order by (x->>'registrations')::bigint desc), '[]') into v_managers from (
    select jsonb_build_object('manager_id', m.id, 'manager_name', m.full_name,
      'registrations', coalesce((select sum(reg_count) from public.registrations r where r.manager_id = m.id and r.work_date between p_from and p_to),0),
      'revenue', coalesce((select sum(reg_count::bigint*rate) from public.registrations r where r.manager_id = m.id and r.work_date between p_from and p_to),0),
      'promoters', (select count(*) from public.promoters p where p.manager_id = m.id and p.deleted_at is null and p.status = 'active'),
      'expenses', coalesce((select sum(amount) from public.expenses e where e.manager_id = m.id and e.status='approved' and e.expense_date between p_from and p_to),0)) x
    from public.profiles m where m.role = 'manager' and (v_mgr is null or m.id = v_mgr)
      and (m.status = 'active' or exists (select 1 from public.promoters p where p.manager_id = m.id))) t;

  select coalesce(jsonb_agg(x), '[]') into v_top from (
    select jsonb_build_object('promoter_id', p.id, 'full_name', p.full_name, 'manager_name', m.full_name,
           'registrations', sum(r.reg_count), 'revenue', sum(r.reg_count::bigint * r.rate), 'days', count(*) filter (where r.reg_count > 0)) x
      from public.registrations r join public.promoters p on p.id = r.promoter_id join public.profiles m on m.id = p.manager_id
     where r.work_date between p_from and p_to and (v_mgr is null or r.manager_id = v_mgr)
     group by p.id, p.full_name, m.full_name having sum(r.reg_count) > 0
     order by sum(r.reg_count) desc, p.full_name limit 10) t;

  select coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount', amt) order by amt desc), '[]') into v_exp_cat
    from (select category, sum(amount) amt from public.expenses where status = 'approved'
           and (v_mgr is null or manager_id = v_mgr) and expense_date between p_from and p_to group by category) e;

  return jsonb_build_object('kpis', k, 'series', v_series, 'managers', v_managers, 'top_promoters', v_top,
                            'expenses_by_category', v_exp_cat, 'base_rate', (select base_rate from public.settings where id=1),
                            'generated_at', now());
end $$;

create or replace function public.report_performance(p_from date, p_to date, p_manager uuid default null)
returns table (promoter_id uuid, full_name text, phone text, manager_name text, status public.promoter_status,
               registrations bigint, days_worked bigint, base_amount bigint, incentive_amount bigint,
               withdrawals bigint, deductions bigint, bonuses bigint, debt_balance bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_mgr uuid := public.scope_manager(p_manager);
begin
  return query
  select p.id, p.full_name, p.phone, m.full_name, p.status,
    coalesce(sum(r.reg_count),0)::bigint,
    count(r.id) filter (where r.reg_count > 0),
    coalesce(sum(r.reg_count::bigint * r.rate),0)::bigint,
    coalesce(sum(public.calc_incentive((select to_jsonb(ir) from public.incentive_rules ir where ir.work_date = r.work_date),
             r.reg_count, r.work_date - p.start_date, p.manager_id)),0)::bigint,
    (select coalesce(sum(amount),0) from public.ledger_entries l where l.promoter_id = p.id and l.status='approved'
       and l.category in ('withdrawal','advance') and l.entry_date between p_from and p_to)::bigint,
    (select coalesce(sum(amount),0) from public.ledger_entries l where l.promoter_id = p.id and l.status='approved'
       and l.category in ('deduction','expense_charge','debt_repayment') and l.entry_date between p_from and p_to)::bigint,
    (select coalesce(sum(amount),0) from public.ledger_entries l where l.promoter_id = p.id and l.status='approved'
       and l.category = 'bonus' and l.entry_date between p_from and p_to)::bigint,
    public.debt_balance(p.id)
  from public.promoters p
  join public.profiles m on m.id = p.manager_id
  left join public.registrations r on r.promoter_id = p.id and r.work_date between p_from and p_to
  where p.deleted_at is null and (v_mgr is null or p.manager_id = v_mgr)
  group by p.id, p.full_name, p.phone, m.full_name, p.status, p.manager_id, p.start_date
  order by 6 desc, 2;
end $$;

create or replace function public.expense_summary(p_from date, p_to date, p_group text default 'day', p_manager uuid default null)
returns table (bucket date, category text, total bigint, items bigint)
language plpgsql stable security definer set search_path = public as $$
declare v_mgr uuid := public.scope_manager(p_manager);
begin
  if p_group not in ('day','week','month') then perform public.raise_app('VALIDATION', 'group'); end if;
  return query
  select case p_group when 'day' then e.expense_date when 'week' then e.week_start
              else date_trunc('month', e.expense_date)::date end,
         e.category, sum(e.amount)::bigint, count(*)
    from public.expenses e
   where e.status = 'approved' and e.expense_date between p_from and p_to and (v_mgr is null or e.manager_id = v_mgr)
   group by 1, 2 order by 1, 2;
end $$;

-- =====================================================================
-- RPC: Administration
-- =====================================================================
create or replace function public.update_manager(p_id uuid, p jsonb)
returns public.profiles language plpgsql security definer set search_path = public as $$
declare v public.profiles;
begin
  perform public.require_admin();
  update public.profiles set full_name = coalesce(nullif(btrim(p->>'full_name'),''), full_name),
         phone = coalesce(p->>'phone', phone), notes = coalesce(p->>'notes', notes)
   where id = p_id and role = 'manager' returning * into v;
  if v.id is null then perform public.raise_app('NOT_FOUND'); end if;
  return v;
end $$;

create or replace function public.set_manager_status(p_id uuid, p_status public.account_status, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if p_id = auth.uid() then perform public.raise_app('FORBIDDEN', 'self'); end if;
  if p_status = 'deleted' and exists (select 1 from public.promoters where manager_id = p_id and deleted_at is null) then
    perform public.raise_app('HAS_PROMOTERS');
  end if;
  perform public.set_reason(p_reason);
  update public.profiles set status = p_status where id = p_id and role = 'manager';
  if not found then perform public.raise_app('NOT_FOUND'); end if;
end $$;

create or replace function public.update_settings(p jsonb)
returns public.settings language plpgsql security definer set search_path = public as $$
declare v public.settings;
begin
  perform public.require_admin();
  if p ? 'base_rate' and (not public.is_int_text(p->>'base_rate') or (p->>'base_rate')::bigint < 0) then perform public.raise_app('VALIDATION','base_rate'); end if;
  if p ? 'default_extra_amount' and (not public.is_int_text(p->>'default_extra_amount') or (p->>'default_extra_amount')::bigint < 0) then perform public.raise_app('VALIDATION','default_extra_amount'); end if;
  update public.settings set
    company_name = coalesce(nullif(btrim(p->>'company_name'),''), company_name),
    base_rate = coalesce((p->>'base_rate')::bigint, base_rate),
    default_extra_amount = coalesce((p->>'default_extra_amount')::bigint, default_extra_amount),
    ledger_requires_approval = coalesce((p->>'ledger_requires_approval')::boolean, ledger_requires_approval),
    max_daily_registrations = coalesce((p->>'max_daily_registrations')::int, max_daily_registrations),
    updated_by = auth.uid()
  where id = 1 returning * into v;
  return v;
end $$;

create or replace function public.add_expense_category(p_key text, p_name_ar text, p_name_en text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  insert into public.expense_categories (key, name_ar, name_en) values (lower(p_key), p_name_ar, p_name_en);
exception when unique_violation then perform public.raise_app('DUPLICATE');
          when check_violation then perform public.raise_app('VALIDATION', 'key');
end $$;

-- Run ONCE from the SQL editor (as postgres) to promote the first account.
create or replace function public.bootstrap_super_admin(p_email text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.profiles where role = 'super_admin' and status = 'active') then
    perform public.raise_app('ALREADY_BOOTSTRAPPED');
  end if;
  update public.profiles set role = 'super_admin', status = 'active' where lower(email) = lower(p_email);
  if not found then perform public.raise_app('NOT_FOUND', p_email); end if;
end $$;
