/**
 * subscribe-existing-owners.js
 * Admin endpoint: subscribe all approved business owners to the Kit newsletter.
 *
 * POST /.netlify/functions/subscribe-existing-owners
 * Body: { password }
 *
 * Requires env vars: ADMIN_PASSWORD, CONVERTKIT_API_KEY, CONVERTKIT_FORM_ID
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

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function subscribeOne(apiKey, formId, email, firstName) {
  const res = await fetch(`https://api.kit.com/v4/forms/${formId}/subscribers`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body:    JSON.stringify({ email_address: email, first_name: firstName || '' }),
  });
  return res.ok;
}

const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!safeEqual(body.password || '', adminPassword)) {
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const apiKey = process.env.CONVERTKIT_API_KEY;
  const formId = process.env.CONVERTKIT_FORM_ID;
  if (!apiKey || !formId) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'CONVERTKIT_API_KEY or CONVERTKIT_FORM_ID not set' }) };
  }

  try {
    const store = getConfiguredStore('green-book-approved');
    const { blobs } = await store.list();

    const cards = (await Promise.all(
      blobs.map(async ({ key }) => {
        const raw = await store.get(key).catch(() => null);
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      })
    )).filter(Boolean);

    // Collect unique valid owner emails
    const seen = new Set();
    const owners = [];
    for (const card of cards) {
      const email = card.ownerData?.email || card.ownerEmail;
      const name  = card.ownerData?.name  || card.ownerName || '';
      if (email && isValidEmail(email) && !seen.has(email.toLowerCase())) {
        seen.add(email.toLowerCase());
        owners.push({ email, name, business: card.name });
      }
    }

    if (owners.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, subscribed: 0, skipped: 0, message: 'No owner emails found.' }) };
    }

    // Subscribe sequentially to avoid hammering Kit rate limits
    let subscribed = 0;
    let failed = 0;
    for (const { email, name } of owners) {
      const ok = await subscribeOne(apiKey, formId, email, name).catch(() => false);
      if (ok) subscribed++; else failed++;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, subscribed, failed, total: owners.length }),
    };

  } catch (err) {
    console.error('subscribe-existing-owners error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
