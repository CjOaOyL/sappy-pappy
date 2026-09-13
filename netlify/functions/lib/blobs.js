/**
 * Shared Netlify Blobs helpers.
 *
 * Two things every blob-backed function needs:
 *   1. connectBlobs(event) at the top of the handler — legacy `export const handler`
 *      functions run in Lambda-compat mode, where the Blobs client has no site
 *      context until connectLambda() is given the raw event.
 *   2. getConfiguredStore(name, opts) — builds a Store for that context.
 *
 * @netlify/blobs >= 10: if you pass `siteID` + `token` to getStore() it IGNORES
 * the environment context (edgeURL / uncachedEdgeURL) and talks to the public
 * API with that token — which the per-function Blobs token is not valid for
 * (401). So when a context exists we pass only the name and let the client
 * read the context itself. Explicit siteID/token is reserved for the env-var
 * fallback (a personal access token in a local script).
 */

import { connectLambda, getStore, setEnvironmentContext } from '@netlify/blobs';

/**
 * Publish the Blobs context for a legacy (`export const handler`) function.
 *
 * The runtime gives these functions NO NETLIFY_BLOBS_CONTEXT env var; the
 * credentials ride on `event.blobs` as base64 JSON:
 *   { url, url_uncached, token, primary_region }
 * The library's connectLambda() copies only `url` + `token`, which silently
 * loses `url_uncached` — and without it every `consistency: 'strong'` read is
 * impossible (we then degrade to eventual, and read-modify-write goes stale).
 * So we build the full context ourselves and fall back to connectLambda only
 * if the payload is missing or unparseable.
 */
export function connectBlobs(event) {
  try {
    const data = JSON.parse(Buffer.from(event.blobs || '', 'base64').toString('utf8'));
    const headers = event.headers || {};
    if (data && data.url && data.token) {
      setEnvironmentContext({
        siteID: headers['x-nf-site-id'],
        deployID: headers['x-nf-deploy-id'],
        edgeURL: data.url,
        uncachedEdgeURL: data.url_uncached || undefined,
        token: data.token,
        primaryRegion: data.primary_region || undefined,
      });
      return;
    }
  } catch { /* fall through */ }
  try { connectLambda(event); } catch { /* already connected, or not in Lambda mode */ }
}

/**
 * @param {string} name
 * @param {{ consistency?: 'eventual' | 'strong' }} [opts]
 *   Pass { consistency: 'strong' } for read-modify-write flows; the default
 *   ('eventual') can return a stale value for several seconds after a write.
 */
export function getConfiguredStore(name, opts = {}) {
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT;
  let parsed = null;
  if (ctx) {
    try { parsed = JSON.parse(Buffer.from(ctx, 'base64').toString('utf8')); } catch { parsed = null; }
  }

  // Strong reads go to `uncachedEdgeURL`. Production functions get one in the
  // context; the `netlify dev` sandbox only has `edgeURL`, and the client throws
  // BlobsConsistencyError there instead of degrading. Degrade for it.
  let consistency = opts.consistency;
  if (consistency === 'strong' && parsed && parsed.edgeURL && !parsed.uncachedEdgeURL) {
    if (!getConfiguredStore._warnedStrong) {
      getConfiguredStore._warnedStrong = true;
      console.warn(`blobs: strong consistency unavailable in this environment (no uncachedEdgeURL); using eventual for store "${name}"`);
    }
    consistency = undefined;
  }
  const extra = consistency ? { consistency } : {};

  // A deploy/dev context is present: let the client consume it (site, token,
  // edge URLs) rather than overriding it with a partial copy.
  if (parsed && (parsed.siteID || parsed.site_id) && parsed.token) {
    return getStore({ name, ...extra });
  }
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token, ...extra });
  return getStore({ name, ...extra });
}
