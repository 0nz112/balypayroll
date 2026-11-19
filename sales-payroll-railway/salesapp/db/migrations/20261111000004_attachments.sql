-- =====================================================================
-- Expense attachments stored inside PostgreSQL (included in DB backups).
-- Path stored on expenses.attachment_path as 'db:<uuid>'.
-- =====================================================================
create table if not exists public.attachments (
  id          uuid primary key default gen_random_uuid(),
  manager_id  uuid not null references public.profiles(id),
  mime        text not null check (mime in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes  int not null check (size_bytes > 0 and size_bytes <= 5242880),
  data        bytea not null,
  created_by  uuid references public.profiles(id),
  created_at  timestamptz not null default now()
);
alter table public.attachments enable row level security;
revoke all on public.attachments from anon, authenticated;

drop trigger if exists nodelete_attachments on public.attachments;
create trigger nodelete_attachments before delete on public.attachments for each row execute function public.tg_forbid();
drop trigger if exists noupdate_attachments on public.attachments;
create trigger noupdate_attachments before update on public.attachments for each row execute function public.tg_forbid();

create or replace function public.store_attachment(p_mime text, p_data_b64 text, p_manager uuid default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_role public.app_role := public.require_user(); v_mgr uuid; v_bytes bytea; v_id uuid;
begin
  v_mgr := case when v_role = 'super_admin' then coalesce(p_manager, auth.uid()) else auth.uid() end;
  begin v_bytes := decode(p_data_b64, 'base64'); exception when others then perform public.raise_app('VALIDATION', 'attachment'); end;
  if p_mime not in ('image/jpeg','image/png','image/webp','application/pdf') then perform public.raise_app('VALIDATION', 'attachment type'); end if;
  if length(v_bytes) = 0 or length(v_bytes) > 5242880 then perform public.raise_app('VALIDATION', 'attachment size'); end if;
  insert into public.attachments (manager_id, mime, size_bytes, data, created_by)
  values (v_mgr, p_mime, length(v_bytes), v_bytes, auth.uid()) returning id into v_id;
  return 'db:' || v_id::text;
end $$;

create or replace function public.get_attachment(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a public.attachments;
begin
  perform public.require_user();
  select * into a from public.attachments where id = p_id;
  if a.id is null then perform public.raise_app('NOT_FOUND'); end if;
  if not public.can_access_manager(a.manager_id) then
    perform public.raise_app('FORBIDDEN');
  end if;
  return jsonb_build_object('mime', a.mime, 'data', encode(a.data, 'base64'));
end $$;

revoke execute on function public.store_attachment(text, text, uuid), public.get_attachment(uuid) from public, anon;
grant execute on function public.store_attachment(text, text, uuid), public.get_attachment(uuid) to authenticated;
