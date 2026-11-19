-- End-to-end workflow & security test. Runs in a transaction and rolls back.
--   psql -v ON_ERROR_STOP=1 -f db/tests/10_workflow_test.sql "$DATABASE_URL"
\set QUIET on
\pset tuples_only on
begin;

create or replace function pg_temp.expect_error(p_sql text, p_code text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED ERROR % BUT SUCCEEDED: %', p_code, p_sql;
exception when others then
  if sqlerrm not like p_code || '%' then raise exception 'EXPECTED % GOT %  (%)', p_code, sqlerrm, p_sql; end if;
end $$;
create or replace function pg_temp.ok(label text, cond boolean) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'ASSERT FAILED: %', label; end if; end $$;
create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, false)
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- Fixed ids
\set admin  '''a0000000-0000-0000-0000-000000000001'''
\set mgr_a  '''a0000000-0000-0000-0000-00000000000a'''
\set mgr_b  '''a0000000-0000-0000-0000-00000000000b'''

insert into auth.users (id, email, raw_app_meta_data) values
  (:admin, 'admin@test.local', '{"role":"super_admin","status":"active","full_name":"المدير العام"}'),
  (:mgr_a, 'a@test.local', '{"status":"active","full_name":"مدير أ"}'),
  (:mgr_b, 'b@test.local', '{"status":"active","full_name":"مدير ب"}');
-- user_metadata cannot escalate role
insert into auth.users (id, email, raw_user_meta_data) values ('a0000000-0000-0000-0000-0000000000ee', 'evil@test.local', '{"role":"super_admin"}');
select pg_temp.ok('user_metadata cannot grant admin', (select role = 'manager' and status = 'suspended' from public.profiles where email = 'evil@test.local'));

create temp table ctx (k text primary key, v text);
grant all on ctx to authenticated;
insert into ctx values ('last_ws', (public.week_start_of(public.baghdad_today()) - 7)::text);

-- ============ Manager A creates promoters ============
set role authenticated;
select pg_temp.as_user(:mgr_a);
insert into ctx select 'p1', (public.upsert_promoter(jsonb_build_object('full_name','علي حسن','phone','0770 111 2222','start_date',(select v::date - 60 from ctx where k='last_ws')))).id;
insert into ctx select 'p2', (public.upsert_promoter(jsonb_build_object('full_name','زينب كريم','phone','07702223333','start_date',(select v::date - 60 from ctx where k='last_ws')))).id;
select pg_temp.ok('phone normalised', (select phone = '07701112222' from public.promoters where id = (select v::uuid from ctx where k='p1')));
select pg_temp.expect_error($$select public.upsert_promoter('{"full_name":"مكرر","phone":"07701112222","start_date":"2026-01-01"}')$$, 'DUPLICATE_PHONE');
select pg_temp.expect_error($$select public.upsert_promoter('{"full_name":"x","phone":"0770","start_date":"2026-01-01"}')$$, 'VALIDATION');

-- direct writes are blocked
select pg_temp.expect_error($$insert into public.promoters (manager_id, full_name, phone, start_date) values (auth.uid(), 'hack', '07709999999', '2026-01-01')$$, 'permission denied');
select pg_temp.expect_error($$update public.registrations set reg_count = 100$$, 'permission denied');
select pg_temp.expect_error($$delete from public.ledger_entries$$, 'permission denied');
select pg_temp.expect_error($$select public.compute_payroll((select v::uuid from ctx where k='p1'), current_date)$$, 'permission denied');
select pg_temp.expect_error($$select public.bootstrap_super_admin('a@test.local')$$, 'permission denied');

-- ============ Registrations ============
select public.save_registrations((select v::date + 1 from ctx where k='last_ws'),
  jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'count', 6),
                    jsonb_build_object('promoter_id', (select v from ctx where k='p2'), 'count', 2)));
-- duplicate daily entry rejected without explicit edit reason
select pg_temp.expect_error(format($$select public.save_registrations(%L, jsonb_build_array(jsonb_build_object('promoter_id', %L, 'count', 7)))$$,
  (select v::date + 1 from ctx where k='last_ws'), (select v from ctx where k='p1')), 'DUPLICATE_ENTRY');
-- same count → unchanged, no error
select pg_temp.ok('unchanged ok', (select public.save_registrations((select v::date + 1 from ctx where k='last_ws'),
  jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'count', 6)))->0->>'action' = 'unchanged'));
