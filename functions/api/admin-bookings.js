import { jsonResponse, isAdminAuthed } from '../_shared.js';

// GET /api/admin-bookings?password=...&from=2026-08-01&to=2026-08-31&includeCancelled=1
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password');

  if (!isAdminAuthed(env, password)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const from = url.searchParams.get('from') || '0000-01-01';
  const to = url.searchParams.get('to') || '9999-12-31';
  const includeCancelled = url.searchParams.get('includeCancelled') === '1';

  const statusClause = includeCancelled ? '' : `AND b.status != 'cancelled'`;

  const { results } = await env.DB
    .prepare(
      `SELECT b.*, s.name AS service_name
       FROM bookings b
       JOIN services s ON s.key = b.service_key
       WHERE b.date BETWEEN ? AND ? ${statusClause}
       ORDER BY b.date ASC, b.start_time ASC`
    )
    .bind(from, to)
    .all();

  return jsonResponse({ bookings: results });
}
