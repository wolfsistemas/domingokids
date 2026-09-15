-- 008_family_owner_lock.sql
-- O criador da familia (owner) NAO pode sair da familia.
-- Motivo: a familia ficaria sem dono, ninguem conseguiria gerar/renovar o
-- codigo de convite e o vinculo viraria um estado inconsistente.
-- Sai da familia apenas quem entrou por codigo (nao-dono).

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

    IF EXISTS (
        SELECT 1 FROM public.kids_families
         WHERE id = v_family AND owner_id = v_uid
    ) THEN
        RAISE EXCEPTION 'dono_nao_pode_sair' USING ERRCODE = 'P0001';
    END IF;

    PERFORM set_config('app.allow_family_change', 'on', true);
    UPDATE public.kids_profiles SET family_id = NULL WHERE id = v_uid;
END;
$function$;

grant execute on function public.kids_leave_family() to authenticated;
