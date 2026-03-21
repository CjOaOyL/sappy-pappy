/**
 * save-pricing.js
 * Saves the pricing configuration to Netlify Blobs.
 * Requires the ADMIN_PASSWORD environment variable to be set.
 *
 * POST /.netlify/functions/save-pricing
 * Body: { password: string, config: PricingConfig }
 * Returns: { ok: true } or { error: string }
 */

import { getStore } from '@netlify/blobs';

// Simple constant-time string comparison to prevent timing attacks
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// Basic input sanitization
function sanitizeConfig(config) {
  return {
    baseRate: Math.max(0, Math.min(9999, Number(config.baseRate) || 0)),
    cleaningFee: Math.max(0, Math.min(9999, Number(config.cleaningFee) || 0)),
    minimumStay: Math.max(1, Math.min(30, Number(config.minimumStay) || 1)),
    weekendPremium: Math.max(0, Math.min(999, Number(config.weekendPremium) || 0)),
    taxRate: Math.max(0, Math.min(50, Number(config.taxRate) || 0)),
    seasons: Array.isArray(config.seasons)
      ? config.seasons.slice(0, 20).map(s => ({
          label: String(s.label || '').slice(0, 60),
          startMMDD: String(s.startMMDD || '').slice(0, 5),
          endMMDD: String(s.endMMDD || '').slice(0, 5),
          rate: Math.max(0, Math.min(9999, Number(s.rate) || 0)),
        }))
      : [],
    overrides: (() => {
      const clean = {};
      const src = config.overrides || {};
      for (const [k, v] of Object.entries(src)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
          clean[k] = v === null ? null : Math.max(0, Math.min(9999, Number(v) || 0));
        }
      }
      return clean;
    })(),
    bufferBefore: Math.max(0, Math.min(7, Number(config.bufferBefore) ?? 1)),
    bufferAfter:  Math.max(0, Math.min(7, Number(config.bufferAfter)  ?? 1)),
    guestNotes: String(config.guestNotes || '').slice(0, 1000),
    updatedAt: new Date().toISOString(),
  };
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': 'same-origin', // admin only, no cross-origin
    'X-Content-Type-Options': 'nosniff',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Admin not configured' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!safeEqual(body.password || '', adminPassword)) {
    // Intentional small delay to slow brute-force
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  if (!body.config || typeof body.config !== 'object') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing config' }) };
  }

  try {
    const clean = sanitizeConfig(body.config);
    const store = getStore('bluebear-pricing');
    await store.set('config', JSON.stringify(clean));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, savedAt: clean.updatedAt }) };
  } catch (err) {
    console.error('save-pricing error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save' }) };
  }
};
