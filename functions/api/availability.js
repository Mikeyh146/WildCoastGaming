import { DURATION_BRACKETS, addHours, tryAllocate, getOpeningHoursFor, jsonResponse } from '../_shared.js';

// GET /api/availability?service=dnd&date=2026-08-20&duration=3.5&partySize=8
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const serviceKey = url.searchParams.get('service');
  const date = url.searchParams.get('date');
  const durationKey = url.searchParams.get('duration');
  const partySize = parseInt(url.searchParams.get('partySize') || '1', 10);

  if (!serviceKey || !date || !durationKey) {
    return jsonResponse({ error: 'Missing service, date, or duration' }, 400);
  }

  const bracket = DURATION_BRACKETS[durationKey];
  if (!bracket) return jsonResponse({ error: 'Invalid duration' }, 400);

  const service = await env.DB.prepare('SELECT * FROM services WHERE key = ?').bind(serviceKey).first();
  if (!service) return jsonResponse({ error: 'Unknown service' }, 404);

  const hours = getOpeningHoursFor(date);
  if (!hours) {
    return jsonResponse({
      service: { key: service.key, name: service.name, minPeople: service.min_people, maxPeople: service.max_people, needsPoints: !!service.needs_points },
      bracket: { hours: bracket.hours, label: bracket.label, pricePerPerson: bracket.pricePerPerson },
      slots: [],
      closed: true,
    });
  }

  const slots = [];
  for (let hour = hours.open; hour < hours.close; hour++) {
    // Skip any start time that would run past closing.
    if (hour + bracket.hours > hours.close) continue;

    const startTime = `${String(hour).padStart(2, '0')}:00`;
    const endTime = addHours(startTime, bracket.hours);

    const allocation = await tryAllocate(env.DB, date, startTime, endTime, serviceKey, partySize);
    if (allocation) {
      slots.push({ startTime, endTime, allocation });
    }
  }

  return jsonResponse({
    service: { key: service.key, name: service.name, minPeople: service.min_people, maxPeople: service.max_people, needsPoints: !!service.needs_points },
    bracket: { hours: bracket.hours, label: bracket.label, pricePerPerson: bracket.pricePerPerson },
    slots,
  });
}
