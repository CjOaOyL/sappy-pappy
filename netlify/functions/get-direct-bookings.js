/**
 * get-direct-bookings.js
 * Returns direct booking records for the admin panel.
 * Fetches from both properties and merges, labeling each booking with its property.
 * Bundle bookings (same bundleId) are grouped together.
 *
 * POST /.netlify/functions/get-direct-bookings
 * Body: { password, property?: "bluebear"|"hikercabin"|"both" }
 * Returns: { bookings: [...] }  — sorted newest first, with property labels
 */

import { getStore } from '@netlify/blobs';

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function loadBookings(storeName, propertyLabel) {
  try {
    const store = getStore(storeName);
    const raw = await store.get('all');
    if (!raw) return [];
    return JSON.parse(raw).map(b => ({ ...b, property: b.property || propertyLabel }));
  } catch (err) {
    console.error(`get-direct-bookings load error (${storeName}):`, err.message);
    return [];
  }
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
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!safeEqual(body.password || '', adminPassword)) {
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const prop = body.property || 'both';

  try {
    let bookings = [];

    if (prop === 'bluebear' || prop === 'both') {
      bookings.push(...await loadBookings('bluebear-bookings', 'bluebear'));
    }
    if (prop === 'hikercabin' || prop === 'both') {
      bookings.push(...await loadBookings('hikercabin-bookings', 'hikercabin'));
    }

    // Sort newest first
    bookings.sort((a, b) => (b.submittedAt > a.submittedAt ? 1 : -1));

    return { statusCode: 200, headers, body: JSON.stringify({ bookings }) };
  } catch (err) {
    console.error('get-direct-bookings error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load bookings' }) };
  }
};
