import { CAPACITY, OPEN_HOUR, CLOSE_HOUR, DURATION_BRACKETS, addHours, countOverlapping, jsonResponse } from '../_shared.js';

// GET /api/availability?service=warhammer&date=2026-08-20&duration=3.5
// Returns available start times (on the hour) for that service/date/duration.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const serviceKey = url.searchParams.get('service');
  const date = url.searchParams.get('date');
  const durationKey = url.searchParams.get('duration');

  if (!serviceKey || !date || !durationKey) {
    return jsonResponse({ error: 'Missing service, date, or duration' }, 400);
  }

  const bracket = DURATION_BRACKETS[durationKey];
  if (!bracket) return jsonResponse({ error: 'Invalid duration' }, 400);

  const service = await env.DB
    .prepare('SELECT * FROM services WHERE key = ?')
    .bind(serviceKey)
    .first();
  if (!service) return jsonResponse({ error: 'Unknown service' }, 404);

  // Which table-size pools this service can draw from.
  const sizesToTry = service.allowed_sizes === 'both' ? ['small', 'large'] : [service.allowed_sizes];

  const slots = [];
  for (let hour = OPEN_HOUR; hour < CLOSE_HOUR; hour++) {
    const startTime = `${String(hour).padStart(2, '0')}:00`;
    const endTime = addHours(startTime, bracket.hours);

    // Skip slots that would run past closing.
    const endHour = hour + bracket.hours;
    if (endHour > CLOSE_HOUR + 24) continue; // safety, shouldn't happen

    let availableSize = null;
    for (const size of sizesToTry) {
      const used = await countOverlapping(env.DB, date, size, startTime, endTime);
      if (used < CAPACITY[size]) {
        availableSize = size;
        break;
      }
    }

    if (availableSize) {
      slots.push({ startTime, endTime, tableSize: availableSize });
    }
  }

  return jsonResponse({
    service: { key: service.key, name: service.name, minPeople: service.min_people, maxPeople: service.max_people, needsPoints: !!service.needs_points },
    bracket: { hours: bracket.hours, label: bracket.label, pricePerPerson: bracket.pricePerPerson },
    slots,
  });
}
