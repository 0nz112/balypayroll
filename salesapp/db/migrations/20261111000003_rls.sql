-- =====================================================================
-- Row Level Security & privileges
-- Reads: RLS restricts managers to their own team; super admin sees all.
-- Writes: no direct table writes for clients. All mutations go through
-- the SECURITY DEFINER RPCs that validate and authorize on the server.
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array['profiles','settings','promoters','registrations','registration_history','incentive_rules',
    'payrolls','payroll_payments','payroll_adjustments','ledger_entries','expense_categories','expenses','audit_log','user_preferences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- profiles: self, or admin. Managers can see names of other managers? No.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());

drop policy if exists settings_select on public.settings;
create policy settings_select on public.settings for select to authenticated
  using (public.my_role() is not null);

drop policy if exists expense_categories_select on public.expense_categories;
create policy expense_categories_select on public.expense_categories for select to authenticated
  using (public.my_role() is not null);

drop policy if exists incentive_rules_select on public.incentive_rules;
create policy incentive_rules_select on public.incentive_rules for select to authenticated
  using (public.my_role() is not null);

-- Team-scoped tables
do $$
declare t text;
begin
  foreach t in array array['promoters','registrations','registration_history','payrolls','payroll_payments',
                           'payroll_adjustments','ledger_entries','expenses'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (public.can_access_manager(manager_id))', t);
  end loop;
end $$;

drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated using (public.is_admin());

-- Preferences: users manage only their own row.
grant insert, update on public.user_preferences to authenticated;
drop policy if exists prefs_select on public.user_preferences;
drop policy if exists prefs_insert on public.user_preferences;
drop policy if exists prefs_update on public.user_preferences;
create policy prefs_select on public.user_preferences for select to authenticated using (user_id = auth.uid());
create policy prefs_insert on public.user_preferences for insert to authenticated with check (user_id = auth.uid());
create policy prefs_update on public.user_preferences for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Views run with the caller's privileges (security_invoker) so RLS applies.
revoke all on public.payroll_overview, public.promoter_balances from anon;
grant select on public.payroll_overview, public.promoter_balances to authenticated;

-- ---------------------------------------------------------------------
-- Function privileges: nothing for anon; only the public API for users.
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.my_role(), public.is_admin(), public.can_access_manager(uuid),
  public.baghdad_today(), public.week_start_of(date), public.week_end_of(date), public.pay_date_of(date),
  public.payroll_month_of(date), public.calc_incentive(jsonb,int,int,uuid), public.tier_amount(jsonb,int),
  public.preview_incentive(jsonb,int[],int,uuid), public.preview_payroll(uuid,date),
  public.upsert_promoter(jsonb), public.archive_promoter(uuid,text), public.reassign_promoters(uuid,uuid[],text),
  public.save_registrations(date,jsonb,text),
  public.save_incentive_rule(date[],jsonb,text), public.clear_incentive_rule(date[],text),
  public.generate_payrolls(date,uuid), public.approve_payrolls(uuid[]), public.reopen_payroll(uuid,text),
  public.pay_payroll(uuid,bigint,public.payment_method,text,timestamptz,text,text), public.adjust_payroll(uuid,text),
  public.add_ledger_entry(jsonb), public.review_ledger_entry(uuid,public.approval_status,text), public.void_ledger_entry(uuid,text),
  public.add_expense(jsonb), public.void_expense(uuid,text),
  public.get_dashboard(date,date,uuid), public.report_performance(date,date,uuid), public.expense_summary(date,date,text,uuid),
  public.update_manager(uuid,jsonb), public.set_manager_status(uuid,public.account_status,text),
  public.update_settings(jsonb), public.add_expense_category(text,text,text),
  public.debt_balance(uuid)
to authenticated;

-- RLS helper functions referenced from policies must be executable by the policy caller.
-- (Granted above.) Internal-only functions — compute_payroll, refresh_payroll, require_*,
-- assert_*, scope_manager, bootstrap_super_admin — are not callable by clients.
revoke execute on function public.bootstrap_super_admin(text) from public, anon, authenticated;
