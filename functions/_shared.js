// Shared constants + helpers for the booking API.
// Files/folders starting with "_" are not routed by Cloudflare Pages
// Functions, so this is safe to import from the actual route handlers.

export const CAPACITY = {
  large: 6,   // 6ft x 4ft tables — Warhammer, D&D
  small: 7,   // 60" x 38" tables — TCG, Casual, D&D
};

// Shop opening hours — adjust these to match reality.
export const OPEN_HOUR = 10;   // 10:00
export const CLOSE_HOUR = 22;  // 22:00

// Duration brackets: value is the block length reserved (hours),
// price is per person for that whole booking.
export const DURATION_BRACKETS = {
  '3.5': { hours: 3.5, label: 'Up to 3.5 hours', pricePerPerson: 4 },
  '7.5': { hours: 7.5, label: '5–7.5 hours',      pricePerPerson: 6.5 },
  '10':  { hours: 10,  label: '7.5–10 hours',     pricePerPerson: 9 },
  '12':  { hours: 12,  label: '10–12 hours',      pricePerPerson: 12 },
};

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

// Counts how many bookings of a given table_size overlap a candidate
// time window on a given date (excludes cancelled bookings).
export async function countOverlapping(db, date, tableSize, startTime, endTime) {
  const { results } = await db
    .prepare(
      `SELECT start_time, end_time FROM bookings
       WHERE date = ? AND table_size = ? AND status != 'cancelled'`
    )
    .bind(date, tableSize)
    .all();

  return results.filter((b) => timesOverlap(startTime, endTime, b.start_time, b.end_time)).length;
}

export async function sendConfirmationEmail(env, booking) {
  if (!env.BREVO_API_KEY) return; // no key configured — skip silently, booking still succeeds

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
          <li><strong>Table:</strong> ${booking.service_name}</li>
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
    headers: {
      'Content-Type': 'application/json',
      'api-key': env.BREVO_API_KEY,
    },
    body: JSON.stringify(body),
  });
}
