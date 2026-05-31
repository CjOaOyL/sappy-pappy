/**
 * get-receipt.js
 * Serves a receipt by its unguessable key. Public (security via key entropy).
 * GET /.netlify/functions/get-receipt?k=rcpt-<hex>.<ext>
 */

import { getConfiguredStore, connectBlobs} from './lib/finance.js';

export const handler = async (event) => {
  connectBlobs(event);
  const key = event.queryStringParameters?.k;
  if (!key) return { statusCode: 400, body: 'Missing key' };
  if (!/^rcpt-[a-f0-9]+\.(jpg|png|webp)$/i.test(key)) {
    return { statusCode: 400, body: 'Invalid key' };
  }
  try {
    const store = getConfiguredStore('finance-receipts');
    const result = await store.getWithMetadata(key, { type: 'arrayBuffer' });
    if (!result || !result.data) return { statusCode: 404, body: 'Not found' };
    return {
      statusCode: 200,
      headers: {
        'Content-Type': result.metadata?.contentType || 'image/jpeg',
        'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
      isBase64Encoded: true,
      body: Buffer.from(result.data).toString('base64'),
    };
  } catch (err) {
    console.error('get-receipt error:', err);
    return { statusCode: 500, body: 'Failed' };
  }
};
