import { jsonResponse, DURATION_BRACKETS, addHours, tryAllocate, getOpeningHoursFor, sendCancellationEmail, sendAmendedEmail } from '../_shared.js';

async function findBooking(db, reference, token) {
  const booking = await db.prepare('SELECT * FROM bookings WHERE reference = ?').bind(reference).first();
  if (!booking || booking.manage_token !== token) return null;
  return booking;
}

// GET /api/manage-booking?ref=WCG-XXXXXX&token=...
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const reference = url.searchParams.get('ref');
  const token = url.searchParams.get('token');

  const booking = await findBooking(env.DB, reference, token);
  if (!booking) return jsonResponse({ error: 'Booking not found' }, 404);

  const service = await env.DB.prepare('SELECT * FROM services WHERE key = ?').bind(booking.service_key).first();
  return jsonResponse({ booking: { ...booking, service_name: service.name } });
}

// POST /api/manage-booking
// Body: { reference, token, action: 'cancel' | 'amend', ...amend fields if amending }
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request' }, 400); }
  const { reference, token, action } = body;

  const booking = await findBooking(env.DB, reference, token);
  if (!booking) return jsonResponse({ error: 'Booking not found' }, 404);

  const service = await env.DB.prepare('SELECT * FROM services WHERE key = ?').bind(booking.service_key).first();

  if (action === 'cancel') {
    await env.DB.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).bind(booking.id).run();
    try { await sendCancellationEmail(env, { ...booking, service_name: service.name }); } catch (e) {}
    return jsonResponse({ success: true });
  }

  if (action === 'amend') {
    const { date, startTime, duration: durationKey, partySize } = body;
    if (!date || !startTime || !durationKey || !partySize) return jsonResponse({ error: 'Missing fields' }, 400);

    if (partySize < service.min_people || partySize > service.max_people) {
      return jsonResponse({ error: `Party size must be between ${service.min_people} and ${service.max_people}` }, 400);
    }

    const bracket = DURATION_BRACKETS[durationKey];
    if (!bracket) return jsonResponse({ error: 'Invalid duration' }, 400);

    const hours = getOpeningHoursFor(date);
    if (!hours) return jsonResponse({ error: "We're closed that day — open Wed–Sun." }, 400);

    const [startHour] = startTime.split(':').map(Number);
    if (startHour < hours.open || startHour + bracket.hours > hours.close) {
      return jsonResponse({ error: 'That time falls outside our opening hours for the length picked.' }, 400);
    }

    const endTime = addHours(startTime, bracket.hours);
    const allocation = await tryAllocate(env.DB, date, startTime, endTime, booking.service_key, partySize, booking.id);
    if (!allocation) return jsonResponse({ error: 'Sorry, no availability for that — please try another time.' }, 409);

    const priceTotal = Math.round(bracket.pricePerPerson * partySize * 100) / 100;

    await env.DB.prepare(
      `UPDATE bookings SET date = ?, start_time = ?, end_time = ?, duration_hours = ?,
         party_size = ?, tables_small = ?, tables_large = ?, price_pp = ?, price_total = ?
       WHERE id = ?`
    ).bind(date, startTime, endTime, bracket.hours, partySize, allocation.small, allocation.large, bracket.pricePerPerson, priceTotal, booking.id).run();

    const updated = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(booking.id).first();
    try { await sendAmendedEmail(env, { ...updated, service_name: service.name }); } catch (e) {}
    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'Unknown action' }, 400);
}
