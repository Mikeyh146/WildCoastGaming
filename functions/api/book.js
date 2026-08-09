import { DURATION_BRACKETS, addHours, tryAllocate, getOpeningHoursFor, generateReference, generateRandomHex, jsonResponse, sendConfirmationEmail } from '../_shared.js';

// POST /api/book
// Body: { service, date, startTime, duration, partySize, pointsTotal, gameSystem, name, email, phone }
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid request body' }, 400); }

  const { service: serviceKey, date, startTime, duration: durationKey, partySize, pointsTotal, gameSystem, name, email, phone } = body;

  if (!serviceKey || !date || !startTime || !durationKey || !partySize || !name || !email) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const bracket = DURATION_BRACKETS[durationKey];
  if (!bracket) return jsonResponse({ error: 'Invalid duration' }, 400);

  const service = await env.DB.prepare('SELECT * FROM services WHERE key = ?').bind(serviceKey).first();
  if (!service) return jsonResponse({ error: 'Unknown service' }, 404);

  if (partySize < service.min_people || partySize > service.max_people) {
    return jsonResponse({ error: `Party size must be between ${service.min_people} and ${service.max_people}` }, 400);
  }
  if (service.needs_points && !pointsTotal) {
    return jsonResponse({ error: 'Points total is required for Warhammer bookings' }, 400);
  }

  const hours = getOpeningHoursFor(date);
  if (!hours) return jsonResponse({ error: "We're closed that day — please pick Wed–Sun." }, 400);

  const [startHour] = startTime.split(':').map(Number);
  if (startHour < hours.open || startHour + bracket.hours > hours.close) {
    return jsonResponse({ error: 'That time falls outside our opening hours for the length you picked.' }, 400);
  }

  const endTime = addHours(startTime, bracket.hours);

  const allocation = await tryAllocate(env.DB, date, startTime, endTime, serviceKey, partySize);
  if (!allocation) {
    return jsonResponse({ error: 'Sorry, that slot just filled up. Please pick another time.' }, 409);
  }

  const priceTotal = Math.round(bracket.pricePerPerson * partySize * 100) / 100;
  const reference = generateReference();
  const manageToken = generateRandomHex(8);

  await env.DB
    .prepare(
      `INSERT INTO bookings
       (reference, manage_token, service_key, table_size, tables_small, tables_large, date, start_time, duration_hours, end_time,
        party_size, points_total, game_system, customer_name, customer_email, customer_phone,
        price_pp, price_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      reference, manageToken, serviceKey, allocation.large > 0 && allocation.small === 0 ? 'large' : 'small',
      allocation.small, allocation.large, date, startTime, bracket.hours, endTime,
      partySize, pointsTotal || null, gameSystem || null, name, email, phone || null,
      bracket.pricePerPerson, priceTotal
    )
    .run();

  const bookingForEmail = {
    reference, manage_token: manageToken, service_name: service.name, date, start_time: startTime, end_time: endTime,
    party_size: partySize, points_total: pointsTotal, game_system: gameSystem,
    customer_name: name, customer_email: email, price_total: priceTotal,
  };

  try {
    await sendConfirmationEmail(env, bookingForEmail);
  } catch (e) { /* booking already saved — email failure isn't fatal */ }

  return jsonResponse({
    reference, manageToken, date, startTime, endTime, partySize, priceTotal, serviceName: service.name,
    tablesUsed: allocation,
  });
}
