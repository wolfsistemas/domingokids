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

  const key = Deno.env.get('IMGBB_API_KEY') || '';
  if (!key) return json({ error: 'imgbb_not_configured' }, 500);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: 'invalid_form' }, 400);
  }

  const image = form.get('image');
  if (!(image instanceof File) || image.size === 0) return json({ error: 'missing_image' }, 400);
  if (image.size > 5 * 1024 * 1024) return json({ error: 'image_too_large' }, 413);

  const out = new FormData();
  out.append('image', image, image.name || 'upload');

  const resp = await fetch(`https://api.imgbb.com/1/upload?key=${key}`, {
    method: 'POST',
    body: out,
  });
  const result = await resp.json().catch(() => null);
  if (!resp.ok || !result || !result.success || !result.data || !result.data.url) {
    return json({ error: 'upload_failed' }, 502);
  }

  return json({ ok: true, url: result.data.url });
});
