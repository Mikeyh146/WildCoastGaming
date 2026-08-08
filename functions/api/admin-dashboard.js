import { jsonResponse, isAdminAuthed } from '../_shared.js';

// GET /api/admin-dashboard?password=...
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const password = url.searchParams.get('password');

  if (!isAdminAuthed(env, password)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const today = new Date().toISOString().split('T')[0];

  const totals = await env.DB
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN paid = 1 THEN price_total ELSE 0 END), 0) AS revenue_collected,
         COALESCE(SUM(CASE WHEN paid = 0 THEN price_total ELSE 0 END), 0) AS outstanding,
         COUNT(CASE WHEN date >= ? THEN 1 END) AS upcoming_count,
         COUNT(CASE WHEN date = ? THEN 1 END) AS today_count
       FROM bookings WHERE status != 'cancelled'`
    )
    .bind(today, today)
    .first();

  const { results: byService } = await env.DB
    .prepare(
      `SELECT s.name AS service_name, COUNT(*) AS bookings, COALESCE(SUM(b.price_total), 0) AS revenue
       FROM bookings b JOIN services s ON s.key = b.service_key
       WHERE b.status != 'cancelled'
       GROUP BY b.service_key
       ORDER BY revenue DESC`
    )
    .all();

  const { results: todaysBookings } = await env.DB
    .prepare(
      `SELECT b.*, s.name AS service_name FROM bookings b
       JOIN services s ON s.key = b.service_key
       WHERE b.date = ? AND b.status != 'cancelled'
       ORDER BY b.start_time ASC`
    )
    .bind(today)
    .all();

  return jsonResponse({ totals, byService, todaysBookings });
}
