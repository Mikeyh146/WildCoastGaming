import { CAPACITY, DURATION_BRACKETS, addHours, countOverlapping, generateReference, jsonResponse, sendConfirmationEmail } from '../_shared.js';

// POST /api/book
// Body: { service, date, startTime, duration, partySize, pointsTotal, name, email, phone }
export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  const { service: serviceKey, date, startTime, duration: durationKey, partySize, pointsTotal, name, email, phone } = body;

  if (!serviceKey || !date || !startTime || !durationKey || !partySize || !name || !email) {
    return jsonResponse({ error: 'Missing required fields' }, 400);
  }

  const bracket = DURATION_BRACKETS[durationKey];
  if (!bracket) return jsonResponse({ error: 'Invalid duration' }, 400);

  const service = await env.DB
    .prepare('SELECT * FROM services WHERE key = ?')
    .bind(serviceKey)
    .first();
  if (!service) return jsonResponse({ error: 'Unknown service' }, 404);

  if (partySize < service.min_people || partySize > service.max_people) {
    return jsonResponse({ error: `Party size must be between ${service.min_people} and ${service.max_people}` }, 400);
  }
  if (service.needs_points && !pointsTotal) {
    return jsonResponse({ error: 'Points total is required for Warhammer bookings' }, 400);
  }

  const endTime = addHours(startTime, bracket.hours);
  const sizesToTry = service.allowed_sizes === 'both' ? ['small', 'large'] : [service.allowed_sizes];

  // Re-check availability at booking time (guards against a slot filling
  // between the customer loading the page and hitting submit).
  let chosenSize = null;
  for (const size of sizesToTry) {
    const used = await countOverlapping(env.DB, date, size, startTime, endTime);
    if (used < CAPACITY[size]) {
      chosenSize = size;
      break;
    }
  }
  if (!chosenSize) {
    return jsonResponse({ error: 'Sorry, that slot just filled up. Please pick another time.' }, 409);
  }

  const priceTotal = Math.round(bracket.pricePerPerson * partySize * 100) / 100;
  const reference = generateReference();

  await env.DB
    .prepare(
      `INSERT INTO bookings
       (reference, service_key, table_size, date, start_time, duration_hours, end_time,
        party_size, points_total, customer_name, customer_email, customer_phone,
        price_pp, price_total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      reference, serviceKey, chosenSize, date, startTime, bracket.hours, endTime,
      partySize, pointsTotal || null, name, email, phone || null,
      bracket.pricePerPerson, priceTotal
    )
    .run();

  const bookingForEmail = {
    reference, service_name: service.name, date, start_time: startTime, end_time: endTime,
    party_size: partySize, points_total: pointsTotal, customer_name: name, customer_email: email,
    price_total: priceTotal,
  };

  try {
    await sendConfirmationEmail(env, bookingForEmail);
  } catch (e) {
    // Booking already saved — don't fail the request just because the email had trouble.
  }

  return jsonResponse({
    reference,
    date,
    startTime,
    endTime,
    partySize,
    priceTotal,
    serviceName: service.name,
  });
}
