/**
 * newsletter-settings.js
 * Admin endpoint for newsletter configuration.
 * The newsletter itself is delivered via Kit RSS campaign — no broadcast API needed.
 *
 * POST /.netlify/functions/newsletter-settings
 * Body: { password, action }
 *
 * Actions:
 *   'list-approved' — Return approved businesses for the admin picker
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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
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

  // ── LIST APPROVED BUSINESSES ──────────────────────────────────────────────
  if (body.action === 'list-approved') {
    try {
      const approvedStore = getConfiguredStore('green-book-approved');
      const { blobs } = await approvedStore.list();
      const cards = (await Promise.all(
        blobs.map(async ({ key }) => {
          const raw = await approvedStore.get(key).catch(() => null);
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        })
      ))
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          businesses: cards.map(c => ({ id: c.id, name: c.name, category: c.category, icon: c.icon })),
        }),
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
