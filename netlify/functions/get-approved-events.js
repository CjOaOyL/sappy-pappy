/**
 * get-approved-events.js
 * Returns all approved community events from Netlify Blobs.
 * Public endpoint — no authentication required.
 *
 * GET /.netlify/functions/get-approved-events
 * Returns: { events: Event[] }  (sorted by startDate ascending)
 */

import { connectBlobs, getConfiguredStore } from './lib/blobs.js';


export const handler = async (event) => {
  connectBlobs(event);
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  try {
    const store = getConfiguredStore('green-book-events-approved');
    const { blobs } = await store.list();

    const events = await Promise.all(
      blobs.map(async ({ key }) => {
        const raw = await store.get(key);
        try { return JSON.parse(raw); } catch { return null; }
      })
    );

    // Strip organizer email before sending to client, sort by startDate
    const safe = events
      .filter(Boolean)
      .map(({ organizerEmail: _oe, ...rest }) => rest)
      .sort((a, b) => {
        const da = new Date(a.startDate + (a.startTime ? 'T' + a.startTime : 'T00:00'));
        const db = new Date(b.startDate + (b.startTime ? 'T' + b.startTime : 'T00:00'));
        return da - db;
      });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ events: safe }),
    };
  } catch (err) {
    // Do NOT return an empty list here — see get-approved-businesses.js.
    console.error('get-approved-events error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not load events', detail: String(err?.message || err) }),
    };
  }
};
