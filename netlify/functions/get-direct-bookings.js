/**
 * get-direct-bookings.js
 * Returns all direct booking records (all statuses) for the admin panel.
 * Password protected — never called from the public guest site.
 *
 * POST /.netlify/functions/get-direct-bookings
 * Body: { password }
 * Returns: { bookings: [...] }
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
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  if (!safeEqual(body.password || '', adminPassword)) {
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const store = getStore('bluebear-bookings');
    const raw = await store.get('all');
    const bookings = raw ? JSON.parse(raw) : [];

    // Sort newest first
    bookings.sort((a, b) => b.submittedAt > a.submittedAt ? 1 : -1);

    return { statusCode: 200, headers, body: JSON.stringify({ bookings }) };
  } catch (err) {
    console.error('get-direct-bookings error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load bookings' }) };
  }
};
