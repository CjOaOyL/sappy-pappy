/**
 * newsletter-settings.js
 * Admin endpoint for newsletter configuration and manual triggers.
 * Password-protected via ADMIN_PASSWORD env var.
 *
 * POST /.netlify/functions/newsletter-settings
 * Body: { password, action, settings? }
 *
 * Actions:
 *   'get'          — Return current settings
 *   'save'         — Save settings object
 *   'send-digest'  — Send (or draft) the pending digest now
 *   'preview'      — Return preview HTML for the next pending digest (or first card)
 */

import {
  getSettings,
  saveSettings,
  sendDigest,
  generateContent,
  buildEmailHtml,
  sendToKit,
} from './lib/newsletter.js';
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

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

const ALLOWED_MODES      = ['immediate', 'digest'];
const ALLOWED_INTERVALS  = ['daily', 'weekly', 'monthly'];

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  if (!safeEqual(body.password || '', adminPassword)) {
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  // ── GET settings ────────────────────────────────────────────────────────────
  if (body.action === 'get') {
    try {
      const settings = await getSettings();
      return { statusCode: 200, headers, body: JSON.stringify({ settings }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── SAVE settings ───────────────────────────────────────────────────────────
  if (body.action === 'save') {
    try {
      const current = await getSettings();
      const incoming = body.settings || {};

      if (typeof incoming.enabled === 'boolean')               current.enabled        = incoming.enabled;
      if (ALLOWED_MODES.includes(incoming.mode))               current.mode           = incoming.mode;
      if (ALLOWED_INTERVALS.includes(incoming.digestInterval)) current.digestInterval = incoming.digestInterval;
      if (typeof incoming.autoSend === 'boolean')              current.autoSend       = incoming.autoSend;

      await saveSettings(current);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, settings: current }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── SEND DIGEST ─────────────────────────────────────────────────────────────
  if (body.action === 'send-digest') {
    try {
      const result = await sendDigest();
      if (!result.ok) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: result.error }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, broadcast: result.broadcast }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── PREVIEW ─────────────────────────────────────────────────────────────────
  if (body.action === 'preview') {
    try {
      const settings = await getSettings();
      const approvedStore = getConfiguredStore('green-book-approved');

      // Use first pending card, or just first approved card
      let card = null;
      const pendingIds = settings.pending || [];
      for (const id of pendingIds) {
        const raw = await approvedStore.get(id).catch(() => null);
        if (raw) { card = JSON.parse(raw); break; }
      }
      if (!card) {
        const { blobs } = await approvedStore.list();
        if (blobs.length > 0) {
          const raw = await approvedStore.get(blobs[0].key).catch(() => null);
          if (raw) card = JSON.parse(raw);
        }
      }
      if (!card) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'No listings available for preview.' }) };
      }

      const aiBody  = await generateContent(card);
      const bodyHtml = aiBody || `<p>We're excited to welcome <strong>${card.name}</strong> to The Green Book!</p>`;
      const subject  = `New on The Green Book: ${card.name}`;
      const html     = buildEmailHtml({ card, bodyHtml, subject });

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
        body: html,
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── LIST APPROVED BUSINESSES ─────────────────────────────────────────────────
  if (body.action === 'list-approved') {
    try {
      const approvedStore = getConfiguredStore('green-book-approved');
      const { blobs } = await approvedStore.list();
      const cards = (await Promise.all(
        blobs.map(async ({ key }) => {
          const raw = await approvedStore.get(key).catch(() => null);
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        })
      )).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
      return { statusCode: 200, headers, body: JSON.stringify({ businesses: cards.map(c => ({ id: c.id, name: c.name, category: c.category, icon: c.icon })) }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── SEND FOR SPECIFIC BUSINESS ────────────────────────────────────────────────
  if (body.action === 'send-for-business') {
    if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    try {
      const approvedStore = getConfiguredStore('green-book-approved');
      const raw = await approvedStore.get(body.id).catch(() => null);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found.' }) };
      const card = JSON.parse(raw);

      const settings = await getSettings();
      const aiBody   = await generateContent(card);
      const bodyHtml = aiBody || `<p>We're excited to welcome <strong>${card.name}</strong> to The Green Book!</p>`;
      const subject  = `New on The Green Book: ${card.name}`;
      const html     = buildEmailHtml({ card, bodyHtml, subject });

      const result = await sendToKit({ subject, html, publish: settings.autoSend });
      if (!result.ok) return { statusCode: 500, headers, body: JSON.stringify({ error: result.error }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, broadcast: result.broadcast }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ── PREVIEW FOR SPECIFIC BUSINESS ─────────────────────────────────────────────
  if (body.action === 'preview-for-business') {
    if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    try {
      const approvedStore = getConfiguredStore('green-book-approved');
      const raw = await approvedStore.get(body.id).catch(() => null);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Business not found.' }) };
      const card = JSON.parse(raw);

      const aiBody   = await generateContent(card);
      const bodyHtml = aiBody || `<p>We're excited to welcome <strong>${card.name}</strong> to The Green Book!</p>`;
      const subject  = `New on The Green Book: ${card.name}`;
      const html     = buildEmailHtml({ card, bodyHtml, subject });

      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
        body: html,
      };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
