import { jsonResponse, validateSession } from '../_shared.js';

// GET /api/admin-clients?token=...
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const session = await validateSession(env.DB, url.searchParams.get('token'));
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { results } = await env.DB.prepare(
    `SELECT customer_email, MAX(customer_name) AS customer_name, MAX(customer_phone) AS customer_phone,
            COUNT(*) AS total_bookings, COALESCE(SUM(price_total), 0) AS total_spent, MAX(date) AS last_booking_date
     FROM bookings WHERE status != 'cancelled' GROUP BY customer_email ORDER BY last_booking_date DESC`
  ).all();

  return jsonResponse({ clients: results });
}
