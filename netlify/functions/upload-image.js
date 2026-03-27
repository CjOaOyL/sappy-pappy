/**
 * upload-image.js
 * Accepts a base64-encoded image, stores it in Netlify Blobs,
 * and returns a URL that can be used as an imageUrl or ownerPhoto.
 *
 * POST /.netlify/functions/upload-image
 * Body: { data: "<base64 string>", contentType: "image/jpeg|image/png|image/webp" }
 * Returns: { ok: true, url: "/.netlify/functions/get-image?k=<key>" }
 *
 * Max upload size: 3 MB (uncompressed). Client should resize before uploading.
 */

import { getStore } from '@netlify/blobs';

const MAX_BYTES   = 3 * 1024 * 1024; // 3 MB decoded
const ALLOWED     = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const EXTENSIONS  = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

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

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { data, contentType } = body;

  if (!data || typeof data !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Image data is required.' }) };
  }
  if (!ALLOWED.includes(contentType)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Only JPEG, PNG, WebP, and GIF images are allowed.' }) };
  }

  // Decode and size-check
  let buffer;
  try {
    buffer = Buffer.from(data, 'base64');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid image data.' }) };
  }

  if (buffer.byteLength > MAX_BYTES) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Image is too large. Please use a photo under 3 MB.' }) };
  }

  const key = 'img-' + uid() + (EXTENSIONS[contentType] || '.jpg');

  try {
    const store = getConfiguredStore('green-book-images');
    await store.set(key, buffer, { metadata: { contentType } });

    const siteUrl = process.env.URL || 'https://sappy-pappy.com';
    const url     = `${siteUrl}/.netlify/functions/get-image?k=${encodeURIComponent(key)}`;

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, url, key }) };
  } catch (err) {
    console.error('upload-image error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save image. Please try again.' }) };
  }
};
