/**
 * get-approved-businesses.js
 * Returns all approved Green Book business listings from Netlify Blobs.
 * Public endpoint — no authentication required.
 *
 * GET /.netlify/functions/get-approved-businesses
 * Returns: { businesses: BusinessCard[] }
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
    const store = getConfiguredStore('green-book-approved');
    const { blobs } = await store.list();

    const businesses = await Promise.all(
      blobs.map(async ({ key }) => {
        const raw = await store.get(key);
        try { return JSON.parse(raw); } catch { return null; }
      })
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ businesses: businesses.filter(Boolean) }),
    };
  } catch (err) {
    // Do NOT return an empty list here — a blob-store failure would look
    // identical to "no listings yet" and silently blank the Green Book.
    console.error('get-approved-businesses error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Could not load listings', detail: String(err?.message || err) }),
    };
  }
};