-- authorised edit with reason + optimistic version
select public.save_registrations((select v::date + 1 from ctx where k='last_ws'),
  jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'count', 7, 'active', 5, 'expected_version', 1)), 'تصحيح العدد');
-- changing only how many cars became active (status) needs no reason
select pg_temp.ok('status update without reason', (select public.save_registrations((select v::date + 1 from ctx where k='last_ws'),
  jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p2'), 'count', 2, 'active', 1)))->0->>'action' = 'updated'));
select pg_temp.expect_error(format($$select public.save_registrations(%L, jsonb_build_array(jsonb_build_object('promoter_id', %L, 'count', 2, 'active', 3)))$$,
  (select v::date + 1 from ctx where k='last_ws'), (select v from ctx where k='p2')), 'INVALID_ACTIVE');
select pg_temp.expect_error(format($$select public.save_registrations(%L, jsonb_build_array(jsonb_build_object('promoter_id', %L, 'count', 8, 'expected_version', 1)), 'stale edit')$$,
  (select v::date + 1 from ctx where k='last_ws'), (select v from ctx where k='p1')), 'CONFLICT');
select pg_temp.ok('history kept', (select count(*) = 2 from public.registration_history where promoter_id = (select v::uuid from ctx where k='p1')));
select pg_temp.expect_error(format($$select public.save_registrations(%L, '[]')$$, public.baghdad_today() + 1), 'FUTURE_DATE');
select pg_temp.expect_error(format($$select public.save_registrations(%L, jsonb_build_array(jsonb_build_object('promoter_id', %L, 'count', -1)))$$,
  (select v::date from ctx where k='last_ws'), (select v from ctx where k='p1')), 'INVALID_COUNT');

-- ============ Isolation: manager B sees nothing of A ============
select pg_temp.as_user(:mgr_b);
select pg_temp.ok('B sees no A promoters', (select count(*) = 0 from public.promoters));
select pg_temp.ok('B sees no A registrations', (select count(*) = 0 from public.registrations));
select pg_temp.ok('B sees no A balances view', (select count(*) = 0 from public.promoter_balances));
select pg_temp.ok('B sees only own profile', (select count(*) = 1 from public.profiles));
select pg_temp.expect_error(format($$select public.save_registrations(%L, jsonb_build_array(jsonb_build_object('promoter_id', %L, 'count', 3)))$$,
  (select v::date from ctx where k='last_ws'), (select v from ctx where k='p1')), 'FORBIDDEN');
select pg_temp.expect_error(format($$select public.add_ledger_entry(jsonb_build_object('promoter_id', %L, 'category', 'withdrawal', 'amount', 1000))$$,
  (select v from ctx where k='p1')), 'FORBIDDEN');
select pg_temp.ok('B dashboard is empty', (select (public.get_dashboard(current_date - 30, current_date, :mgr_a)->'kpis'->>'range_registrations')::int = 0));
select pg_temp.expect_error($$select public.save_incentive_rule(array[current_date], '{"is_incentive_day":true}')$$, 'FORBIDDEN');
select pg_temp.expect_error($$select count(*) from public.audit_log having count(*) > 0$$, 'EXPECTED');  -- returns 0 rows → "succeeds"
select pg_temp.ok('B cannot read audit', (select count(*) = 0 from public.audit_log));

-- ============ Admin configures incentives ============
select pg_temp.as_user(:admin);
select public.save_incentive_rule(array[(select v::date + 1 from ctx where k='last_ws')],
  '{"is_incentive_day":true,"per_car_amount":2000,"applies_to":"all","min_cars":1}');
select pg_temp.expect_error($$select public.save_incentive_rule(array[current_date], '{"per_car_amount":-5}')$$, 'INVALID_RULE');
select pg_temp.expect_error($$select public.save_incentive_rule(array[current_date], '{"applies_to":"x"}')$$, 'INVALID_RULE');
select pg_temp.ok('admin sees all promoters', (select count(*) = 2 from public.promoters));

-- ============ Ledger ============
select pg_temp.as_user(:mgr_a);
select public.add_ledger_entry(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'category', 'opening_debt', 'amount', 100000,
  'entry_date', (select v::date - 30 from ctx where k='last_ws'), 'notes', 'دين قديم'));
insert into ctx select 'w1', (public.add_ledger_entry(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'category', 'withdrawal',
  'amount', 20000, 'entry_date', (select v::date + 2 from ctx where k='last_ws'), 'idempotency_key', 'k-1'))).id;
-- same idempotency key → same row, no duplicate
select pg_temp.ok('idempotent', (select (public.add_ledger_entry(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'category', 'withdrawal',
  'amount', 20000, 'entry_date', (select v::date + 2 from ctx where k='last_ws'), 'idempotency_key', 'k-1'))).id::text = (select v from ctx where k='w1')));
