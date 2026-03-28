/**
 * get-approved-events.js
 * Returns all approved community events from Netlify Blobs.
 * Public endpoint — no authentication required.
 *
 * GET /.netlify/functions/get-approved-events
 * Returns: { events: Event[] }  (sorted by startDate ascending)
 */

import { getStore } from '@netlify/blobs';

function getConfiguredStore(name) {
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT;
  if (ctx) {
    try {
      const parsed = JSON.parse(Buffer.from(ctx, 'base64').toString('utf8'));
      const siteID = parsed.siteID || parsed.site_id;
      const token  = parsed.token;
      const url    = parsed.url || parsed.edgeURL;
      if (siteID && token) {
        const opts = { name, siteID, token };
        if (url) opts.url = url;
        return getStore(opts);
      }
    } catch { /* fall through */ }
  }
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}

export const handler = async () => {
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
    console.error('get-approved-events error:', err);
    return { statusCode: 200, headers, body: JSON.stringify({ events: [] }) };
  }
};
