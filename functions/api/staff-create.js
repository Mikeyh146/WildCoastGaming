import { jsonResponse, validateSession, hashPassword, generateRandomHex } from '../_shared.js';

// POST /api/staff-create  (owner only)
// Body: { token, username, password, displayName }
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request' }, 400); }
  const { token, username, password, displayName } = body;

  const session = await validateSession(env.DB, token);
  if (!session || session.role !== 'owner') return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!username || !password || !displayName) {
    return jsonResponse({ error: 'Missing username, password, or display name' }, 400);
  }

  const existing = await env.DB.prepare('SELECT id FROM staff WHERE username = ?').bind(username.trim()).first();
  if (existing) return jsonResponse({ error: 'That username is already taken' }, 409);

  const salt = generateRandomHex(16);
  const hash = await hashPassword(password, salt);

  await env.DB.prepare(
    `INSERT INTO staff (username, display_name, salt, password_hash) VALUES (?, ?, ?, ?)`
  ).bind(username.trim(), displayName, salt, hash).run();

  return jsonResponse({ success: true });
}
