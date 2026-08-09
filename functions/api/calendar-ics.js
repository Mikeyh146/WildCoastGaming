import { buildIcs } from '../_shared.js';

// GET /api/calendar-ics?ref=WCG-XXXXXX&token=...
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const reference = url.searchParams.get('ref');
  const token = url.searchParams.get('token');

  const booking = await env.DB.prepare('SELECT * FROM bookings WHERE reference = ?').bind(reference).first();
  if (!booking || booking.manage_token !== token) {
    return new Response('Not found', { status: 404 });
  }

  const service = await env.DB.prepare('SELECT * FROM services WHERE key = ?').bind(booking.service_key).first();
  const ics = buildIcs({ ...booking, service_name: service.name });

  return new Response(ics, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="wild-coast-gaming-${booking.reference}.ics"`,
    },
  });
}
