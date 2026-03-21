/**
 * get-approved-businesses.js
 * Returns all approved Green Book business listings from Netlify Blobs.
 * Public endpoint — no authentication required.
 *
 * GET /.netlify/functions/get-approved-businesses
 * Returns: { businesses: BusinessCard[] }
 */

import { getStore } from '@netlify/blobs';

export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  };

  try {
    const store = getStore('green-book-approved');
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
    console.error('get-approved-businesses error:', err);
    return { statusCode: 200, headers, body: JSON.stringify({ businesses: [] }) };
  }
};
