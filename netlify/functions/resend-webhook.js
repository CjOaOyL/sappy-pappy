/**
 * resend-webhook.js
 * Bounce and complaint handling — the part that protects sender reputation.
 *
 * Resend posts delivery events here. Hard bounces and spam complaints suppress
 * the address permanently, so it is never mailed again.
 *
 * ─── Setup ─────────────────────────────────────────────────────────────────
 * In Resend → Webhooks, add an endpoint:
 *   https://sappy-pappy.com/.netlify/functions/resend-webhook
 * subscribed to: email.bounced, email.complained
 * Then set RESEND_WEBHOOK_SECRET to the signing secret Resend shows you.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * POST /.netlify/functions/resend-webhook
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { connectBlobs } from './lib/blobs.js';
import { suppress } from './lib/subscribers.js';

const headers = { 'Content-Type': 'application/json' };

/**
 * Svix-style signature check (Resend uses Svix).
 * Header format: "v1,<base64sig> v1,<base64sig>" — any one matching is valid.
 */
function verifySignature(rawBody, hdrs, secret) {
  const id        = hdrs['svix-id']        || hdrs['webhook-id'];
  const timestamp = hdrs['svix-timestamp'] || hdrs['webhook-timestamp'];
  const sigHeader = hdrs['svix-signature'] || hdrs['webhook-signature'];
  if (!id || !timestamp || !sigHeader) return false;

  // Reject replays older than 5 minutes.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key      = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest('base64');

  return sigHeader.split(' ').some(part => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

export const handler = async (event) => {
  connectBlobs(event);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.error('resend-webhook: RESEND_WEBHOOK_SECRET not set — refusing unverified events');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Webhook not configured' }) };
  }

  const raw = event.body || '';
  const lower = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]),
  );

  if (!verifySignature(raw, lower, secret)) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
  }

  let payload;
  try { payload = JSON.parse(raw); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const type = payload.type;
  const to   = payload.data?.to;
  const addresses = Array.isArray(to) ? to : (to ? [to] : []);

  // Soft bounces are transient (full mailbox, temporary outage) — don't suppress those.
  const isHardBounce = type === 'email.bounced' && payload.data?.bounce?.type !== 'Transient';
  const isComplaint  = type === 'email.complained';

  if (!isHardBounce && !isComplaint) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ignored: type }) };
  }

  try {
    const reason = isComplaint ? 'complaint' : 'hard_bounce';
    for (const addr of addresses) {
      await suppress(addr, reason);
      console.log(`suppressed ${addr} (${reason})`);
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, suppressed: addresses.length }) };
  } catch (err) {
    console.error('resend-webhook error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
