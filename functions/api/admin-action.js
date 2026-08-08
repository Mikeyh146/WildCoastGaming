import { jsonResponse, isAdminAuthed } from '../_shared.js';

// POST /api/admin-action
// Body: { password, id, action }  where action is 'cancel' | 'mark-paid' | 'mark-unpaid'
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { password, id, action } = body;

  if (!isAdminAuthed(env, password)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!id || !action) {
    return jsonResponse({ error: 'Missing id or action' }, 400);
  }

  let sql;
  if (action === 'cancel') {
    sql = `UPDATE bookings SET status = 'cancelled' WHERE id = ?`;
  } else if (action === 'mark-paid') {
    sql = `UPDATE bookings SET paid = 1 WHERE id = ?`;
  } else if (action === 'mark-unpaid') {
    sql = `UPDATE bookings SET paid = 0 WHERE id = ?`;
  } else if (action === 'mark-arrived') {
    sql = `UPDATE bookings SET status = 'arrived' WHERE id = ?`;
  } else {
    return jsonResponse({ error: 'Unknown action' }, 400);
  }

  await env.DB.prepare(sql).bind(id).run();

  return jsonResponse({ success: true });
}
