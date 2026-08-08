// Shared constants + helpers for the booking API.
// Files/folders starting with "_" are not routed by Cloudflare Pages
// Functions, so this is safe to import from the actual route handlers.

export const CAPACITY = {
  large: 6,   // 6ft x 4ft tables — Warhammer, D&D
  small: 7,   // 60" x 38" tables — TCG, Casual, D&D
};

// How many people one table seats for RPG purposes. RPG bookings scale
// across multiple tables once the party outgrows this. Adjust this one
// number if the real seating capacity is different.
export const PARTY_PER_TABLE = 6;

// Opening hours by day of week (JS Date.getDay(): 0=Sun...6=Sat).
// null means closed that day.
export const OPENING_HOURS = {
  0: { open: 10, close: 22 }, // Sunday
  1: null,                    // Monday — closed
  2: null,                    // Tuesday — closed
  3: { open: 10, close: 22 }, // Wednesday
  4: { open: 10, close: 22 }, // Thursday
  5: { open: 10, close: 22 }, // Friday
  6: { open: 10, close: 22 }, // Saturday
};

export function getOpeningHoursFor(dateStr) {
  // dateStr is 'YYYY-MM-DD'. Parse as local date, not UTC-shifted.
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return OPENING_HOURS[day]; // object {open, close} or null if closed
}

export const DURATION_BRACKETS = {
  '3.5': { hours: 3.5, label: 'Up to 3.5 hours', pricePerPerson: 4 },
  '7.5': { hours: 7.5, label: '5–7.5 hours',      pricePerPerson: 6.5 },
  '10':  { hours: 10,  label: '7.5–10 hours',     pricePerPerson: 9 },
  '12':  { hours: 12,  label: '10–12 hours',      pricePerPerson: 12 },
};

// Sub-game-system options per service. 'Other' is always the fallback.
export const GAME_SYSTEMS = {
  warhammer: ['Warhammer 40,000', 'Age of Sigmar', 'Other'],
  tcg: ['Magic: The Gathering', 'Pokémon', 'Yu-Gi-Oh!', 'One Piece Card Game', 'Other'],
  dnd: ['Dungeons & Dragons', 'Pathfinder', 'Call of Cthulhu', 'Other'],
};

// Which table-size pools a service can draw from, in preference order.
export const SIZE_PREFERENCE = {
  warhammer: ['large'],
  tcg: ['small'],
  casual: ['small'],
  dnd: ['small', 'large'],
};

export function tablesRequired(serviceKey, partySize) {
  if (serviceKey === 'dnd') {
    return Math.ceil(partySize / PARTY_PER_TABLE);
  }
  return 1;
}

export function addHours(startTime, hours) {
  const [h, m] = startTime.split(':').map(Number);
  const totalMinutes = h * 60 + m + Math.round(hours * 60);
  const endH = Math.floor(totalMinutes / 60) % 24;
  const endM = totalMinutes % 60;
  return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
}

export function timesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

export function generateReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = 'WCG-';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Sums how many tables of a given size are already committed during an
// overlapping time window on a given date (excludes cancelled bookings).
export async function tablesInUse(db, date, size, startTime, endTime) {
  const column = size === 'small' ? 'tables_small' : 'tables_large';
  const { results } = await db
    .prepare(
      `SELECT start_time, end_time, ${column} AS count FROM bookings
       WHERE date = ? AND status != 'cancelled' AND ${column} > 0`
    )
    .bind(date)
    .all();

  return results
    .filter((b) => timesOverlap(startTime, endTime, b.start_time, b.end_time))
    .reduce((sum, b) => sum + b.count, 0);
}

// Tries to allocate enough tables for a booking, preferring the service's
// preferred size order, spilling into the next size if needed (used by RPG).
// Returns { small, large } counts on success, or null if it doesn't fit.
export async function tryAllocate(db, date, startTime, endTime, serviceKey, partySize) {
  const needed = tablesRequired(serviceKey, partySize);
  const order = SIZE_PREFERENCE[serviceKey];

  const available = {};
  for (const size of order) {
    const used = await tablesInUse(db, date, size, startTime, endTime);
    available[size] = CAPACITY[size] - used;
  }

  let remaining = needed;
  const allocation = { small: 0, large: 0 };
  for (const size of order) {
    if (remaining <= 0) break;
    const take = Math.min(available[size], remaining);
    if (take > 0) {
      allocation[size] += take;
      remaining -= take;
    }
  }

  if (remaining > 0) return null; // couldn't fit
  return allocation;
}

export async function sendConfirmationEmail(env, booking) {
  if (!env.BREVO_API_KEY) return;

  const body = {
    sender: { name: 'Wild Coast Gaming', email: 'info@wildcoastgaming.co.uk' },
    to: [{ email: booking.customer_email, name: booking.customer_name }],
    subject: `Your Wild Coast Gaming booking — ${booking.reference}`,
    htmlContent: `
      <div style="font-family:sans-serif;color:#10263D;">
        <h2>Booking confirmed</h2>
        <p>Hi ${booking.customer_name},</p>
        <p>Your table is booked. Show this reference at the shop, or just give your name.</p>
        <p style="font-size:20px;font-weight:bold;letter-spacing:2px;">${booking.reference}</p>
        <ul>
          <li><strong>Table:</strong> ${booking.service_name}${booking.game_system ? ` — ${booking.game_system}` : ''}</li>
          <li><strong>Date:</strong> ${booking.date}</li>
          <li><strong>Time:</strong> ${booking.start_time}–${booking.end_time}</li>
          <li><strong>Party size:</strong> ${booking.party_size}</li>
          ${booking.points_total ? `<li><strong>Points total:</strong> ${booking.points_total}</li>` : ''}
          <li><strong>Total to pay in-shop:</strong> £${booking.price_total.toFixed(2)}</li>
        </ul>
        <p>See you at Wild Coast Gaming, Haverfordwest!</p>
      </div>
    `,
  };

  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify(body),
  });
}

export function isAdminAuthed(env, password) {
  return !!env.ADMIN_PASSWORD && password === env.ADMIN_PASSWORD;
}