select pg_temp.ok('one withdrawal row', (select count(*) = 1 from public.ledger_entries where category = 'withdrawal'));
select public.add_ledger_entry(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'category', 'debt_repayment', 'amount', 30000,
  'entry_date', (select v::date + 3 from ctx where k='last_ws')));
select pg_temp.expect_error(format($$select public.add_ledger_entry(jsonb_build_object('promoter_id', %L, 'category', 'debt_repayment', 'amount', 999999))$$,
  (select v from ctx where k='p1')), 'EXCEEDS_DEBT');
select pg_temp.expect_error(format($$select public.add_ledger_entry(jsonb_build_object('promoter_id', %L, 'category', 'withdrawal', 'amount', 10.5))$$,
  (select v from ctx where k='p1')), 'VALIDATION');
select pg_temp.expect_error(format($$select public.add_ledger_entry(jsonb_build_object('promoter_id', %L, 'category', 'salary_payment', 'amount', 1000))$$,
  (select v from ctx where k='p1')), 'VALIDATION');
select pg_temp.ok('debt separate from withdrawals', (select debt_balance = 70000 and withdrawals_total = 20000
  from public.promoter_balances where id = (select v::uuid from ctx where k='p1')));

-- ============ Expense charged to promoter ============
select public.add_expense(jsonb_build_object('category','harqiyat','description','حرقيات الفريق','amount',12000,
  'expense_date', (select v::date + 2 from ctx where k='last_ws')));
select public.add_expense(jsonb_build_object('category','fuel','description','وقود على المروج','amount',5000,
  'expense_date', (select v::date + 2 from ctx where k='last_ws'), 'charged_promoter_id', (select v from ctx where k='p1')));
select pg_temp.ok('expense charge in ledger', (select count(*) = 1 from public.ledger_entries where category = 'expense_charge'));

