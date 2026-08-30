/**
 * send-weekly-digest.js
 * SCHEDULED ONLY — runs every Monday at 9 AM UTC (see netlify.toml).
 *
 * Netlify blocks HTTP invocation of scheduled functions at the edge (empty
 * 403), so this cannot be triggered manually. For manual/admin triggering
 * use send-digest-now.js, which shares the same logic via lib/digest.js.
 *
 * Requires env vars: CONVERTKIT_API_KEY
 */

import { connectBlobs, runDigest } from './lib/digest.js';

export const handler = async (event) => {
  connectBlobs(event);

  try {
    const result = await runDigest({ draft: false });

    if (!result.ok) {
      console.error('send-weekly-digest:', result.error || result.message);
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    console.log('Weekly digest sent. Broadcast ID:', result.broadcastId);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    console.error('send-weekly-digest error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
