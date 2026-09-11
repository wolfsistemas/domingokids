import { createClient } from 'npm:@supabase/supabase-js@2';
import { buildPushPayload } from 'npm:@block65/webcrypto-web-push@1.0.2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PushEvent = 'checkin' | 'checkout' | 'broadcast';

interface SendBody {
  event?: PushEvent;
  checkinId?: string;
  childId?: string;
  childName?: string;
  room?: string;
  title?: string;
  body?: string;
  url?: string;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
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

  const eventName = payload.event || 'broadcast';
  if (!isStaff) return json({ error: 'forbidden' }, 403);

  let childId = payload.childId || null;
  let childName = payload.childName || 'sua criança';
  let room = payload.room || '';
  let familyId: string | null = null;

  if (payload.checkinId) {
    const { data: checkin } = await admin
      .from('kids_check_ins')
      .select('id, room, child_id, child:child_id(id, name, family_id)')
      .eq('id', payload.checkinId)
      .maybeSingle();
    if (checkin) {
      childId = checkin.child_id;
      room = room || checkin.room || '';
      const child = Array.isArray(checkin.child) ? checkin.child[0] : checkin.child;
      if (child) {
        childName = child.name || childName;
        familyId = child.family_id;
      }
    }
  } else if (childId) {
    const { data: child } = await admin
      .from('kids_children')
      .select('id, name, family_id')
      .eq('id', childId)
      .maybeSingle();
    if (child) {
      childName = child.name || childName;
      familyId = child.family_id;
    }
  }

  let userIds: string[] = [];
  if (eventName === 'broadcast') {
    const { data: parents } = await admin
      .from('kids_profiles')
      .select('id')
      .in('role', ['parent', 'both']);
    userIds = (parents || []).map((row) => row.id);
  } else if (familyId) {
    const { data: parents } = await admin
      .from('kids_profiles')
      .select('id')
      .eq('family_id', familyId);
    userIds = (parents || []).map((row) => row.id);
  }

  userIds = userIds.filter((id) => id && id !== authData.user.id);
  if (!userIds.length) return json({ ok: true, sent: 0, reason: 'no_recipients' });

  const { data: subscriptions } = await admin
    .from('kids_push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', userIds);

  if (!subscriptions?.length) return json({ ok: true, sent: 0, reason: 'no_subscriptions' });

  const roomLabel = room === 'todos' ? 'todas as salas' : room;
  let title = payload.title || 'Domingo Kids';
  let body = payload.body || '';
  const url = payload.url || './pais.html';

  if (eventName === 'checkin') {
    title = 'Check-in realizado';
    body = roomLabel
      ? `${childName} entrou na sala ${roomLabel}.`
      : `${childName} fez check-in.`;
  } else if (eventName === 'checkout') {
    title = 'Check-out realizado';
    body = `${childName} foi liberado(a). Pode buscar.`;
  }

  const vapid = {
    subject: Deno.env.get('VAPID_SUBJECT') || 'mailto:contato@videirajatai.com.br',
    publicKey: Deno.env.get('VAPID_PUBLIC_KEY') || '',
    privateKey: Deno.env.get('VAPID_PRIVATE_KEY') || '',
  };
  if (!vapid.publicKey || !vapid.privateKey) return json({ error: 'vapid_not_configured' }, 500);

  const message = {
    data: JSON.stringify({ title, body, url, event: eventName, childId, room }),
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

  return json({ ok: true, sent, removed: staleIds.length });
});
