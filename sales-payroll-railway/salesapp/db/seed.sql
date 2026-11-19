-- =====================================================================
-- DEMO SEED DATA — for local development / staging only. Never run in production.
-- Logins (change immediately):
--   admin@demo.iq     / Demo@12345   (Super Admin)
--   karrar@demo.iq    / Demo@12345   (Manager — Baghdad Karrada)
--   noor@demo.iq      / Demo@12345   (Manager — Baghdad Mansour)
--   haider@demo.iq    / Demo@12345   (Manager — Basra)
-- Incentive amounts below are DEMO VALUES marked in notes; edit them in the app.
-- Deterministic: the same seed always produces the same data relative to today.
-- =====================================================================
set client_min_messages = warning;

do $$
declare
  v_crypt text;
  u record;
  v_admin uuid := 'd0000000-0000-4000-8000-000000000001';
  v_mgrs uuid[] := array['d0000000-0000-4000-8000-00000000000a','d0000000-0000-4000-8000-00000000000b','d0000000-0000-4000-8000-00000000000c']::uuid[];
  v_today date := public.baghdad_today();
  v_first date;
  v_ws date; d date; p record; n int; i int; v_entries jsonb; m uuid;
  names text[] := array['علي حسين','زينب كاظم','مصطفى جاسم','فاطمة عباس','حسن عبد الأمير','مريم سلمان',
                        'سجاد كريم','نور الهدى قاسم','أحمد فاضل','رقية محمد','عباس ناصر','دعاء حميد',
                        'محمد رضا','هبة علي','كرار صباح'];
