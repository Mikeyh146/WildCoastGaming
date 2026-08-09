import { jsonResponse, validateSession } from '../_shared.js';

// GET /api/staff-list?token=...   (owner only)
// POST /api/staff-list  Body: { token, deleteId }   (owner only — deletes a staff account)
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const session = await validateSession(env.DB, url.searchParams.get('token'));
  if (!session || session.role !== 'owner') return jsonResponse({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare('SELECT id, username, display_name, created_at FROM staff ORDER BY created_at DESC').all();
  return jsonResponse({ staff: results });
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request' }, 400); }
  const session = await validateSession(env.DB, body.token);
  if (!session || session.role !== 'owner') return jsonResponse({ error: 'Unauthorized' }, 401);

  if (!body.deleteId) return jsonResponse({ error: 'Missing deleteId' }, 400);
  await env.DB.prepare('DELETE FROM staff WHERE id = ?').bind(body.deleteId).run();
  return jsonResponse({ success: true });
}
