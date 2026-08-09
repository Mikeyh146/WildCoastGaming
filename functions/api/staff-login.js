import { jsonResponse, createSession, verifyPassword } from '../_shared.js';

// POST /api/staff-login
// Body: { username, password }
// Leave username blank to log in as Owner using the master ADMIN_PASSWORD.
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request' }, 400); }
  const { username, password } = body;

  // Owner login (master password, no staff account needed).
  if (!username || username.trim() === '') {
    if (env.ADMIN_PASSWORD && password === env.ADMIN_PASSWORD) {
      const session = await createSession(env.DB, 'Owner', 'owner');
      return jsonResponse({ token: session.token, role: 'owner', displayName: 'Owner' });
    }
    return jsonResponse({ error: 'Incorrect password' }, 401);
  }

  // Named staff login.
  const staff = await env.DB.prepare('SELECT * FROM staff WHERE username = ?').bind(username.trim()).first();
  if (!staff) return jsonResponse({ error: 'Unknown username or password' }, 401);

  const ok = await verifyPassword(password, staff.salt, staff.password_hash);
  if (!ok) return jsonResponse({ error: 'Unknown username or password' }, 401);

  const session = await createSession(env.DB, staff.username, 'staff');
  return jsonResponse({ token: session.token, role: 'staff', displayName: staff.display_name });
}
