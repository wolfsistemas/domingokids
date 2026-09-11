import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPushPayload } from 'npm:@block65/webcrypto-web-push@1.0.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PushEvent = 'checkin' | 'checkout' | 'broadcast' | 'aviso' | 'aniversario_checkin';

const CONFIG_KEY: Record<PushEvent, string> = {
  checkin: 'checkin',
  checkout: 'checkout',
  broadcast: 'aviso',
  aviso: 'aviso',
  aniversario_checkin: 'aniversario_checkin',
};

interface SendBody {
  event?: PushEvent;
  checkinId?: string;
  childId?: string;
  childName?: string;
  room?: string;
  title?: string;
  body?: string;
  url?: string;
  selfTest?: boolean;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function hojeSaoPaulo(): Date {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function diasAteAniversario(birthDateStr: string | null, ref: Date): number {
  if (!birthDateStr) return -1;
  const [, bm, bd] = birthDateStr.split('-').map(Number);
  for (let d = 0; d <= 6; d++) {
    const dt = new Date(ref.getTime() + d * 86400000);
    if (dt.getUTCMonth() + 1 === bm && dt.getUTCDate() === bd) return d;
  }
  return -1;
}

function formatarDiaSemana(data: Date): string {
  const txt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(data);
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const authHeader = req.headers.get('Authorization') || '';
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return json({ error: 'unauthorized' }, 401);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const { data: profile } = await admin
    .from('kids_profiles')
    .select('id, role, family_id')
    .eq('id', authData.user.id)
    .maybeSingle();

  const role = profile?.role || 'parent';
  const isStaff = role === 'staff' || role === 'admin' || role === 'both';

  let payload: SendBody;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const eventName: PushEvent = payload.event || 'broadcast';
  const selfTest = payload.selfTest === true;
  if (!isStaff) return json({ error: 'forbidden' }, 403);
  if ((eventName === 'aviso' || eventName === 'broadcast') && role !== 'admin') {
    return json({ error: 'forbidden' }, 403);
  }

  if (!selfTest) {
    const { data: configRows } = await admin
      .from('kids_push_config')
      .select('chave, ativo');
    const config = new Map((configRows || []).map((r) => [r.chave, r.ativo]));
    if (config.get('global') === false) return json({ ok: true, sent: 0, reason: 'global_off' });
    const key = CONFIG_KEY[eventName] || eventName;
    if (config.get(key) === false) return json({ ok: true, sent: 0, reason: `${key}_off` });
  }

  let childId = payload.childId || null;
  let childName = payload.childName || 'sua criança';
  let room = payload.room || '';
  let familyId: string | null = null;
  let birthDate: string | null = null;

  if (payload.checkinId) {
    const { data: checkin } = await admin
      .from('kids_check_ins')
      .select('id, room, child_id, child:child_id(id, name, family_id, birth_date)')
      .eq('id', payload.checkinId)
      .maybeSingle();
    if (checkin) {
      childId = checkin.child_id;
      room = room || checkin.room || '';
      const child = Array.isArray(checkin.child) ? checkin.child[0] : checkin.child;
      if (child) {
        childName = child.name || childName;
        familyId = child.family_id;
        birthDate = child.birth_date || null;
      }
    }
  } else if (childId) {
    const { data: child } = await admin
      .from('kids_children')
      .select('id, name, family_id, birth_date')
      .eq('id', childId)
      .maybeSingle();
    if (child) {
      childName = child.name || childName;
      familyId = child.family_id;
      birthDate = child.birth_date || null;
    }
  }

  const roomLabel = room === 'todos' ? 'todas as salas' : room;
  let title = payload.title || 'Domingo Kids';
  let body = payload.body || '';
  let url = payload.url || './pais.html';

  let userIds: string[] = [];

  if (eventName === 'aniversario_checkin') {
    const dias = diasAteAniversario(birthDate, hojeSaoPaulo());
    if (dias < 0) return json({ ok: true, sent: 0, reason: 'no_birthday' });

    const { data: equipe } = await admin
      .from('kids_profiles')
      .select('id')
      .in('role', ['staff', 'admin', 'both']);
    userIds = (equipe || []).map((row) => row.id);

    url = './equipe.html';
    if (dias === 0) {
      title = 'Aniversariante de hoje';
      body = `Parabens HOJE para ${childName}! Nao deixe passar os parabens.`;
    } else {
      const data = new Date(hojeSaoPaulo().getTime() + dias * 86400000);
      const diaSemana = formatarDiaSemana(data);
      const ddmm = `${String(data.getUTCDate()).padStart(2, '0')}/${String(data.getUTCMonth() + 1).padStart(2, '0')}`;
      title = 'Aniversariante da semana';
      body = `Atencao equipe: ${childName} faz aniversario ${diaSemana} (${ddmm}).`;
    }
  } else if (eventName === 'checkin' || eventName === 'checkout') {
    if (familyId) {
      const { data: parents } = await admin
        .from('kids_profiles')
        .select('id')
        .eq('family_id', familyId);
      userIds = (parents || []).map((row) => row.id);
    }
    if (eventName === 'checkin') {
      title = 'Check-in realizado';
      body = roomLabel
        ? `${childName} entrou na sala ${roomLabel}.`
        : `${childName} fez check-in.`;
    } else {
      title = 'Check-out realizado';
      body = `${childName} foi liberado(a). Pode buscar.`;
    }
  } else {
    const { data: parents } = await admin
      .from('kids_profiles')
      .select('id')
      .in('role', ['parent', 'both']);
    userIds = (parents || []).map((row) => row.id);
    if (!payload.body) body = '';
  }

  if (selfTest) {
    userIds = [authData.user.id];
    title = payload.title || 'Domingo Kids (teste)';
    body = payload.body || 'Notificacao de teste. Se voce recebeu, esta funcionando.';
    url = './admin.html';
  } else if (eventName === 'aviso' || eventName === 'broadcast') {
    userIds = userIds.filter((id) => id && id !== authData.user.id);
  }

  userIds = userIds.filter((id) => !!id);
  if (!userIds.length) return json({ ok: true, sent: 0, reason: 'no_recipients' });

  const { data: subscriptions } = await admin
    .from('kids_push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', userIds);

  if (!subscriptions?.length) return json({ ok: true, sent: 0, reason: 'no_subscriptions' });

  const vapid = {
    subject: Deno.env.get('VAPID_SUBJECT') || 'mailto:contato@videirajatai.com.br',
    publicKey: Deno.env.get('VAPID_PUBLIC_KEY') || '',
    privateKey: Deno.env.get('VAPID_PRIVATE_KEY') || '',
  };
  if (!vapid.publicKey || !vapid.privateKey) return json({ error: 'vapid_not_configured' }, 500);

  const tag = selfTest ? 'teste' : `${eventName}:${childId || 'all'}`;
  const message = {
    data: JSON.stringify({ title, body, url, tag, event: eventName, childId, room }),
    options: { ttl: 60 * 60, urgency: 'high' as const },
  };

  let sent = 0;
  const staleIds: string[] = [];

  await Promise.all(subscriptions.map(async (row) => {
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
      if (response.ok || response.status === 201) sent += 1;
    } catch (err) {
      console.error('push failed', err);
    }
  }));

  if (staleIds.length) {
    await admin.from('kids_push_subscriptions').delete().in('id', staleIds);
  }

  await admin.from('kids_notifications_log').insert({
    chave: selfTest ? 'teste' : eventName,
    titulo: title,
    corpo: body,
    destinatarios: sent,
    meta: { eventos: userIds.length, subscriptions: subscriptions.length, selfTest },
  });

  return json({ ok: true, sent, removed: staleIds.length });
});
