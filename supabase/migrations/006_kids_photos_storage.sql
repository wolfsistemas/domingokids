-- 006_kids_photos_storage.sql
-- Migracao das fotos do imgBB para o Supabase Storage (bucket kids-photos).
-- Mantem rollback facil: colunas *_legacy + tabela de mapeamento.

-- 1) Colunas legado: guardam a URL original (imgBB) antes da migracao.
alter table public.kids_families
  add column if not exists father_photo_url_legacy text,
  add column if not exists mother_photo_url_legacy text;

alter table public.kids_children
  add column if not exists photo_url_legacy text;

-- 2) Mapeamento da migracao: permite reverter com precisao (so o que migramos).
create table if not exists public.kids_photo_migration (
  id bigserial primary key,
  table_name text not null,
  row_id uuid not null,
  field text not null,
  old_url text,
  new_url text,
  status text not null default 'migrated',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (table_name, row_id, field)
);

alter table public.kids_photo_migration enable row level security;
-- Sem policies: somente service_role (migracao/rollback) acessa.

-- 3) Bucket publico de fotos (leitura publica, escrita so na pasta da familia).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kids-photos', 'kids-photos', true, 5242880,
        array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 4) RLS do Storage.
drop policy if exists kids_photos_read on storage.objects;
create policy kids_photos_read
  on storage.objects for select
  to public
  using (bucket_id = 'kids-photos');

drop policy if exists kids_photos_insert on storage.objects;
create policy kids_photos_insert
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'kids-photos'
    and (storage.foldername(name))[1] = public.my_family_id()::text
  );

drop policy if exists kids_photos_update on storage.objects;
create policy kids_photos_update
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'kids-photos'
    and (storage.foldername(name))[1] = public.my_family_id()::text
  )
  with check (
    bucket_id = 'kids-photos'
    and (storage.foldername(name))[1] = public.my_family_id()::text
  );

drop policy if exists kids_photos_delete on storage.objects;
create policy kids_photos_delete
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'kids-photos'
    and (storage.foldername(name))[1] = public.my_family_id()::text
  );
