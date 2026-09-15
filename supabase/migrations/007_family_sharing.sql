-- 007_family_sharing.sql
-- Compartilhamento de familia entre responsaveis.
--
--   * kids_families.owner_id  -> quem criou a familia (pode gerar/ver o codigo)
--   * kids_family_codes       -> codigo de convite de 6 caracteres, por familia
--                               (tabela separada com RLS para que SOMENTE o dono
--                               consiga ler o codigo; escrita apenas por funcao)
--   * kids_regenerate_family_code()  -> dono gera/renova o codigo
--   * kids_join_family_by_code(txt)  -> segundo responsavel entra na familia
--   * kids_leave_family()            -> sai da familia (desvincula o perfil)
--   * create_family() atualizada cria owner_id + primeiro codigo
--
-- Modelo escolhido: codigo FIXO regeneravel de 6 caracteres (sem 0/O/1/I/L),
-- com rate limit agressivo para conter tentativa de adivinhacao.
-- Por seguranca o vínculo de familia continua passando pelo trigger
-- kids_profiles_guard (003/004); as funcoes abaixo marcam a flag
-- app.allow_family_change antes do UPDATE, igual ao create_family original.

-- 1) Dono da familia + codigo fixo (coluna mantida para consulta rapida;
--    o valor "oficial" vive em kids_family_codes).
alter table public.kids_families
    add column if not exists owner_id uuid references public.kids_profiles(id) on delete set null;

-- 2) Tabela de codigos (privada: sem policies de escrita).
create table if not exists public.kids_family_codes (
    family_id uuid primary key references public.kids_families(id) on delete cascade,
    code text not null,
    atualizado_em timestamptz not null default now(),
    atualizado_por uuid references public.kids_profiles(id) on delete set null
);

create unique index if not exists kids_family_codes_code_key
    on public.kids_family_codes (upper(code));

alter table public.kids_family_codes enable row level security;
revoke all on public.kids_family_codes from anon, authenticated;
grant all on public.kids_family_codes to service_role;
-- Leitura do codigo: a policy abaixo restringe ao dono da familia.
grant select on public.kids_family_codes to authenticated;

-- Somente o dono da familia le o codigo.
drop policy if exists kids_family_codes_select_owner on public.kids_family_codes;
create policy kids_family_codes_select_owner on public.kids_family_codes
    for select to authenticated
    using (
        exists (
            select 1
              from public.kids_families f
             where f.id = kids_family_codes.family_id
               and f.owner_id = auth.uid()
        )
    );

-- 3) Gerador de codigo (6 chars, sem caracteres ambiguos). Uso interno.
create or replace function public._dk_generate_family_code()
returns text
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    v_alpha text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    v_code text;
    v_i int;
    v_tentativas int := 0;
BEGIN
    LOOP
        v_code := '';
        FOR v_i IN 1..6 LOOP
            v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
        END LOOP;

        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM public.kids_family_codes WHERE upper(code) = v_code
        );

        v_tentativas := v_tentativas + 1;
        IF v_tentativas > 20 THEN
            RAISE EXCEPTION 'Nao foi possivel gerar um codigo unico.';
        END IF;
    END LOOP;

    RETURN v_code;
END;
$function$;

revoke all on function public._dk_generate_family_code() from public, anon, authenticated;
grant execute on function public._dk_generate_family_code() to service_role;

-- 4) create_family atualizada: define dono e ja cria o primeiro codigo.
create or replace function public.create_family(p_family_name text)
returns kids_families
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    new_family public.kids_families;
BEGIN
    IF public.my_family_id() IS NOT NULL THEN
        RAISE EXCEPTION 'Usuario ja possui uma familia vinculada.';
    END IF;

    IF p_family_name IS NULL OR btrim(p_family_name) = '' THEN
        RAISE EXCEPTION 'Informe um nome para a familia.';
    END IF;

    INSERT INTO public.kids_families (family_name, owner_id)
    VALUES (btrim(p_family_name), auth.uid())
    RETURNING * INTO new_family;

    PERFORM set_config('app.allow_family_change', 'on', true);
    UPDATE public.kids_profiles
       SET family_id = new_family.id
     WHERE id = auth.uid();

    INSERT INTO public.kids_family_codes (family_id, code, atualizado_por)
    VALUES (new_family.id, public._dk_generate_family_code(), auth.uid())
    ON CONFLICT (family_id) DO NOTHING;

    RETURN new_family;
END;
$function$;

