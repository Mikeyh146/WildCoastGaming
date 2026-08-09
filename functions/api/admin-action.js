import { jsonResponse, validateSession, sendCancellationEmail } from '../_shared.js';

// POST /api/admin-action
// Body: { token, id, action }  action: 'cancel' | 'mark-paid' | 'mark-unpaid' | 'mark-arrived'
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request body' }, 400); }
  const { token, id, action } = body;

  const session = await validateSession(env.DB, token);
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (!id || !action) return jsonResponse({ error: 'Missing id or action' }, 400);

  let sql;
  if (action === 'cancel') sql = `UPDATE bookings SET status = 'cancelled' WHERE id = ?`;
  else if (action === 'mark-paid') sql = `UPDATE bookings SET paid = 1 WHERE id = ?`;
  else if (action === 'mark-unpaid') sql = `UPDATE bookings SET paid = 0 WHERE id = ?`;
  else if (action === 'mark-arrived') sql = `UPDATE bookings SET status = 'arrived' WHERE id = ?`;
  else return jsonResponse({ error: 'Unknown action' }, 400);

  await env.DB.prepare(sql).bind(id).run();

  if (action === 'cancel') {
    const booking = await env.DB.prepare(
      `SELECT b.*, s.name AS service_name FROM bookings b JOIN services s ON s.key = b.service_key WHERE b.id = ?`
    ).bind(id).first();
    try { await sendCancellationEmail(env, booking); } catch (e) { /* not fatal */ }
  }

  return jsonResponse({ success: true });
}
