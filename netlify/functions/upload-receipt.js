/**
 * upload-receipt.js
 * Password-gated receipt upload.
 *
 * POST /.netlify/functions/upload-receipt
 * Body: { password, data: "<base64>", contentType: "image/jpeg|image/png|image/webp" }
 * Returns: { ok: true, key, url }
 *
 * Files are stored in the 'finance-receipts' blob store under unguessable
 * random keys, served back via get-receipt.js.
 */

import { getConfiguredStore, checkAuth, connectBlobs} from './lib/finance.js';
import { randomUUID } from 'crypto';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED   = ['image/jpeg', 'image/png', 'image/webp'];
const EXT       = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

export const handler = async (event) => {
  connectBlobs(event);
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  const { data, contentType } = body;
  if (!data || typeof data !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing data' }) };
  }
  if (!ALLOWED.includes(contentType)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only JPEG, PNG, WebP allowed' }) };
  }

  let buf;
  try { buf = Buffer.from(data, 'base64'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid base64' }) }; }
  if (buf.byteLength > MAX_BYTES) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Receipt too large (5 MB max)' }) };
  }

  const key = 'rcpt-' + randomUUID().replace(/-/g, '') + (EXT[contentType] || '.jpg');

  try {
    const store = getConfiguredStore('finance-receipts');
    await store.set(key, buf, { metadata: { contentType } });
    const siteUrl = process.env.URL || 'https://sappy-pappy.com';
    return {
      statusCode: 200, headers,
      body: JSON.stringify({ ok: true, key, url: `${siteUrl}/.netlify/functions/get-receipt?k=${encodeURIComponent(key)}` }),
    };
  } catch (err) {
    console.error('upload-receipt error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Save failed' }) };
  }
};
