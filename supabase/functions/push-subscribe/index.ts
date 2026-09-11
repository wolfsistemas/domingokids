import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

  let body: { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } }; userAgent?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const endpoint = body?.subscription?.endpoint;
  const p256dh = body?.subscription?.keys?.p256dh;
  const auth = body?.subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) return json({ error: 'invalid_subscription' }, 400);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const { error: upsertError } = await admin
    .from('kids_push_subscriptions')
    .upsert(
      {
        user_id: authData.user.id,
        endpoint,
        p256dh,
        auth,
        user_agent: body.userAgent || req.headers.get('user-agent'),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,endpoint' },
    );

  if (upsertError) return json({ error: upsertError.message }, 400);
  return json({ ok: true });
});
