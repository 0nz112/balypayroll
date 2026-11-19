-- =====================================================================
-- Daily bonus → manual tiers per manager per day
--   tier2 / tier3 / tier4 / tier5 : amount entered by hand for reaching 2, 3, 4, 5 cars
--   Only the HIGHEST tier reached is paid (5 cars → the 5-car amount only, not the lower ones).
--   extra_enabled + extra_amount  : optional amount (entered by hand) added for EACH car
--                                   from the 6th car onwards.
--   applies_to                    : count all cars, or active cars only.
-- No amounts are predefined.
-- =====================================================================
alter table public.daily_bonuses add column if not exists tier2 bigint not null default 0;
alter table public.daily_bonuses add column if not exists tier3 bigint not null default 0;
alter table public.daily_bonuses add column if not exists tier4 bigint not null default 0;
alter table public.daily_bonuses add column if not exists tier5 bigint not null default 0;
alter table public.daily_bonuses add column if not exists extra_enabled boolean not null default false;
alter table public.daily_bonuses add column if not exists extra_amount bigint not null default 0;
alter table public.daily_bonuses drop constraint if exists daily_bonuses_tiers_chk;
alter table public.daily_bonuses add constraint daily_bonuses_tiers_chk
  check (tier2 >= 0 and tier3 >= 0 and tier4 >= 0 and tier5 >= 0 and extra_amount >= 0);

-- carry over any bonus saved with the previous single-amount format
update public.daily_bonuses set
  tier2 = case when mode = 'fixed' and greatest(least(min_cars, 5), 2) = 2 then amount else tier2 end,
  tier3 = case when mode = 'fixed' and greatest(least(min_cars, 5), 2) = 3 then amount else tier3 end,
  tier4 = case when mode = 'fixed' and greatest(least(min_cars, 5), 2) = 4 then amount else tier4 end,
  tier5 = case when mode = 'fixed' and greatest(least(min_cars, 5), 2) = 5 then amount else tier5 end
where tier2 = 0 and tier3 = 0 and tier4 = 0 and tier5 = 0 and amount > 0;

-- mirrored by src/engine/incentives.js → calcDailyBonus
create or replace function public.calc_daily_bonus(p_bonus jsonb, p_count int, p_active int) returns bigint
language plpgsql immutable as $$
declare units int; k int; amt bigint := 0; v bigint;
begin
  if p_bonus is null or not coalesce((p_bonus->>'enabled')::boolean, false) or coalesce(p_count, 0) <= 0 then return 0; end if;
  units := case when p_bonus->>'applies_to' = 'active' then least(coalesce(p_active, 0), p_count) else p_count end;
  if units < 2 then return 0; end if;
  k := least(units, 5);
  while k >= 2 loop                       -- highest tier reached that has an amount
    v := coalesce((p_bonus->>('tier' || k))::bigint, 0);
    if v > 0 then amt := v; exit; end if;
    k := k - 1;
  end loop;
  if units > 5 and coalesce((p_bonus->>'extra_enabled')::boolean, false) then
    amt := amt + (units - 5)::bigint * coalesce((p_bonus->>'extra_amount')::bigint, 0);
  end if;
  return amt;
end $$;

create or replace function public.save_daily_bonus(p_date date, p_manager uuid, p jsonb, p_reason text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_role public.app_role := public.require_user(); m uuid; n int := 0; r record; k text;
  v_reason text := nullif(btrim(coalesce(p_reason,'')), '');
begin
  if p_date is null then perform public.raise_app('VALIDATION', 'date'); end if;
  foreach k in array array['tier2','tier3','tier4','tier5','extra_amount'] loop
    if not public.is_int_text(coalesce(p->>k, '0')) or coalesce((p->>k)::bigint, 0) < 0 then perform public.raise_app('VALIDATION', k); end if;
  end loop;
  if coalesce(p->>'applies_to', 'all') not in ('all','active') then perform public.raise_app('VALIDATION', 'applies_to'); end if;
  perform public.set_reason(v_reason);
  for m in
    select id from public.profiles
     where role = 'manager' and status = 'active'
       and (case when v_role = 'super_admin' then (p_manager is null or id = p_manager) else id = auth.uid() end)
  loop
    if exists (select 1 from public.payrolls where manager_id = m and week_start = public.week_start_of(p_date) and status <> 'pending')
       and (v_reason is null or length(v_reason) < 3) then perform public.raise_app('RULE_LOCKED', p_date::text); end if;
    insert into public.daily_bonuses as b (work_date, manager_id, enabled, amount, min_cars, mode, applies_to,
        tier2, tier3, tier4, tier5, extra_enabled, extra_amount, notes, updated_by)
    values (p_date, m, coalesce((p->>'enabled')::boolean, true), 0, 2, 'fixed', coalesce(p->>'applies_to','all'),
        coalesce((p->>'tier2')::bigint, 0), coalesce((p->>'tier3')::bigint, 0), coalesce((p->>'tier4')::bigint, 0), coalesce((p->>'tier5')::bigint, 0),
        coalesce((p->>'extra_enabled')::boolean, false), coalesce((p->>'extra_amount')::bigint, 0), nullif(p->>'notes',''), auth.uid())
    on conflict (work_date, manager_id) do update set enabled = excluded.enabled, applies_to = excluded.applies_to,
      tier2 = excluded.tier2, tier3 = excluded.tier3, tier4 = excluded.tier4, tier5 = excluded.tier5,
      extra_enabled = excluded.extra_enabled, extra_amount = excluded.extra_amount, notes = excluded.notes,
      updated_by = excluded.updated_by, version = b.version + 1;
    n := n + 1;
    for r in select promoter_id from public.registrations where work_date = p_date and manager_id = m and reg_count > 0 loop
      perform public.refresh_payroll(r.promoter_id, p_date);
    end loop;
  end loop;
  if n = 0 then perform public.raise_app('FORBIDDEN'); end if;
  return n;
end $$;

revoke execute on all functions in schema public from public, anon;
grant execute on function public.calc_daily_bonus(jsonb, int, int), public.save_daily_bonus(date, uuid, jsonb, text) to authenticated;
