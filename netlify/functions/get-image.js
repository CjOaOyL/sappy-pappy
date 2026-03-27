/**
 * get-image.js
 * Serves uploaded images from Netlify Blobs.
 *
 * GET /.netlify/functions/get-image?k=<key>
 * Returns the image binary with proper Content-Type and cache headers.
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

export const handler = async (event) => {
  const key = event.queryStringParameters?.k;

  if (!key) {
    return { statusCode: 400, body: 'Missing image key' };
  }

  // Only allow keys that match our format (prevents path traversal)
  if (!/^img-[a-z0-9]+\.(jpg|png|webp|gif)$/i.test(key)) {
    return { statusCode: 400, body: 'Invalid image key' };
  }

  try {
    const store = getConfiguredStore('green-book-images');
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });

    if (!result || !result.data) {
      return { statusCode: 404, body: 'Image not found' };
    }

    const contentType = result.metadata?.contentType || 'image/jpeg';

    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      },
      isBase64Encoded: true,
      body: Buffer.from(result.data).toString('base64'),
    };
  } catch (err) {
    console.error('get-image error:', err);
    return { statusCode: 500, body: 'Failed to load image' };
  }
};
