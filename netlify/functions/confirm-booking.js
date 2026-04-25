/**
 * confirm-booking.js
 * Approves or denies a direct booking or a bundle booking.
 *
 * POST /.netlify/functions/confirm-booking
 * Body (single): { password, bookingId, property: "bluebear"|"hikercabin", action: "confirm"|"deny" }
 * Body (bundle):  { password, bundleId, action: "confirm"|"deny" }
 *
 * When bundleId is provided, all bookings with that bundleId across both stores are updated.
 */

import { getStore } from '@netlify/blobs';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function loadBookings(storeName) {
  const store = getStore(storeName);
  const raw = await store.get('all');
  return raw ? JSON.parse(raw) : [];
}

async function saveBookings(storeName, bookings) {
  const store = getStore(storeName);
  await store.set('all', JSON.stringify(bookings));
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

  const { action } = body;
  if (!['confirm', 'deny'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
  }

  const newStatus   = action === 'confirm' ? 'confirmed' : 'denied';
  const reviewedAt  = new Date().toISOString();

  try {
    // ── BUNDLE: confirm/deny both properties ───────────────────────────────
    if (body.bundleId) {
      const [bbBookings, hcBookings] = await Promise.all([
        loadBookings('bluebear-bookings'),
        loadBookings('hikercabin-bookings'),
      ]);

      let updatedCount = 0;
      const updatedBookings = [];

      for (const b of bbBookings) {
        if (b.bundleId === body.bundleId) { b.status = newStatus; b.reviewedAt = reviewedAt; updatedCount++; updatedBookings.push(b); }
      }
      for (const b of hcBookings) {
        if (b.bundleId === body.bundleId) { b.status = newStatus; b.reviewedAt = reviewedAt; updatedCount++; updatedBookings.push(b); }
      }

      if (updatedCount === 0) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Bundle not found' }) };
      }

      await Promise.all([
        saveBookings('bluebear-bookings',   bbBookings),
        saveBookings('hikercabin-bookings', hcBookings),
      ]);

      console.log(`Bundle ${body.bundleId} ${newStatus} (${updatedCount} bookings):`, updatedBookings.map(b => b.name).join(', '));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, bundleId: body.bundleId, status: newStatus, updatedCount }) };
    }

    // ── SINGLE BOOKING ─────────────────────────────────────────────────────
    const { bookingId } = body;
    if (!bookingId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'bookingId or bundleId required' }) };
    }

    // Determine which store to search
    const prop = body.property ||
      (bookingId.startsWith('HC-') ? 'hikercabin' : 'bluebear');
    const storeName = prop === 'hikercabin' ? 'hikercabin-bookings' : 'bluebear-bookings';

    const bookings = await loadBookings(storeName);
    const idx = bookings.findIndex(b => b.id === bookingId);
    if (idx === -1) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
    }

    bookings[idx].status     = newStatus;
    bookings[idx].reviewedAt = reviewedAt;

    await saveBookings(storeName, bookings);

    const booking = bookings[idx];
    console.log(`Booking ${bookingId} ${newStatus}:`, booking.name, booking.checkIn, '→', booking.checkOut);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, booking }) };
  } catch (err) {
    console.error('confirm-booking error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update booking' }) };
  }
};
