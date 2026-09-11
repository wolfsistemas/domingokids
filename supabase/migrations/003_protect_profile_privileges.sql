-- 003_protect_profile_privileges.sql
-- Impede escalonamento de privilegio e troca de familia por usuarios comuns.

-- 1) Novos usuarios sempre entram como 'parent', ignorando metadata do cliente.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
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

    IF EXISTS (SELECT 1 FROM public.kids_profiles WHERE username = base_username) THEN
        counter := 1;
        LOOP
            final_username := base_username || counter::TEXT;
            EXIT WHEN NOT EXISTS (SELECT 1 FROM public.kids_profiles WHERE username = final_username);
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

-- 2) Bloqueia alteracao de role/family_id por quem nao e admin.
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

    RETURN NEW;
END;
$function$;

drop trigger if exists kids_profiles_guard on public.kids_profiles;
create trigger kids_profiles_guard
  before update on public.kids_profiles
  for each row execute function public.kids_profiles_guard();

-- 3) Auto-cadastro so pode criar perfil com role 'parent'.
drop policy if exists profiles_insert_own on public.kids_profiles;
create policy profiles_insert_own
  on public.kids_profiles
  for insert
  to authenticated
  with check (id = auth.uid() and role = 'parent');

-- 4) create_family marca a flag que autoriza o vinculo de familia.
create or replace function public.create_family(p_family_name text)
returns kids_families
language plpgsql
security definer
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
