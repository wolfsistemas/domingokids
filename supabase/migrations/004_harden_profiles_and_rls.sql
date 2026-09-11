-- 004_harden_profiles_and_rls.sql
-- Endurecimento de perfis, RLS e funcoes SECURITY DEFINER.

-- 1) Bloqueia alteracao de email/username por nao-admin (alem de role/family_id).
create or replace function public.kids_profiles_guard()
returns trigger
language plpgsql
security definer
set search_path to public
as $function$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;

    IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'Alteracao de perfil nao permitida.';
    END IF;

    IF NEW.family_id IS DISTINCT FROM OLD.family_id
       AND COALESCE(current_setting('app.allow_family_change', true), '') <> 'on' THEN
        RAISE EXCEPTION 'Alteracao de familia nao permitida.';
    END IF;

    IF NEW.email IS DISTINCT FROM OLD.email THEN
        RAISE EXCEPTION 'Alteracao de email nao permitida.';
    END IF;

    IF NEW.username IS DISTINCT FROM OLD.username THEN
        RAISE EXCEPTION 'Alteracao de usuario nao permitida.';
    END IF;

    RETURN NEW;
END;
$function$;

-- 2) Impede remover/rebaixar o ultimo administrador.
create or replace function public.kids_profiles_protect_last_admin()
returns trigger
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    outros_admins INT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('kids_profiles_last_admin'));

    IF TG_OP = 'DELETE' THEN
        IF OLD.role = 'admin' THEN
            SELECT count(*) INTO outros_admins
              FROM public.kids_profiles
             WHERE role = 'admin' AND id <> OLD.id;
            IF outros_admins = 0 THEN
                RAISE EXCEPTION 'Nao e possivel excluir o ultimo administrador.';
            END IF;
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.role = 'admin' AND NEW.role IS DISTINCT FROM 'admin' THEN
        SELECT count(*) INTO outros_admins
          FROM public.kids_profiles
         WHERE role = 'admin' AND id <> OLD.id;
        IF outros_admins = 0 THEN
            RAISE EXCEPTION 'Nao e possivel rebaixar o ultimo administrador.';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

drop trigger if exists kids_profiles_protect_last_admin on public.kids_profiles;
create trigger kids_profiles_protect_last_admin
  before update or delete on public.kids_profiles
  for each row execute function public.kids_profiles_protect_last_admin();

-- 3) Indice unico case-insensitive para username.
create unique index if not exists kids_profiles_username_lower_key
  on public.kids_profiles (lower(username));

-- 4) Login por username case-insensitive e deterministico.
create or replace function public.get_email_por_username(p_username text)
returns text
language sql
stable
security definer
set search_path to public
as $function$
  SELECT email
    FROM public.kids_profiles
   WHERE lower(username) = lower(p_username)
   ORDER BY created_at
   LIMIT 1;
$function$;

-- 5) Disponibilidade de cadastro case-insensitive.
create or replace function public.check_cadastro_disponivel(p_username text, p_email text)
returns table(username_ocupado boolean, email_ocupado boolean)
language sql
stable
security definer
set search_path to public
as $function$
  SELECT
    EXISTS(SELECT 1 FROM public.kids_profiles WHERE lower(username) = lower(p_username)),
    EXISTS(SELECT 1 FROM public.kids_profiles WHERE lower(email) = lower(p_email));
$function$;

-- 6) search_path nas demais funcoes SECURITY DEFINER.
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path to public
as $function$
  SELECT EXISTS (
    SELECT 1 FROM public.kids_profiles
    WHERE id = auth.uid() AND role IN ('staff', 'admin', 'both')
  );
$function$;

create or replace function public.my_family_id()
returns uuid
language sql
stable
security definer
set search_path to public
as $function$
  SELECT family_id FROM public.kids_profiles WHERE id = auth.uid();
$function$;

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

  INSERT INTO public.kids_families (family_name)
  VALUES (p_family_name)
  RETURNING * INTO new_family;

  PERFORM set_config('app.allow_family_change', 'on', true);
  UPDATE public.kids_profiles
  SET family_id = new_family.id
  WHERE id = auth.uid();

  RETURN new_family;
END;
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    base_username TEXT;
    final_username TEXT;
    counter INT;
BEGIN
    base_username := COALESCE(
        NEW.raw_user_meta_data->>'username',
        split_part(NEW.email, '@', 1)
    );

    IF EXISTS (SELECT 1 FROM public.kids_profiles WHERE lower(username) = lower(base_username)) THEN
        counter := 1;
        LOOP
            final_username := base_username || counter::TEXT;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.kids_profiles WHERE lower(username) = lower(final_username));
            counter := counter + 1;
        END LOOP;
    ELSE
        final_username := base_username;
    END IF;

    INSERT INTO public.kids_profiles (id, email, full_name, role, username)
    VALUES (
        NEW.id,
        NEW.email,
        COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
        'parent',
        final_username
    );
    RETURN NEW;
END;
$function$;

-- 7) Reduz superficie de enumeracao: funcao legada sem uso no cliente.
create or replace function public.buscar_email_por_username(username_busca text)
returns text
language plpgsql
security definer
set search_path to public
as $function$
BEGIN
    RETURN (SELECT email FROM public.kids_profiles WHERE lower(username) = lower(username_busca) ORDER BY created_at LIMIT 1);
END;
$function$;

revoke execute on function public.buscar_email_por_username(text) from public, anon, authenticated;

-- 8) RLS: push config somente admin.
-- Sessoes continuam legiveis por qualquer autenticado: os pais leem
-- name/session_date via embed em kids_check_ins (dados nao sensiveis).
drop policy if exists kids_push_config_select_auth on public.kids_push_config;
drop policy if exists kids_push_config_select_admin on public.kids_push_config;
create policy kids_push_config_select_admin
  on public.kids_push_config
  for select
  to authenticated
  using (public.is_admin());