-- 5) Dono gera/renova o codigo da familia.
create or replace function public.kids_regenerate_family_code()
returns text
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    v_uid uuid := auth.uid();
    v_family uuid;
    v_code text;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'nao_autenticado' USING ERRCODE = 'P0001';
    END IF;

    SELECT family_id INTO v_family FROM public.kids_profiles WHERE id = v_uid;
    IF v_family IS NULL THEN
        RAISE EXCEPTION 'sem_familia' USING ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.kids_families
         WHERE id = v_family AND owner_id = v_uid
    ) THEN
        RAISE EXCEPTION 'sem_permissao' USING ERRCODE = 'P0001';
    END IF;

    v_code := public._dk_generate_family_code();

    INSERT INTO public.kids_family_codes (family_id, code, atualizado_em, atualizado_por)
    VALUES (v_family, v_code, now(), v_uid)
    ON CONFLICT (family_id) DO UPDATE
        SET code = EXCLUDED.code,
            atualizado_em = now(),
            atualizado_por = v_uid;

    RETURN v_code;
END;
$function$;

grant execute on function public.kids_regenerate_family_code() to authenticated;

-- 6) Entrar em uma familia existente usando o codigo.
create or replace function public.kids_join_family_by_code(p_code text)
returns json
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    v_uid uuid := auth.uid();
    v_ip text := public._dk_client_ip();
    v_code text := upper(btrim(coalesce(p_code, '')));
    v_family public.kids_families;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'nao_autenticado' USING ERRCODE = 'P0001';
    END IF;

    -- Rate limit (codigo curto): por IP, por usuario e global.
    IF v_ip IS NOT NULL
       AND NOT public.check_rate_limit('join:ip:' || v_ip, 10, 600) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public.check_rate_limit('join:user:' || v_uid::text, 5, 600) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public.check_rate_limit('join:global', 30, 60) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    IF v_code !~ '^[A-Z0-9]{6}$' THEN
        RAISE EXCEPTION 'codigo_invalido' USING ERRCODE = 'P0001';
    END IF;

    IF public.my_family_id() IS NOT NULL THEN
        RAISE EXCEPTION 'ja_tem_familia' USING ERRCODE = 'P0001';
    END IF;

    SELECT f.* INTO v_family
      FROM public.kids_family_codes c
      JOIN public.kids_families f ON f.id = c.family_id
     WHERE upper(c.code) = v_code;

    IF v_family IS NULL THEN
        RAISE EXCEPTION 'codigo_invalido' USING ERRCODE = 'P0001';
    END IF;

    PERFORM set_config('app.allow_family_change', 'on', true);
    UPDATE public.kids_profiles
       SET family_id = v_family.id
     WHERE id = v_uid;

    RETURN json_build_object('family_id', v_family.id, 'family_name', v_family.family_name);
END;
$function$;

grant execute on function public.kids_join_family_by_code(text) to authenticated;

-- 7) Sair da familia (desvincula o perfil; os dados da familia permanecem).
--    Se quem sai era o dono, transfere a posse para o membro mais antigo.
create or replace function public.kids_leave_family()
returns void
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    v_uid uuid := auth.uid();
    v_family uuid;
BEGIN
    IF v_uid IS NULL THEN
        RAISE EXCEPTION 'nao_autenticado' USING ERRCODE = 'P0001';
    END IF;

    SELECT family_id INTO v_family FROM public.kids_profiles WHERE id = v_uid;
    IF v_family IS NULL THEN
        RAISE EXCEPTION 'sem_familia' USING ERRCODE = 'P0001';
    END IF;

    PERFORM set_config('app.allow_family_change', 'on', true);
    UPDATE public.kids_profiles SET family_id = NULL WHERE id = v_uid;

    IF EXISTS (
        SELECT 1 FROM public.kids_families
         WHERE id = v_family AND owner_id = v_uid
    ) THEN
        UPDATE public.kids_families
           SET owner_id = (
               SELECT id FROM public.kids_profiles
                WHERE family_id = v_family
                ORDER BY created_at, id
                LIMIT 1
           )
         WHERE id = v_family;
    END IF;
END;
$function$;

grant execute on function public.kids_leave_family() to authenticated;

-- 8) Backfill: dono = perfil mais antigo de cada familia; codigo para todos.
update public.kids_families f
   set owner_id = sub.id
  from (
      select distinct on (family_id) family_id, id
        from public.kids_profiles
       where family_id is not null
       order by family_id, created_at, id
  ) sub
 where f.id = sub.family_id
   and f.owner_id is null;

do $$
declare
    r record;
begin
    for r in
        select f.id
          from public.kids_families f
          left join public.kids_family_codes c on c.family_id = f.id
         where c.family_id is null
    loop
        insert into public.kids_family_codes (family_id, code)
        values (r.id, public._dk_generate_family_code());
    end loop;
end $$;
