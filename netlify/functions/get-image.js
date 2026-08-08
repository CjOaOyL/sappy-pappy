/**
 * get-image.js
 * Serves uploaded images from Netlify Blobs.
 *
 * GET /.netlify/functions/get-image?k=<key>
 * Returns the image binary with proper Content-Type and cache headers.
 */

import { connectBlobs, getConfiguredStore } from './lib/blobs.js';


export const handler = async (event) => {
  connectBlobs(event);
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
