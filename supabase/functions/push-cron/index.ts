import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPushPayload } from 'npm:@block65/webcrypto-web-push@1.0.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-push-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function hojeSaoPaulo(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const secret = Deno.env.get('PUSH_SECRET') || '';
  if (!secret || req.headers.get('x-push-secret') !== secret) {
    return json({ error: 'unauthorized' }, 401);
  }

  let task = 'checkout';
  try {
    const body = await req.json();
    if (body && body.task) task = body.task;
  } catch {
    // body opcional
  }

  if (task !== 'checkout') return json({ error: 'unknown_task' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const { data: configRows } = await admin
    .from('kids_push_config')
    .select('chave, ativo');
  const config = new Map((configRows || []).map((r) => [r.chave, r.ativo]));
  if (config.get('global') === false) return json({ ok: true, sent: 0, reason: 'global_off' });
  if (config.get('checkout_pendente') === false) return json({ ok: true, sent: 0, reason: 'checkout_pendente_off' });

  const hoje = hojeSaoPaulo();
  const { data: sessions } = await admin
    .from('kids_sessions')
    .select('id')
    .eq('session_date', hoje);
  const sessionIds = (sessions || []).map((s) => s.id);
  if (!sessionIds.length) return json({ ok: true, sent: 0, reason: 'no_session' });

  const { data: checkins } = await admin
    .from('kids_check_ins')
    .select('id, child:child_id(id, name, family_id, is_visitor)')
    .in('session_id', sessionIds)
    .is('checked_out_at', null);

  const porFamilia = new Map<string, { ids: string[]; nomes: string[] }>();
  for (const c of checkins || []) {
    const child = Array.isArray(c.child) ? c.child[0] : c.child;
    if (!child || child.is_visitor || !child.family_id) continue;
    const atual = porFamilia.get(child.family_id) || { ids: [], nomes: [] };
    atual.ids.push(child.id);
    atual.nomes.push(child.name);
    porFamilia.set(child.family_id, atual);
  }

  if (!porFamilia.size) return json({ ok: true, sent: 0, reason: 'no_pending' });

  const vapid = {
    subject: Deno.env.get('VAPID_SUBJECT') || 'mailto:contato@videirajatai.com.br',
    publicKey: Deno.env.get('VAPID_PUBLIC_KEY') || '',
    privateKey: Deno.env.get('VAPID_PRIVATE_KEY') || '',
  };
  if (!vapid.publicKey || !vapid.privateKey) return json({ error: 'vapid_not_configured' }, 500);

  let totalEnviados = 0;
  const staleIds: string[] = [];

  for (const [familyId, dados] of porFamilia) {
    const { data: parents } = await admin
      .from('kids_profiles')
      .select('id')
      .eq('family_id', familyId);
    const userIds = (parents || []).map((r) => r.id).filter(Boolean);
    if (!userIds.length) continue;

    const { data: subs } = await admin
      .from('kids_push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .in('user_id', userIds);
    if (!subs?.length) continue;

    const nomes = dados.nomes.join(', ');
    const message = {
      data: JSON.stringify({
        title: 'Check-out pendente',
        body: `${nomes} ainda na sala. Por favor, faca o check-out.`,
        url: './pais.html',
        tag: `checkout_pendente:${familyId}`,
        event: 'checkout_pendente',
      }),
      options: { ttl: 60 * 60 * 2, urgency: 'high' as const },
    };

    await Promise.all(subs.map(async (row) => {
      try {
        const pushRequest = await buildPushPayload(message, {
          endpoint: row.endpoint,
          expirationTime: null,
          keys: { p256dh: row.p256dh, auth: row.auth },
        }, vapid);
        const response = await fetch(row.endpoint, pushRequest);
        if (response.status === 404 || response.status === 410) {
          staleIds.push(row.id);
          return;
        }
        if (response.ok || response.status === 201) totalEnviados += 1;
      } catch (err) {
        console.error('push failed', err);
      }
    }));
  }

  if (staleIds.length) {
    await admin.from('kids_push_subscriptions').delete().in('id', staleIds);
  }

  await admin.from('kids_notifications_log').insert({
    chave: 'checkout_pendente',
    titulo: 'Check-out pendente',
    corpo: `${porFamilia.size} familia(s) com crianca na sala`,
    destinatarios: totalEnviados,
    meta: { familias: porFamilia.size, data: hoje },
  });

  return json({ ok: true, sent: totalEnviados, familias: porFamilia.size, removed: staleIds.length });
});
