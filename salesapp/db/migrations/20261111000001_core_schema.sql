-- =====================================================================
-- Sales & Payroll Management (IQD) — Core schema
-- All money columns are BIGINT integer Iraqi Dinar. No floating point.
-- All business dates are interpreted in Asia/Baghdad.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('super_admin', 'manager');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.account_status as enum ('active', 'suspended', 'deleted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.promoter_status as enum ('active', 'inactive', 'terminated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payroll_status as enum ('pending', 'approved', 'paid', 'adjusted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ledger_category as enum (
    'opening_debt',     -- old debt balance carried in (kept separate)
    'debt',             -- new loan / debt given to promoter
    'debt_repayment',   -- repayment of debt, deducted from the week's payroll
    'withdrawal',       -- daily cash withdrawal, deducted from the week's payroll
    'advance',          -- salary advance (سلفة), deducted from the week's payroll
    'expense_charge',   -- expense charged to the promoter, deducted
    'deduction',        -- other deduction / penalty
    'bonus',            -- bonus, added to the week's payroll
    'correction',       -- signed correction (+ owed to promoter / - owed by promoter)
    'salary_payment'    -- informational record created automatically on payment
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.approval_status as enum ('pending', 'approved', 'rejected', 'void');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method as enum ('cash', 'bank_transfer', 'zain_cash', 'qi_card', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.extra_basis as enum ('beyond_threshold', 'all_registrations');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- Date helpers (Asia/Baghdad, Saturday → Friday weeks, Tuesday payday)
-- ---------------------------------------------------------------------
create or replace function public.baghdad_now() returns timestamp
language sql stable as $$ select (now() at time zone 'Asia/Baghdad') $$;

create or replace function public.baghdad_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Baghdad')::date $$;

-- Saturday that starts the payroll week containing d.
-- dow: Sun=0 … Sat=6  →  offset = (dow + 1) % 7  (Sat=0, Sun=1, …, Fri=6)
create or replace function public.week_start_of(d date) returns date
language sql immutable parallel safe as $$
  select d - ((extract(dow from d)::int + 1) % 7)
$$;

create or replace function public.week_end_of(d date) returns date
language sql immutable parallel safe as $$ select public.week_start_of(d) + 6 $$;

-- Salary is paid on the Tuesday after the week ends (Saturday + 10 days).
create or replace function public.pay_date_of(d date) returns date
language sql immutable parallel safe as $$ select public.week_start_of(d) + 10 $$;

-- A week belongs to the payroll month of its Friday (end date). This assigns
-- every week to exactly one month, so month-boundary weeks are never split,
-- lost or duplicated.
create or replace function public.payroll_month_of(d date) returns date
language sql immutable parallel safe as $$
  select date_trunc('month', public.week_end_of(d))::date
$$;

-- ---------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete restrict,
  email       text,
  full_name   text not null default '',
  phone       text,
  role        public.app_role not null default 'manager',
  status      public.account_status not null default 'suspended',
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- System settings (singleton)
-- ---------------------------------------------------------------------
create table if not exists public.settings (
  id                        int primary key default 1 check (id = 1),
  company_name              text not null default 'شركة المبيعات',
  base_rate                 bigint not null default 15000 check (base_rate >= 0),
  default_extra_amount      bigint not null default 8000 check (default_extra_amount >= 0),
  ledger_requires_approval  boolean not null default false,
  max_daily_registrations   int not null default 100 check (max_daily_registrations between 1 and 1000),
  timezone                  text not null default 'Asia/Baghdad' check (timezone = 'Asia/Baghdad'),
  currency                  text not null default 'IQD' check (currency = 'IQD'),
  updated_by                uuid references public.profiles(id),
  updated_at                timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------------------------------------------------------------------
-- Promoters
-- ---------------------------------------------------------------------
create table if not exists public.promoters (
  id           uuid primary key default gen_random_uuid(),
  manager_id   uuid not null references public.profiles(id) on delete restrict,
  full_name    text not null check (length(btrim(full_name)) between 2 and 120),
  phone        text not null check (phone ~ '^\+?[0-9]{7,15}$'),
  birth_date   date,
  start_date   date not null,
  status       public.promoter_status not null default 'active',
  notes        text,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  check (birth_date is null or birth_date < start_date)
);
create unique index if not exists promoters_phone_uniq on public.promoters (phone) where deleted_at is null;
create index if not exists promoters_manager_idx on public.promoters (manager_id);
create index if not exists promoters_name_idx on public.promoters (lower(full_name));

-- ---------------------------------------------------------------------
-- Daily registrations (one row per promoter per day)
-- ---------------------------------------------------------------------
create table if not exists public.registrations (
  id           uuid primary key default gen_random_uuid(),
  promoter_id  uuid not null references public.promoters(id) on delete restrict,
  manager_id   uuid not null references public.profiles(id) on delete restrict,
  work_date    date not null,
  week_start   date generated always as (public.week_start_of(work_date)) stored,
  reg_count    int not null check (reg_count >= 0 and reg_count <= 1000),
  rate         bigint not null check (rate >= 0),           -- base rate snapshot (IQD)
  notes        text,
  version      int not null default 1,
  created_by   uuid references public.profiles(id),
  updated_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint registrations_one_per_day unique (promoter_id, work_date)
);
create index if not exists registrations_week_idx on public.registrations (week_start, manager_id);
create index if not exists registrations_date_idx on public.registrations (work_date, manager_id);

create table if not exists public.registration_history (
  id               bigserial primary key,
  registration_id  uuid not null references public.registrations(id) on delete restrict,
  promoter_id      uuid not null,
  manager_id       uuid not null,
  work_date        date not null,
  old_count        int,
  new_count        int not null,
  old_rate         bigint,
  new_rate         bigint not null,
  reason           text,
  changed_by       uuid,
  changed_at       timestamptz not null default now()
);
create index if not exists registration_history_reg_idx on public.registration_history (registration_id);

-- ---------------------------------------------------------------------
-- Incentive rules (one per calendar date; no row = no incentive)
-- tiers: [{"count":2,"amount":0,"enabled":true,"min_tenure_days":0}, … count 2..5]
-- ---------------------------------------------------------------------
create table if not exists public.incentive_rules (
  work_date         date primary key,
  is_incentive_day  boolean not null default false,
  tiers             jsonb not null default '[]'::jsonb,
  extra_enabled     boolean not null default false,
  extra_amount      bigint not null default 0 check (extra_amount >= 0),
  extra_basis       public.extra_basis not null default 'beyond_threshold',
  include_top_tier  boolean not null default true,
  min_tenure_days   int not null default 0 check (min_tenure_days >= 0),
  manager_ids       uuid[],                     -- null = all managers
  notes             text,
  version           int not null default 1,
  updated_by        uuid references public.profiles(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (jsonb_typeof(tiers) = 'array')
);

-- ---------------------------------------------------------------------
-- Payrolls (one per promoter per week, Saturday–Friday)
-- ---------------------------------------------------------------------
create table if not exists public.payrolls (
  id                 uuid primary key default gen_random_uuid(),
  promoter_id        uuid not null references public.promoters(id) on delete restrict,
  manager_id         uuid not null references public.profiles(id) on delete restrict,
  week_start         date not null check (extract(dow from week_start) = 6),
  week_end           date generated always as (week_start + 6) stored,
  pay_date           date generated always as (week_start + 10) stored,
  status             public.payroll_status not null default 'pending',
  reg_count          int not null default 0,
  base_amount        bigint not null default 0,
  incentive_amount   bigint not null default 0,
  bonus_amount       bigint not null default 0,
  correction_amount  bigint not null default 0,  -- signed
  withdrawal_amount  bigint not null default 0,
  advance_amount     bigint not null default 0,
  deduction_amount   bigint not null default 0,  -- deductions + expense charges
  debt_repayment_amount bigint not null default 0,
  gross_amount       bigint not null default 0,
  total_deductions   bigint not null default 0,
  net_amount         bigint not null default 0,  -- may be negative
  carry_forward_debt bigint not null default 0,  -- posted as debt on approval when net < 0
  payable_amount     bigint not null default 0,  -- net + carry_forward (>= 0)
  snapshot           jsonb not null default '{}'::jsonb,
  calc_version       text not null default 'v1',
  needs_recalc       boolean not null default false,
  carry_entry_id     uuid,
  computed_at        timestamptz not null default now(),
  approved_by        uuid references public.profiles(id),
  approved_at        timestamptz,
  paid_at            timestamptz,
  payment_method     public.payment_method,
  payment_reference  text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint payrolls_one_per_week unique (promoter_id, week_start)
);
create index if not exists payrolls_week_idx on public.payrolls (week_start, manager_id);
create index if not exists payrolls_status_idx on public.payrolls (status);

create table if not exists public.payroll_payments (
  id               uuid primary key default gen_random_uuid(),
  payroll_id       uuid not null references public.payrolls(id) on delete restrict,
  promoter_id      uuid not null,
  manager_id       uuid not null,
  amount           bigint not null check (amount > 0),
  method           public.payment_method not null,
  reference        text,
  paid_at          timestamptz not null default now(),
  notes            text,
  idempotency_key  text unique,
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);
create index if not exists payroll_payments_payroll_idx on public.payroll_payments (payroll_id);

create table if not exists public.payroll_adjustments (
  id               uuid primary key default gen_random_uuid(),
  payroll_id       uuid not null references public.payrolls(id) on delete restrict,
  manager_id       uuid not null,
  previous_net     bigint not null,
  new_net          bigint not null,
  delta            bigint not null,
  carried_to_debt  bigint not null default 0,
  debt_entry_id    uuid,
  old_snapshot     jsonb not null,
  new_snapshot     jsonb not null,
  reason           text not null check (length(btrim(reason)) >= 3),
  created_by       uuid references public.profiles(id),
  created_at       timestamptz not null default now()
);
create index if not exists payroll_adjustments_payroll_idx on public.payroll_adjustments (payroll_id);

-- ---------------------------------------------------------------------
-- Ledger (per-promoter, append-only)
-- ---------------------------------------------------------------------
create table if not exists public.ledger_entries (
  id                 uuid primary key default gen_random_uuid(),
  promoter_id        uuid not null references public.promoters(id) on delete restrict,
  manager_id         uuid not null references public.profiles(id) on delete restrict,
  entry_date         date not null,
  week_start         date generated always as (public.week_start_of(entry_date)) stored,
  category           public.ledger_category not null,
  amount             bigint not null,   -- positive; correction may be signed
  notes              text,
  status             public.approval_status not null default 'approved',
  payroll_id         uuid references public.payrolls(id),
  expense_id         uuid,
  reverses_entry_id  uuid references public.ledger_entries(id),
  idempotency_key    text unique,
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now(),
  approved_by        uuid references public.profiles(id),
  approved_at        timestamptz,
  void_reason        text,
  check ((category = 'correction' and amount <> 0) or (category <> 'correction' and amount > 0))
);
create index if not exists ledger_promoter_idx on public.ledger_entries (promoter_id, entry_date);
create index if not exists ledger_week_idx on public.ledger_entries (week_start, manager_id);

-- ---------------------------------------------------------------------
-- Expenses
-- ---------------------------------------------------------------------
create table if not exists public.expense_categories (
  key        text primary key check (key ~ '^[a-z0-9_]{2,40}$'),
  name_ar    text not null,
  name_en    text not null,
  is_system  boolean not null default false,
  sort_order int not null default 100
);
insert into public.expense_categories (key, name_ar, name_en, is_system, sort_order) values
  ('team',        'مصاريف الفريق',     'Team expenses',        true, 10),
  ('operational', 'مصاريف تشغيلية',    'Operational',          true, 20),
  ('fuel',        'وقود',              'Fuel',                 true, 30),
  ('harqiyat',    'حَرْقيات',           'Harqiyat (petty)',     true, 40),
  ('transport',   'نقل ومواصلات',      'Transport',            true, 50),
  ('misc',        'متفرقة',            'Miscellaneous',        true, 90)
on conflict (key) do nothing;

create table if not exists public.expenses (
  id                 uuid primary key default gen_random_uuid(),
  manager_id         uuid not null references public.profiles(id) on delete restrict,
  expense_date       date not null,
  week_start         date generated always as (public.week_start_of(expense_date)) stored,
  category           text not null references public.expense_categories(key),
  description        text not null check (length(btrim(description)) >= 2),
  amount             bigint not null check (amount > 0),
  attachment_path    text,
  charged_promoter_id uuid references public.promoters(id),
  ledger_entry_id    uuid references public.ledger_entries(id),
  status             public.approval_status not null default 'approved',
  void_reason        text,
  idempotency_key    text unique,
  created_by         uuid references public.profiles(id),
  created_at         timestamptz not null default now()
);
create index if not exists expenses_date_idx on public.expenses (expense_date, manager_id);

-- ---------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  action      text not null,
  table_name  text not null,
  row_id      text,
  manager_id  uuid,
  old_data    jsonb,
  new_data    jsonb,
  reason      text
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_row_idx on public.audit_log (table_name, row_id);

-- ---------------------------------------------------------------------
-- Per-user UI preferences (theme, language, accent, density…)
-- ---------------------------------------------------------------------
create table if not exists public.user_preferences (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  prefs       jsonb not null default '{}'::jsonb check (jsonb_typeof(prefs) = 'object'),
  updated_at  timestamptz not null default now()
);
