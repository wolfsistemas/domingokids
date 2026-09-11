-- 005_rate_limits.sql
-- Rate limiting de operacoes sensiveis:
--   * enumeracao de usuarios/e-mails (get_email_por_username, check_cadastro_disponivel)
--   * envio de push (send-push) — ver tambem a funcao de borda
-- A tabela e privada (RLS sem policies) e o acesso se da apenas por funcao SECURITY DEFINER.

-- 1) Tabela de contadores por janela fixa (bucket -> contador).
create table if not exists public.kids_rate_limits (
    bucket text primary key,
    janela timestamptz not null default now(),
    contador integer not null default 0,
    atualizado_em timestamptz not null default now()
);

alter table public.kids_rate_limits enable row level security;
revoke all on public.kids_rate_limits from anon, authenticated;
grant all on public.kids_rate_limits to service_role;

create index if not exists kids_rate_limits_atualizado_idx
    on public.kids_rate_limits (atualizado_em);

-- 2) Identificacao do cliente (IP) a partir dos headers do PostgREST.
--    Retorna NULL quando os headers nao estao disponiveis; nesse caso o
--    limite por IP e ignorado e prevalecem os limites por usuario/global.
create or replace function public._dk_client_ip()
returns text
language plpgsql
stable
security definer
set search_path to public
as $function$
DECLARE
    h jsonb;
    ip text;
BEGIN
    BEGIN
        h := coalesce(current_setting('request.headers', true), '')::jsonb;
    EXCEPTION WHEN others THEN
        RETURN NULL;
    END;

    IF h IS NULL THEN
        RETURN NULL;
    END IF;

    ip := coalesce(h->>'x-forwarded-for', h->>'cf-connecting-ip', h->>'x-real-ip');
    IF ip IS NULL OR btrim(ip) = '' THEN
        RETURN NULL;
    END IF;

    RETURN btrim(split_part(ip, ',', 1));
END;
$function$;

revoke all on function public._dk_client_ip() from public, anon, authenticated;
grant execute on function public._dk_client_ip() to service_role;

-- 3) Consumidor de limite (janela fixa). Retorna true se ainda permitido.
--    Uso interno apenas (revogado de anon/authenticated).
create or replace function public.check_rate_limit(
    p_bucket text,
    p_max integer,
    p_janela_segundos integer
)
returns boolean
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    v_agora timestamptz := clock_timestamp();
    v_contador integer;
BEGIN
    IF p_bucket IS NULL OR p_max IS NULL OR p_janela_segundos IS NULL THEN
        RETURN true;
    END IF;

    INSERT INTO public.kids_rate_limits AS rl (bucket, janela, contador, atualizado_em)
    VALUES (p_bucket, v_agora, 1, v_agora)
    ON CONFLICT (bucket) DO UPDATE
        SET contador = CASE
                WHEN rl.janela < v_agora - make_interval(secs => p_janela_segundos) THEN 1
                ELSE rl.contador + 1
            END,
            janela = CASE
                WHEN rl.janela < v_agora - make_interval(secs => p_janela_segundos) THEN v_agora
                ELSE rl.janela
            END,
            atualizado_em = v_agora
        RETURNING rl.contador INTO v_contador;

    -- Limpeza oportunista: ao tocar um bucket global, remove buckets antigos.
    IF p_bucket LIKE '%:global' THEN
        DELETE FROM public.kids_rate_limits
         WHERE atualizado_em < v_agora - interval '2 days'
           AND bucket <> p_bucket;
    END IF;

    RETURN v_contador <= p_max;
END;
$function$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

-- 4) Enumeracao de e-mail: limita por IP, por usuario e globalmente.
create or replace function public.get_email_por_username(p_username text)
returns text
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    v_ip text := public._dk_client_ip();
    v_user text := lower(coalesce(p_username, ''));
BEGIN
    IF v_ip IS NOT NULL
       AND NOT public.check_rate_limit('lookup:ip:' || v_ip, 12, 600) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public.check_rate_limit('lookup:user:' || v_user, 5, 600) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public.check_rate_limit('lookup:global', 300, 60) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    RETURN (SELECT email
              FROM public.kids_profiles
             WHERE lower(username) = v_user
             ORDER BY created_at
             LIMIT 1);
END;
$function$;

grant execute on function public.get_email_por_username(text) to anon, authenticated;

-- 5) Disponibilidade de cadastro: mesmos limites (evita enumeracao por essa via).
create or replace function public.check_cadastro_disponivel(p_username text, p_email text)
returns table(username_ocupado boolean, email_ocupado boolean)
language plpgsql
security definer
set search_path to public
as $function$
DECLARE
    v_ip text := public._dk_client_ip();
    v_user text := lower(coalesce(p_username, ''));
    v_email text := lower(coalesce(p_email, ''));
BEGIN
    IF v_ip IS NOT NULL
       AND NOT public.check_rate_limit('cadastro:ip:' || v_ip, 12, 600) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public.check_rate_limit('cadastro:user:' || v_user || ':' || v_email, 5, 600) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    IF NOT public.check_rate_limit('cadastro:global', 300, 60) THEN
        RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT EXISTS(SELECT 1 FROM public.kids_profiles WHERE lower(username) = v_user),
           EXISTS(SELECT 1 FROM public.kids_profiles WHERE lower(email) = v_email);
END;
$function$;

grant execute on function public.check_cadastro_disponivel(text, text) to anon, authenticated;
