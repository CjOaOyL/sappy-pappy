/**
 * Shared Netlify Blobs helpers.
 *
 * Two things every blob-backed function needs:
 *   1. connectBlobs(event) at the top of the handler — legacy `export const handler`
 *      functions run in Lambda-compat mode, where the Blobs client has no site
 *      context until connectLambda() is given the raw event.
 *   2. getConfiguredStore(name) — resolves siteID/token from the deploy context,
 *      falling back to env vars, then to auto-detection.
 *
 * Do NOT pass the `url`/`edgeURL` from NETLIFY_BLOBS_CONTEXT into getStore():
 * combining an explicit url with siteID+token breaks store construction.
 */

import { connectLambda, getStore } from '@netlify/blobs';

export function connectBlobs(event) {
  try { connectLambda(event); } catch { /* already connected, or not in Lambda mode */ }
}

export function getConfiguredStore(name) {
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT;
  if (ctx) {
    try {
      const parsed = JSON.parse(Buffer.from(ctx, 'base64').toString('utf8'));
      const siteID = parsed.siteID || parsed.site_id;
      const token  = parsed.token;
      if (siteID && token) return getStore({ name, siteID, token });
    } catch { /* fall through */ }
  }
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  return getStore(name);
}
