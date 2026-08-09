// Shared constants + helpers for the booking API.
// Files/folders starting with "_" are not routed by Cloudflare Pages
// Functions, so this is safe to import from the actual route handlers.

export const CAPACITY = { large: 6, small: 7 };
export const PARTY_PER_TABLE = 6;

export const OPENING_HOURS = {
  0: { open: 10, close: 22 }, 1: null, 2: null,
  3: { open: 10, close: 22 }, 4: { open: 10, close: 22 },
  5: { open: 10, close: 22 }, 6: { open: 10, close: 22 },
};

export function getOpeningHoursFor(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return OPENING_HOURS[day];
}

export const DURATION_BRACKETS = {
  '3.5': { hours: 3.5, label: 'Up to 3.5 hours', pricePerPerson: 4 },
  '7.5': { hours: 7.5, label: '5–7.5 hours',      pricePerPerson: 6.5 },
  '10':  { hours: 10,  label: '7.5–10 hours',     pricePerPerson: 9 },
  '12':  { hours: 12,  label: '10–12 hours',      pricePerPerson: 12 },
};

export const GAME_SYSTEMS = {
  warhammer: ['Warhammer 40,000', 'Age of Sigmar', 'Other'],
  tcg: ['Magic: The Gathering', 'Pokémon', 'Yu-Gi-Oh!', 'One Piece Card Game', 'Other'],
  dnd: ['Dungeons & Dragons', 'Pathfinder', 'Call of Cthulhu', 'Other'],
};

export const SIZE_PREFERENCE = {
  warhammer: ['large'], tcg: ['small'], casual: ['small'], dnd: ['small', 'large'],
};

export function tablesRequired(serviceKey, partySize) {
  if (serviceKey === 'dnd') return Math.ceil(partySize / PARTY_PER_TABLE);
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
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'WCG-';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export function generateRandomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

// tablesInUse / tryAllocate both accept an optional excludeBookingId, so an
// amend can re-check availability without counting the booking's own
// existing tables against itself.
export async function tablesInUse(db, date, size, startTime, endTime, excludeBookingId = null) {
  const column = size === 'small' ? 'tables_small' : 'tables_large';
  const { results } = await db
    .prepare(
      `SELECT id, start_time, end_time, ${column} AS count FROM bookings
       WHERE date = ? AND status != 'cancelled' AND ${column} > 0`
    )
    .bind(date)
    .all();

  return results
    .filter((b) => b.id !== excludeBookingId && timesOverlap(startTime, endTime, b.start_time, b.end_time))
    .reduce((sum, b) => sum + b.count, 0);
}

export async function tryAllocate(db, date, startTime, endTime, serviceKey, partySize, excludeBookingId = null) {
  const needed = tablesRequired(serviceKey, partySize);
  const order = SIZE_PREFERENCE[serviceKey];

  const available = {};
  for (const size of order) {
    const used = await tablesInUse(db, date, size, startTime, endTime, excludeBookingId);
    available[size] = CAPACITY[size] - used;
  }

  let remaining = needed;
  const allocation = { small: 0, large: 0 };
  for (const size of order) {
    if (remaining <= 0) break;
    const take = Math.min(available[size], remaining);
    if (take > 0) { allocation[size] += take; remaining -= take; }
  }

  if (remaining > 0) return null;
  return allocation;
}

// ---------- password hashing (staff accounts) ----------

export async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hashBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyPassword(password, salt, hash) {
  return (await hashPassword(password, salt)) === hash;
}

// ---------- sessions ----------

export async function createSession(db, username, role) {
  const token = generateRandomHex(24);
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12 hours
  await db.prepare(`INSERT INTO sessions (token, username, role, expires_at) VALUES (?, ?, ?, ?)`)
    .bind(token, username, role, expires).run();
  return { token, expires };
}

export async function validateSession(db, token) {
  if (!token) return null;
  const row = await db.prepare(`SELECT * FROM sessions WHERE token = ?`).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row; // { token, username, role, expires_at }
}

// ---------- emails ----------

async function sendEmail(env, { to, name, subject, html }) {
  if (!env.BREVO_API_KEY) return;
  await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
    body: JSON.stringify({
      sender: { name: 'Wild Coast Gaming', email: 'info@wildcoastgaming.co.uk' },
      to: [{ email: to, name }],
      subject,
      htmlContent: html,
    }),
  });
}

function manageLink(booking) {
  return `https://www.wildcoastgaming.co.uk/manage.html?ref=${booking.reference}&token=${booking.manage_token}`;
}

export async function sendConfirmationEmail(env, booking) {
  await sendEmail(env, {
    to: booking.customer_email,
    name: booking.customer_name,
    subject: `Your Wild Coast Gaming booking — ${booking.reference}`,
    html: `
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
        <p><a href="${manageLink(booking)}">Cancel or change this booking</a></p>
        <p>See you at Wild Coast Gaming, Haverfordwest!</p>
      </div>
    `,
  });
}

export async function sendCancellationEmail(env, booking) {
  await sendEmail(env, {
    to: booking.customer_email,
    name: booking.customer_name,
    subject: `Booking cancelled — ${booking.reference}`,
    html: `
      <div style="font-family:sans-serif;color:#10263D;">
        <h2>Booking cancelled</h2>
        <p>Hi ${booking.customer_name},</p>
        <p>Your booking <strong>${booking.reference}</strong> for ${booking.date} at ${booking.start_time} has been cancelled.</p>
        <p>Hope to see you another time — you can book again any time at wildcoastgaming.co.uk/book.html.</p>
      </div>
    `,
  });
}

export async function sendAmendedEmail(env, booking) {
  await sendEmail(env, {
    to: booking.customer_email,
    name: booking.customer_name,
    subject: `Booking updated — ${booking.reference}`,
    html: `
      <div style="font-family:sans-serif;color:#10263D;">
        <h2>Your booking has been updated</h2>
        <p>Hi ${booking.customer_name},</p>
        <p>Here are the new details for <strong>${booking.reference}</strong>:</p>
        <ul>
          <li><strong>Table:</strong> ${booking.service_name}${booking.game_system ? ` — ${booking.game_system}` : ''}</li>
          <li><strong>Date:</strong> ${booking.date}</li>
          <li><strong>Time:</strong> ${booking.start_time}–${booking.end_time}</li>
          <li><strong>Party size:</strong> ${booking.party_size}</li>
          <li><strong>Total to pay in-shop:</strong> £${booking.price_total.toFixed(2)}</li>
        </ul>
        <p><a href="${manageLink(booking)}">View, cancel, or change this booking</a></p>
      </div>
    `,
  });
}

// ---------- calendar ----------

export function buildIcs(booking) {
  const dt = (dateStr, timeStr) => `${dateStr.replace(/-/g, '')}T${timeStr.replace(':', '')}00`;
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wild Coast Gaming//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${booking.reference}@wildcoastgaming.co.uk`,
    `DTSTART:${dt(booking.date, booking.start_time)}`,
    `DTEND:${dt(booking.date, booking.end_time)}`,
    `SUMMARY:Wild Coast Gaming — ${booking.service_name}`,
    `DESCRIPTION:Reference ${booking.reference}. Party of ${booking.party_size}. Pay in-shop.`,
    'LOCATION:Wild Coast Gaming, Haverfordwest, Pembrokeshire',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
}
