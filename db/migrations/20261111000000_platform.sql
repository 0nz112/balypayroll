-- =====================================================================
-- Platform layer for plain PostgreSQL (Railway).
-- Provides login accounts (auth.users), auth.uid() and the database roles
-- used by Row Level Security. The API server sets, per request transaction:
--   SET LOCAL ROLE authenticated;
--   set_config('request.jwt.claims', '{"sub":"<user id>"}', true);
-- so every RLS policy and permission check runs as the signed-in user.
-- =====================================================================
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
-- the connecting (owner) role must be able to switch to "authenticated"
do $$ begin execute format('grant authenticated to %I', current_user); exception when others then null; end $$;

create schema if not exists auth;

create table if not exists auth.users (
  instance_id            uuid,
  id                     uuid primary key default gen_random_uuid(),
  aud                    text,
  role                   text,
  email                  text not null unique,
  encrypted_password     text,
  email_confirmed_at     timestamptz,
  raw_app_meta_data      jsonb not null default '{}'::jsonb,
  raw_user_meta_data     jsonb not null default '{}'::jsonb,
  last_sign_in_at        timestamptz,
  failed_logins          int not null default 0,
  locked_until           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  confirmation_token     text default '',
  recovery_token         text default '',
  email_change           text default '',
  email_change_token_new text default ''
);
create unique index if not exists auth_users_email_lower on auth.users (lower(email));

-- kept for seed compatibility (unused by the server)
create table if not exists auth.identities (
  id uuid primary key, provider_id text, user_id uuid references auth.users(id), identity_data jsonb,
  provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz
);

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

revoke all on schema auth from public;
grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
revoke all on all tables in schema auth from authenticated, anon;
grant usage on schema public to authenticated;

create table if not exists public.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