begin
  if exists (select 1 from public.profiles where email = 'admin@demo.iq') then
    raise notice 'demo seed already loaded'; return;
  end if;

  -- password hash (pgcrypto lives in "extensions" on Supabase)
  if to_regprocedure('extensions.crypt(text,text)') is not null then
    execute $q$select extensions.crypt('Demo@12345', extensions.gen_salt('bf'))$q$ into v_crypt;
  else
    execute $q$select crypt('Demo@12345', gen_salt('bf'))$q$ into v_crypt;
  end if;

  for u in select * from (values
      (v_admin,   'admin@demo.iq',  'super_admin', 'أبو مهدي — المدير العام', '07800000001'),
      (v_mgrs[1], 'karrar@demo.iq', 'manager',     'كرار الساعدي',              '07700000011'),
      (v_mgrs[2], 'noor@demo.iq',   'manager',     'نور الربيعي',               '07700000022'),
      (v_mgrs[3], 'haider@demo.iq', 'manager',     'حيدر البصري',               '07700000033')) t(id, email, role, name, phone)
  loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change, email_change_token_new)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email, v_crypt, now(),
            jsonb_build_object('provider','email','providers',array['email'],'role',u.role,'status','active','full_name',u.name,'phone',u.phone),
            '{}'::jsonb, now(), now(), '', '', '', '');
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), u.id::text, u.id, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
            'email', now(), now(), now());
  end loop;

  -- Act as admin for configuration
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
  perform public.update_settings('{"company_name":"شركة الرافدين للتسويق"}');

  v_first := public.week_start_of(v_today) - 35;   -- five full weeks of history + current week

  -- No predefined incentive or bonus amounts: managers set daily bonuses themselves on the registrations screen.

  -- Promoters (5 per manager)
  for i in 1..15 loop
    m := v_mgrs[((i - 1) % 3) + 1];
    perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
    perform public.upsert_promoter(jsonb_build_object(
      'full_name', names[i], 'phone', '0770' || lpad((1000000 + i * 7919)::text, 7, '0'),
      'birth_date', (date '1995-01-01' + (i * 211))::text,
      'start_date', (v_first - 30 + (i % 4) * 7)::text,
      'status', case when i = 15 then 'inactive' else 'active' end,
      'notes', case when i % 5 = 0 then 'مروج متميز' end));
  end loop;

  -- Daily registrations (deterministic pseudo-random 0..9)
  for d in select g::date from generate_series(v_first, v_today, interval '1 day') g loop
    foreach m in array v_mgrs loop
      perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
      v_entries := '[]'::jsonb;
      for p in select id, full_name, status from public.promoters where manager_id = m and deleted_at is null loop
        if p.status <> 'active' and d > v_today - 10 then continue; end if;
        n := abs(hashtext(p.id::text || d::text)) % 5;
        n := case when n = 0 or (d = v_today and n > 2) then 0 else n end;
        if extract(dow from d) in (4,5) then n := n + 1; end if;
        -- roughly half to most of the cars become active (3 trips), varying by promoter/day
        if n > 0 then v_entries := v_entries || jsonb_build_object('promoter_id', p.id, 'count', n,
             'active', least(n, round(n * (35 + abs(hashtext(d::text || p.full_name)) % 66) / 100.0)::int)); end if;
      end loop;
      if jsonb_array_length(v_entries) > 0 then perform public.save_registrations(d, v_entries); end if;
    end loop;
  end loop;

  -- Ledger: opening debts, withdrawals, advances, bonuses; expenses
  foreach m in array v_mgrs loop
    perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
    i := 0;
    for p in select id from public.promoters where manager_id = m and deleted_at is null order by created_at loop
      i := i + 1;
      if i % 2 = 1 then
        perform public.add_ledger_entry(jsonb_build_object('promoter_id', p.id, 'category', 'opening_debt',
          'amount', 50000 * i, 'entry_date', (v_first - 1)::text, 'notes', 'رصيد دين سابق'));
      end if;
      for v_ws in select g::date from generate_series(v_first, public.week_start_of(v_today), interval '7 day') g loop
        n := abs(hashtext(p.id::text || v_ws::text));
        if n % 3 <> 0 and v_ws + 1 <= v_today then
          perform public.add_ledger_entry(jsonb_build_object('promoter_id', p.id, 'category', 'withdrawal',
            'amount', 10000 * (1 + n % 4), 'entry_date', (v_ws + 1)::text, 'notes', 'سحب يومي'));
        end if;
        if n % 5 = 0 and v_ws + 3 <= v_today then
          perform public.add_ledger_entry(jsonb_build_object('promoter_id', p.id, 'category', 'advance',
            'amount', 25000, 'entry_date', (v_ws + 3)::text, 'notes', 'سلفة'));
        end if;
        if n % 7 = 0 and v_ws + 5 <= v_today then
          perform public.add_ledger_entry(jsonb_build_object('promoter_id', p.id, 'category', 'bonus',
            'amount', 20000, 'entry_date', (v_ws + 5)::text, 'notes', 'مكافأة أداء'));
        end if;
        if i % 2 = 1 and v_ws + 4 <= v_today and public.debt_balance(p.id) >= 10000 then
          perform public.add_ledger_entry(jsonb_build_object('promoter_id', p.id, 'category', 'debt_repayment',
            'amount', 10000, 'entry_date', (v_ws + 4)::text, 'notes', 'استقطاع من الدين'));
        end if;
      end loop;
    end loop;
    for v_ws in select g::date from generate_series(v_first, public.week_start_of(v_today), interval '7 day') g loop
      if v_ws + 2 <= v_today then
        perform public.add_expense(jsonb_build_object('category', 'fuel', 'description', 'وقود سيارة الفريق', 'amount', 35000, 'expense_date', (v_ws + 2)::text));
        perform public.add_expense(jsonb_build_object('category', 'harqiyat', 'description', 'حرقيات ومصاريف يومية', 'amount', 15000 + (abs(hashtext(m::text || v_ws::text)) % 5) * 1000, 'expense_date', (v_ws + 2)::text));
      end if;
      if v_ws + 4 <= v_today then
        perform public.add_expense(jsonb_build_object('category', 'team', 'description', 'غداء الفريق', 'amount', 40000, 'expense_date', (v_ws + 4)::text));
      end if;
    end loop;
  end loop;

  -- Payrolls: older weeks paid, last completed week approved (unpaid), current week pending
  foreach m in array v_mgrs loop
    perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
    for v_ws in select g::date from generate_series(v_first, public.week_start_of(v_today), interval '7 day') g loop
      perform public.generate_payrolls(v_ws);
      if v_ws + 6 < v_today then
        perform public.approve_payrolls(array(select id from public.payrolls where manager_id = m and week_start = v_ws and status = 'pending'));
        if v_ws < public.week_start_of(v_today) - 7 then
          for p in select id from public.payrolls where manager_id = m and week_start = v_ws loop
            perform public.pay_payroll(p.id, null, (array['cash','zain_cash','qi_card'])[1 + abs(hashtext(p.id::text)) % 3]::public.payment_method,
                                       'REF-' || upper(substr(md5(p.id::text), 1, 6)), (v_ws + 10)::timestamp at time zone 'Asia/Baghdad');
          end loop;
        end if;
      end if;
    end loop;
  end loop;
end $$;