-- ============ Payroll ============
-- p1: 7 cars, 5 active (71% ≥ 60%, 7 > 5) → bonus rate 7 × 15000 = 105000; incentive 7 × 2000 = 14000
-- deductions: withdrawal 20000 + debt repay 30000 + expense charge 5000 = 55000 → net 64000
select public.generate_payrolls((select v::date from ctx where k='last_ws'));
select pg_temp.ok('payroll computed', (select reg_count = 7 and active_count = 5 and bonus_applied and base_amount = 105000 and incentive_amount = 14000
  and total_deductions = 55000 and net_amount = 64000 and status = 'pending'
  from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')));
-- p2: 2 cars, 1 active → 1 × 3000 + 1 × 6000 = 9000 (no bonus: not more than 5 cars); incentive 2 × 2000
select pg_temp.ok('p2 payroll', (select base_amount = 9000 and incentive_amount = 4000 and not bonus_applied from public.payrolls where promoter_id = (select v::uuid from ctx where k='p2')));
select public.approve_payrolls(array(select id from public.payrolls where week_start = (select v::date from ctx where k='last_ws')));
select pg_temp.ok('entries linked to payroll (no double deduction)', (select count(*) = 3 from public.ledger_entries where payroll_id is not null));
select pg_temp.expect_error(format($$select public.add_ledger_entry(jsonb_build_object('promoter_id', %L, 'category', 'withdrawal', 'amount', 1000, 'entry_date', %L))$$,
  (select v from ctx where k='p1'), (select v::date + 4 from ctx where k='last_ws')), 'WEEK_LOCKED');
select pg_temp.expect_error(format($$select public.void_ledger_entry(%L, 'oops')$$, (select v from ctx where k='w1')), 'ENTRY_CONSUMED');
select pg_temp.expect_error(format($$select public.save_registrations(%L, jsonb_build_array(jsonb_build_object('promoter_id', %L, 'count', 4)))$$,
  (select v::date + 5 from ctx where k='last_ws'), (select v from ctx where k='p1')), 'WEEK_LOCKED');

-- pay: overpayment rejected, then full payment
select pg_temp.expect_error(format($$select public.pay_payroll(%L, 999999, 'cash')$$,
  (select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1'))), 'OVERPAYMENT');
select public.pay_payroll((select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')), 50000, 'cash', null, null, 'دفعة أولى', 'pay-1');
select pg_temp.ok('partial keeps approved', (select status = 'approved' and outstanding = 14000 from public.payroll_overview where promoter_id = (select v::uuid from ctx where k='p1')));
select pg_temp.ok('duplicate payment ignored', (select (public.pay_payroll((select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')), 50000, 'cash', null, null, null, 'pay-1'))->>'duplicate' = 'true'));
select public.pay_payroll((select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')), null, 'zain_cash', 'ZC-7781');
select pg_temp.ok('paid', (select status = 'paid' and outstanding = 0 and paid_total = 64000 from public.payroll_overview where promoter_id = (select v::uuid from ctx where k='p1')));
select pg_temp.ok('salary payment ledger rows', (select count(*) = 2 from public.ledger_entries where category = 'salary_payment'));
select pg_temp.expect_error(format($$select public.pay_payroll(%L, 1, 'cash')$$,
  (select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1'))), 'INVALID_STATUS');

-- authorised edit of a paid week → flagged, then adjustment transaction (no silent overwrite)
select public.save_registrations((select v::date + 1 from ctx where k='last_ws'),
  jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'count', 8)), 'تسجيل متأخر مؤكد');
select pg_temp.ok('needs recalc flagged, amounts untouched', (select needs_recalc and net_amount = 64000 from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')));
select public.adjust_payroll((select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')), 'تسوية تسجيل متأخر');
-- 8 cars, 5 active (62.5%) → 8 × 15000 = 120000; incentive 16000 → net 81000 → delta 17000
select pg_temp.ok('adjusted', (select status = 'adjusted' and effective_net = 81000 and outstanding = 17000 and net_amount = 64000
  from public.payroll_overview where promoter_id = (select v::uuid from ctx where k='p1')));
select public.pay_payroll((select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')), null, 'cash');
select pg_temp.ok('adjustment paid', (select outstanding = 0 from public.payroll_overview where promoter_id = (select v::uuid from ctx where k='p1')));

-- ============ Pricing plans (prices are configurable; history is preserved) ============
select pg_temp.expect_error($$select public.save_pricing_plan('{"price_registered":3000,"price_active":7000,"bonus_price":15000,"bonus_min_cars":5,"bonus_activity_pct":60}')$$, 'FORBIDDEN');
select pg_temp.as_user(:admin);
select pg_temp.expect_error(format($$select public.save_pricing_plan(jsonb_build_object('effective_from', %L, 'price_registered', 3000, 'price_active', 7000, 'bonus_price', 15000, 'bonus_min_cars', 5, 'bonus_activity_pct', 60))$$,
  (select v from ctx where k='last_ws')), 'PLAN_LOCKED');
select public.save_pricing_plan(jsonb_build_object('effective_from', public.baghdad_today(), 'price_registered', 3500, 'price_active', 7000, 'bonus_price', 16000, 'bonus_min_cars', 5, 'bonus_activity_pct', 60));
select pg_temp.ok('new plan from this week', (select (public.plan_for_week(public.baghdad_today())->>'price_active')::int = 7000));
select pg_temp.ok('old weeks keep old plan', (select (public.plan_for_week((select v::date from ctx where k='last_ws'))->>'price_active')::int = 6000));
select pg_temp.ok('paid week untouched by new plan', (select net_amount = 64000 and not needs_recalc from public.payrolls where promoter_id = (select v::uuid from ctx where k='p1')));
select public.delete_pricing_plan(public.week_start_of(public.baghdad_today()), 'تجربة');
select pg_temp.expect_error($$select public.delete_pricing_plan('2020-01-04', 'base plan')$$, 'PLAN_REQUIRED');

-- negative net carries forward as debt
select pg_temp.as_user(:mgr_a);
insert into ctx values ('ws2', (public.week_start_of(public.baghdad_today()) - 14)::text);
select public.save_registrations((select v::date from ctx where k='ws2'),
  jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p2'), 'count', 1)));
select public.add_ledger_entry(jsonb_build_object('promoter_id', (select v from ctx where k='p2'), 'category', 'advance', 'amount', 40000,
  'entry_date', (select v::date + 1 from ctx where k='ws2')));
select public.approve_payrolls(array(select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p2') and week_start = (select v::date from ctx where k='ws2')));
-- 1 car registered only = 3000 − advance 40000 = −37000 → carried forward as debt
select pg_temp.ok('carry forward', (select net_amount = -37000 and payable_amount = 0 and carry_forward_debt = 37000
  from public.payrolls where promoter_id = (select v::uuid from ctx where k='p2') and week_start = (select v::date from ctx where k='ws2')));
select pg_temp.ok('carry debt posted', (select debt_balance = 37000 from public.promoter_balances where id = (select v::uuid from ctx where k='p2')));
select public.reopen_payroll((select id from public.payrolls where promoter_id = (select v::uuid from ctx where k='p2') and week_start = (select v::date from ctx where k='ws2')), 'إعادة فتح للتدقيق');
select pg_temp.ok('reopen voids carry', (select debt_balance = 0 from public.promoter_balances where id = (select v::uuid from ctx where k='p2')));
select pg_temp.expect_error(format($$select public.approve_payrolls(array(select id from public.payrolls where week_start = %L))$$, public.week_start_of(public.baghdad_today())), 'EXPECTED');

-- ============ Manager daily bonus (set by hand on the registrations screen) ============
select pg_temp.as_user(:mgr_a);
select public.save_daily_bonus(public.baghdad_today(), null, '{"enabled":true,"tier2":3000,"tier3":5000,"tier4":7000,"tier5":9000,"applies_to":"all"}');
select pg_temp.ok('manager bonus only for own team', (select count(*) = 1 and bool_and(manager_id = :mgr_a) from public.daily_bonuses));
select public.save_registrations(public.baghdad_today(),
  jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p1'), 'count', 3, 'active', 1),
                    jsonb_build_object('promoter_id', (select v from ctx where k='p2'), 'count', 1)));
-- 3 cars → the 3-car amount only (5000), not 3000 + 5000
select pg_temp.ok('bonus in this week payroll', (select daily_bonus_amount = 5000 and incentive_amount >= 5000 from public.payrolls
  where promoter_id = (select v::uuid from ctx where k='p1') and week_start = public.week_start_of(public.baghdad_today())));
select pg_temp.ok('below required cars → no bonus', (select daily_bonus_amount = 0 from public.payrolls
  where promoter_id = (select v::uuid from ctx where k='p2') and week_start = public.week_start_of(public.baghdad_today())));
select public.save_daily_bonus(public.baghdad_today(), null, '{"enabled":true,"tier3":1500,"tier5":4000,"extra_enabled":true,"extra_amount":500,"applies_to":"all"}');
select pg_temp.ok('bonus edit recalculates pending week', (select daily_bonus_amount = 1500 from public.payrolls
  where promoter_id = (select v::uuid from ctx where k='p1') and week_start = public.week_start_of(public.baghdad_today())));
select pg_temp.expect_error(format($$select public.save_daily_bonus(%L, null, '{"enabled":true,"amount":1000}')$$, (select v::date + 1 from ctx where k='last_ws')), 'RULE_LOCKED');
-- 7 cars → 5-car amount 4000 + 2 extra cars (6th, 7th) × 500 = 5000
select public.save_registrations(public.baghdad_today(), jsonb_build_array(jsonb_build_object('promoter_id', (select v from ctx where k='p2'), 'count', 7, 'active', 0)), 'تصحيح العدد');
select pg_temp.ok('5 tier + extra per car from the 6th', (select daily_bonus_amount = 5000 from public.payrolls
  where promoter_id = (select v::uuid from ctx where k='p2') and week_start = public.week_start_of(public.baghdad_today())));
select pg_temp.expect_error($$select public.save_daily_bonus(current_date, null, '{"tier2":-1}')$$, 'VALIDATION');
select pg_temp.as_user(:mgr_b);
select pg_temp.ok('B cannot see A bonus', (select count(*) = 0 from public.daily_bonuses));
select public.save_daily_bonus(public.baghdad_today(), :mgr_a, '{"enabled":true,"amount":999999}');
select pg_temp.ok('B save applies only to B', (select count(*) = 1 and bool_and(manager_id = :mgr_b) from public.daily_bonuses));
select pg_temp.as_user(:mgr_a);
select pg_temp.ok('A bonus unchanged by B', (select tier3 = 1500 from public.daily_bonuses where manager_id = :mgr_a and work_date = public.baghdad_today()));
select pg_temp.as_user(:mgr_b);
select pg_temp.ok('B inventory is empty', (select jsonb_array_length(public.inventory_report(public.baghdad_today() - 30, public.baghdad_today())->'days') = 0));
select pg_temp.expect_error(format($$select public.inventory_report(%L, %L, null, %L)$$, public.baghdad_today() - 7, public.baghdad_today(), (select v from ctx where k='p1')), 'FORBIDDEN');
select pg_temp.as_user(:mgr_a);
select pg_temp.ok('A inventory', (select jsonb_array_length(r->'promoters') = 2 and jsonb_array_length(r->'days') >= 3 and jsonb_array_length(r->'weeks') >= 2
  from (select public.inventory_report(public.baghdad_today() - 30, public.baghdad_today()) r) s));
select pg_temp.ok('single promoter inventory', (select jsonb_array_length(r->'promoters') = 1 and (r->'days'->0->>'promoter_id') = (select v from ctx where k='p1')
  from (select public.inventory_report(public.baghdad_today() - 30, public.baghdad_today(), null, (select v::uuid from ctx where k='p1')) r) s));
select pg_temp.ok('whatsapp saved', (select (public.upsert_promoter(jsonb_build_object('id', (select v from ctx where k='p1'), 'full_name', 'علي حسن', 'phone', '07701112222',
  'whatsapp', '+964 770 111 2222', 'start_date', (select v::date - 60 from ctx where k='last_ws')))).whatsapp = '+9647701112222'));

-- ============ Immutability (even for the table owner) ============
reset role;
select pg_temp.expect_error($$update public.payrolls set net_amount = 1 where status = 'paid' or status = 'adjusted'$$, 'PAYROLL_LOCKED');
select pg_temp.expect_error($$update public.ledger_entries set amount = 1$$, 'IMMUTABLE_RECORD');
select pg_temp.expect_error($$delete from public.ledger_entries$$, 'IMMUTABLE_RECORD');
select pg_temp.expect_error($$delete from public.registrations$$, 'IMMUTABLE_RECORD');
select pg_temp.expect_error($$update public.audit_log set reason = 'x'$$, 'IMMUTABLE_RECORD');
select pg_temp.expect_error($$delete from public.payroll_payments$$, 'IMMUTABLE_RECORD');
select pg_temp.ok('audit trail populated', (select count(*) > 20 from public.audit_log));
select pg_temp.ok('audit reasons captured', (select count(*) >= 1 from public.audit_log where reason = 'تسوية تسجيل متأخر'));

-- ============ Suspension ============
set role authenticated;
select pg_temp.as_user(:admin);
select public.set_manager_status(:mgr_b, 'suspended', 'اختبار');
select pg_temp.expect_error($$select public.set_manager_status(auth.uid(), 'suspended')$$, 'FORBIDDEN');
select pg_temp.expect_error(format($$select public.set_manager_status(%L, 'deleted')$$, :mgr_a), 'HAS_PROMOTERS');
select pg_temp.as_user(:mgr_b);
select pg_temp.expect_error($$select public.generate_payrolls(current_date - 7)$$, 'ACCOUNT_INACTIVE');
select pg_temp.ok('suspended sees nothing', (select count(*) = 0 from public.settings));

-- dashboard for admin
select pg_temp.as_user(:admin);
select pg_temp.ok('dashboard kpis', (select (d->'kpis'->>'range_registrations')::int = 21 and (d->'kpis'->>'expenses')::int = 17000
  and jsonb_array_length(d->'managers') = 1 from (select public.get_dashboard(public.baghdad_today() - 30, public.baghdad_today()) d) s));
select pg_temp.ok('report rows', (select count(*) = 2 from public.report_performance(public.baghdad_today() - 30, public.baghdad_today())));
select pg_temp.ok('expense summary', (select sum(total) = 17000 from public.expense_summary(public.baghdad_today() - 30, public.baghdad_today(), 'week')));

\echo 'WORKFLOW TEST: all assertions passed'
rollback;
