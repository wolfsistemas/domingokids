create table if not exists public.kids_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.kids_profiles(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (user_id, endpoint)
);

create index if not exists kids_push_subscriptions_user_id_idx
  on public.kids_push_subscriptions (user_id);

alter table public.kids_push_subscriptions enable row level security;

drop policy if exists kids_push_subscriptions_select_own on public.kids_push_subscriptions;
create policy kids_push_subscriptions_select_own
  on public.kids_push_subscriptions
  for select
  using (auth.uid() = user_id);

drop policy if exists kids_push_subscriptions_insert_own on public.kids_push_subscriptions;
create policy kids_push_subscriptions_insert_own
  on public.kids_push_subscriptions
  for insert
  with check (auth.uid() = user_id);

drop policy if exists kids_push_subscriptions_update_own on public.kids_push_subscriptions;
create policy kids_push_subscriptions_update_own
  on public.kids_push_subscriptions
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists kids_push_subscriptions_delete_own on public.kids_push_subscriptions;
create policy kids_push_subscriptions_delete_own
  on public.kids_push_subscriptions
  for delete
  using (auth.uid() = user_id);
