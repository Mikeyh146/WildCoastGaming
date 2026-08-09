import { jsonResponse, validateSession, DURATION_BRACKETS, addHours, tryAllocate, getOpeningHoursFor, sendAmendedEmail } from '../_shared.js';

// POST /api/admin-amend
// Body: { token, id, date, startTime, duration, partySize }
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request' }, 400); }
  const { token, id, date, startTime, duration: durationKey, partySize } = body;

  const session = await validateSession(env.DB, token);
  if (!session) return jsonResponse({ error: 'Unauthorized' }, 401);
  if (!id || !date || !startTime || !durationKey || !partySize) {
    return jsonResponse({ error: 'Missing fields' }, 400);
  }

  const existing = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
  if (!existing) return jsonResponse({ error: 'Booking not found' }, 404);

  const service = await env.DB.prepare('SELECT * FROM services WHERE key = ?').bind(existing.service_key).first();

  if (partySize < service.min_people || partySize > service.max_people) {
    return jsonResponse({ error: `Party size must be between ${service.min_people} and ${service.max_people}` }, 400);
  }

  const bracket = DURATION_BRACKETS[durationKey];
  if (!bracket) return jsonResponse({ error: 'Invalid duration' }, 400);

  const hours = getOpeningHoursFor(date);
  if (!hours) return jsonResponse({ error: "That day we're closed (Wed–Sun only)." }, 400);

  const [startHour] = startTime.split(':').map(Number);
  if (startHour < hours.open || startHour + bracket.hours > hours.close) {
    return jsonResponse({ error: 'That time falls outside opening hours for the length picked.' }, 400);
  }

  const endTime = addHours(startTime, bracket.hours);

  // Exclude this booking's own current tables from the availability check.
  const allocation = await tryAllocate(env.DB, date, startTime, endTime, existing.service_key, partySize, id);
  if (!allocation) return jsonResponse({ error: 'No availability for the new time/size — try something else.' }, 409);

  const priceTotal = Math.round(bracket.pricePerPerson * partySize * 100) / 100;

  await env.DB.prepare(
    `UPDATE bookings SET date = ?, start_time = ?, end_time = ?, duration_hours = ?,
       party_size = ?, tables_small = ?, tables_large = ?, price_pp = ?, price_total = ?
     WHERE id = ?`
  ).bind(date, startTime, endTime, bracket.hours, partySize, allocation.small, allocation.large, bracket.pricePerPerson, priceTotal, id).run();

  const updated = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();

  try {
    await sendAmendedEmail(env, { ...updated, service_name: service.name });
  } catch (e) { /* booking already saved — email failure isn't fatal */ }

  return jsonResponse({ success: true });
}
