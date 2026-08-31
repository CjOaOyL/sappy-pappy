/**
 * send-digest-now.js
 * Admin-triggered weekly digest — the manually invocable counterpart to the
 * scheduled send-weekly-digest.js. Both share lib/digest.js.
 *
 * This function deliberately has NO schedule in netlify.toml: Netlify rejects
 * HTTP requests to scheduled functions at the edge with an empty 403.
 *
 * POST /.netlify/functions/send-digest-now
 * Body: { password, draft?, previewTo? }
 *   draft:true sends one preview to previewTo instead of mailing the list
 *
 * Requires env vars: CONVERTKIT_API_KEY, ADMIN_PASSWORD
 */

import { connectBlobs, runDigest } from './lib/digest.js';

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const handler = async (event) => {
  connectBlobs(event);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
  }
  if (!safeEqual(body.password || '', adminPassword)) {
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const result = await runDigest({
      draft:     body.draft === true,
      previewTo: typeof body.previewTo === 'string' ? body.previewTo.trim() : '',
    });
    if (!result.ok) {
      console.error('send-digest-now:', result.error || result.message);
      return { statusCode: 500, headers, body: JSON.stringify(result) };
    }
    console.log(`Digest ${result.draft ? 'drafted' : 'sent'}. Broadcast ID:`, result.broadcastId);
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (err) {
    console.error('send-digest-now error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
