-- Material Permanente: armazenamento sincronizado por usuário.
-- Execute uma única vez no SQL Editor do projeto Supabase.

create table if not exists public.user_app_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  client_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.user_app_state enable row level security;

drop policy if exists "Usuário lê somente os próprios dados" on public.user_app_state;
create policy "Usuário lê somente os próprios dados"
on public.user_app_state
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Usuário cria somente os próprios dados" on public.user_app_state;
create policy "Usuário cria somente os próprios dados"
on public.user_app_state
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Usuário altera somente os próprios dados" on public.user_app_state;
create policy "Usuário altera somente os próprios dados"
on public.user_app_state
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Usuário exclui somente os próprios dados" on public.user_app_state;
create policy "Usuário exclui somente os próprios dados"
on public.user_app_state
for delete
to authenticated
using ((select auth.uid()) = user_id);

create or replace function public.set_user_app_state_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_app_state_updated_at on public.user_app_state;
create trigger set_user_app_state_updated_at
before update on public.user_app_state
for each row execute function public.set_user_app_state_updated_at();

revoke all on table public.user_app_state from anon;
grant select, insert, update, delete on table public.user_app_state to authenticated;
