// Cloudflare Pages Function: /api/admin-credits
// GET: list account usage and recent credit grants for admins.
// POST: grant 1-100 bonus reviews to a selected account.
// Required secrets/variables: SUPABASE_URL, SUPABASE_SECRET_KEY, and
// SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY.

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function serviceHeaders(secretKey, extra = {}) {
  return { apikey: secretKey, 'Content-Type': 'application/json', ...extra };
}

function getConfig(env) {
  const url = env.SUPABASE_URL;
  const publishableKey = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = env.SUPABASE_SECRET_KEY;
  if (!url || !publishableKey || !secretKey) return null;
  return { url: url.replace(/\/$/, ''), publishableKey, secretKey };
}

async function requireAdmin(request, env) {
  const config = getConfig(env);
  if (!config) return { error: json({ error: 'Server configuration is incomplete.' }, 503) };

  const match = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return { error: json({ error: 'Please sign in first.' }, 401) };

  let authResponse;
  try {
    authResponse = await fetch(`${config.url}/auth/v1/user`, {
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${match[1]}` }
    });
  } catch (error) {
    console.error('Admin endpoint session verification failed', String(error?.message || error));
    return { error: json({ error: 'Could not verify your session. Please try again.' }, 502) };
  }
  if (!authResponse.ok) return { error: json({ error: 'Your session has expired. Please sign in again.' }, 401) };

  let user;
  try { user = await authResponse.json(); } catch { return { error: json({ error: 'Could not verify your account.' }, 401) }; }
  if (!user?.id) return { error: json({ error: 'Could not identify your account.' }, 401) };

  const profileUrl = new URL(`${config.url}/rest/v1/profiles`);
  profileUrl.searchParams.set('select', 'id,role');
  profileUrl.searchParams.set('id', `eq.${user.id}`);
  let profileResponse;
  try {
    profileResponse = await fetch(profileUrl, { headers: serviceHeaders(config.secretKey) });
  } catch (error) {
    console.error('Admin role lookup failed', String(error?.message || error));
    return { error: json({ error: 'Could not verify administrator permissions.' }, 502) };
  }
  if (!profileResponse.ok) {
    console.error('Admin role lookup returned error', profileResponse.status, (await profileResponse.text().catch(() => '')).slice(0, 300));
    return { error: json({ error: 'Could not verify administrator permissions.' }, 503) };
  }
  const profiles = await profileResponse.json().catch(() => []);
  if (!profiles[0] || profiles[0].role !== 'admin') {
    return { error: json({ error: 'Administrator access required.' }, 403) };
  }
  return { config, adminUserId: user.id };
}

async function serviceGet(config, path) {
  const response = await fetch(`${config.url}${path}`, { headers: serviceHeaders(config.secretKey) });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    console.error('Admin data request failed', response.status, detail.slice(0, 500));
    throw new Error('Could not load account data. Check the database migration and try again.');
  }
  return response.json();
}

export async function onRequestGet({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;
  try {
    const [profiles, usage, events] = await Promise.all([
      serviceGet(auth.config, '/rest/v1/profiles?select=id,email,display_name,plan,role,bonus_analysis_credits,created_at&order=created_at.desc&limit=200'),
      serviceGet(auth.config, '/rest/v1/analysis_usage?select=user_id,completed_count,reserved_count&limit=1000'),
      serviceGet(auth.config, '/rest/v1/analysis_credit_events?select=id,admin_user_id,target_user_id,amount,reason,created_at&order=created_at.desc&limit=50')
    ]);
    const usageByUser = new Map((usage || []).map(row => [row.user_id, row]));
    const users = (profiles || []).map(profile => {
      const counts = usageByUser.get(profile.id) || {};
      const used = Number(counts.completed_count || 0) + Number(counts.reserved_count || 0);
      const baseLimit = profile.plan === 'free' ? 1 : 0;
      const bonus = Number(profile.bonus_analysis_credits || 0);
      return {
        id: profile.id,
        email: profile.email || '',
        display_name: profile.display_name || '',
        plan: profile.plan || 'free',
        role: profile.role || 'user',
        completed_count: Number(counts.completed_count || 0),
        reserved_count: Number(counts.reserved_count || 0),
        used,
        base_limit: baseLimit,
        bonus_analysis_credits: bonus,
        total_limit: baseLimit + bonus,
        remaining: Math.max(0, baseLimit + bonus - used),
        created_at: profile.created_at
      };
    });
    return json({ users, events: events || [] });
  } catch (error) {
    return json({ error: error?.message || 'Could not load admin data.' }, 503);
  }
}

export async function onRequestPost({ request, env }) {
  const auth = await requireAdmin(request, env);
  if (auth.error) return auth.error;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
  const userId = typeof body?.user_id === 'string' ? body.user_id : '';
  const amount = Number(body?.amount);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
    return json({ error: 'Select a valid account.' }, 400);
  }
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    return json({ error: 'Choose between 1 and 100 extra reviews.' }, 400);
  }
  if (reason.length > 300) return json({ error: 'Reason must be 300 characters or fewer.' }, 400);

  try {
    const response = await fetch(`${auth.config.url}/rest/v1/rpc/grant_analysis_credits`, {
      method: 'POST',
      headers: serviceHeaders(auth.config.secretKey),
      body: JSON.stringify({
        p_admin_user_id: auth.adminUserId,
        p_user_id: userId,
        p_amount: amount,
        p_reason: reason
      })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('Credit grant RPC failed', response.status, detail.slice(0, 500));
      return json({ error: 'Could not grant credits. Confirm the admin-credit database migration has run.' }, 503);
    }
    const balance = await response.json().catch(() => null);
    return json({ ok: true, user_id: userId, granted: amount, bonus_analysis_credits: Number(balance) });
  } catch (error) {
    console.error('Credit grant request failed', String(error?.message || error));
    return json({ error: 'Could not grant credits. Please try again.' }, 503);
  }
}
