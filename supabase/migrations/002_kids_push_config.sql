create table if not exists public.kids_push_config (
  chave text primary key,
  ativo boolean not null default true,
  atualizado_em timestamptz not null default now()
);

insert into public.kids_push_config (chave, ativo) values
  ('global', true),
  ('checkin', true),
  ('checkout', true),
  ('checkout_pendente', true),
  ('aniversario_checkin', true),
  ('aviso', true)
on conflict (chave) do nothing;

alter table public.kids_push_config enable row level security;

drop policy if exists kids_push_config_select_auth on public.kids_push_config;
create policy kids_push_config_select_auth
  on public.kids_push_config
  for select
  to authenticated
  using (true);

drop policy if exists kids_push_config_insert_admin on public.kids_push_config;
create policy kids_push_config_insert_admin
  on public.kids_push_config
  for insert
  to authenticated
  with check (exists (
    select 1 from public.kids_profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));

drop policy if exists kids_push_config_update_admin on public.kids_push_config;
create policy kids_push_config_update_admin
  on public.kids_push_config
  for update
  to authenticated
  using (exists (
    select 1 from public.kids_profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ))
  with check (exists (
    select 1 from public.kids_profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));

create table if not exists public.kids_notifications_log (
  id uuid primary key default gen_random_uuid(),
  chave text not null,
  titulo text,
  corpo text,
  destinatarios integer not null default 0,
  meta jsonb,
  enviado_em timestamptz not null default now()
);

create index if not exists kids_notifications_log_enviado_em_idx
  on public.kids_notifications_log (enviado_em desc);

alter table public.kids_notifications_log enable row level security;

drop policy if exists kids_notifications_log_select_admin on public.kids_notifications_log;
create policy kids_notifications_log_select_admin
  on public.kids_notifications_log
  for select
  to authenticated
  using (exists (
    select 1 from public.kids_profiles p
    where p.id = auth.uid() and p.role = 'admin'
  ));
