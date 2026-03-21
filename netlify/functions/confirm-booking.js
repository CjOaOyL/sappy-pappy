/**
 * confirm-booking.js
 * Approves or denies a pending direct booking.
 * Called from the admin panel in admin.html.
 *
 * POST /.netlify/functions/confirm-booking
 * Body: { password, bookingId, action: "confirm" | "deny" }
 * Returns: { ok: true, booking } or { error }
 *
 * On confirm: sets status = "confirmed" → will appear in iCal feed
 * On deny:    sets status = "denied"    → removed from iCal feed
 */

import { getStore } from '@netlify/blobs';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'same-origin',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Admin not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!safeEqual(body.password || '', adminPassword)) {
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const { bookingId, action } = body;
  if (!bookingId || !['confirm', 'deny'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  try {
    const store = getStore('bluebear-bookings');
    const raw = await store.get('all');
    const bookings = raw ? JSON.parse(raw) : [];

    const idx = bookings.findIndex(b => b.id === bookingId);
    if (idx === -1) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
    }

    const booking = bookings[idx];
    booking.status = action === 'confirm' ? 'confirmed' : 'denied';
    booking.reviewedAt = new Date().toISOString();
    bookings[idx] = booking;

    await store.set('all', JSON.stringify(bookings));

    // Log for Netlify function logs
    console.log(`Booking ${bookingId} ${booking.status}:`, booking.name, booking.checkIn, '→', booking.checkOut);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, booking }),
    };
  } catch (err) {
    console.error('confirm-booking error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update booking' }) };
  }
};
