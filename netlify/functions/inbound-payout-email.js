/**
 * inbound-payout-email.js
 * Parses forwarded Airbnb / VRBO payout emails into revenue transactions.
 *
 * ─── Setup ─────────────────────────────────────────────────────────────────
 * 1. In Gmail (or wherever Airbnb/VRBO emails arrive), set up filters that
 *    auto-forward payout notifications to:
 *        payouts@inbound.sappy-pappy.com
 *    Filter suggestion: from:(airbnb.com OR vrbo.com OR homeaway.com)
 *                       subject:(payout OR "you've been paid" OR "payment sent")
 * 2. In Resend, ensure the inbound MX is set up for inbound.sappy-pappy.com,
 *    and add a route:
 *        Pattern: payouts@inbound.sappy-pappy.com
 *        Webhook: https://sappy-pappy.com/.netlify/functions/inbound-payout-email
 * 3. Env vars:
 *        ANTHROPIC_API_KEY (already set)
 *        RESEND_INBOUND_SECRET (recommended — webhook signature check)
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createHmac, timingSafeEqual, createHash } from 'crypto';
import {
  getConfiguredStore, FINANCE_STORE,
  loadTransactions, saveTransactions, loadConfig,
  sanitizeTransaction,
} from './lib/finance.js';

const headers = { 'Content-Type': 'application/json' };
const PROCESSED_KEY = 'processed-payout-hashes';

function verifyResendSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  try {
    const parts = signatureHeader.split(',');
    for (const part of parts) {
      const [, sig] = part.trim().split('=');
      if (!sig) continue;
      const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
      const sigBuf  = Buffer.from(sig, 'hex');
      const expBuf  = Buffer.from(expected, 'hex');
      if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) return true;
    }
  } catch { /* fall through */ }
  return false;
}

function detectPlatform(fromAddr, subject, text) {
  const haystack = `${fromAddr} ${subject} ${text}`.toLowerCase();
  if (/airbnb/.test(haystack)) return 'airbnb';
  if (/vrbo|homeaway|expedia group/.test(haystack)) return 'vrbo';
  return null;
}

function stripHtmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function callClaude(apiKey, platform, emailText) {
  const prompt = `Extract booking payout details from this ${platform} payout email.

Return ONLY valid JSON (no prose) with this shape:
{
  "netPayout": number,          // dollars actually paid out to host (after platform fees). Required.
  "date": "YYYY-MM-DD",         // payout date (or booking checkout date if payout date missing)
  "checkIn": "YYYY-MM-DD" or null,
  "checkOut": "YYYY-MM-DD" or null,
  "nights": number or null,
  "guestName": "string" or null,
  "propertyHint": "string" or null,   // any property/listing name found in the email
  "confidence": "high" | "medium" | "low"
}

If multiple bookings are summarized, return only the single payout this email is about.
If you cannot find a payout amount, return: { "netPayout": null, "confidence": "low" }

Email:
"""
${emailText.slice(0, 8000)}
"""`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

function classifyProperty(parsed, emailText) {
  const hint = `${parsed.propertyHint || ''} ${emailText}`.toLowerCase();
  if (/blue\s*bear|cottage/.test(hint)) return 'bluebear';
  if (/hiker|cabin/.test(hint))         return 'hikercabin';
  return null; // unknown — leave for manual classification
}

async function loadProcessedSet() {
  const store = getConfiguredStore(FINANCE_STORE);
  const raw = await store.get(PROCESSED_KEY);
  if (!raw) return new Set();
  try { return new Set(JSON.parse(raw)); } catch { return new Set(); }
}
async function saveProcessedSet(set) {
  const store = getConfiguredStore(FINANCE_STORE);
  const arr = [...set].slice(-2000); // cap
  await store.set(PROCESSED_KEY, JSON.stringify(arr));
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const inboundSecret = process.env.RESEND_INBOUND_SECRET;
  if (inboundSecret) {
    const sigHeader = event.headers['svix-signature']
                   || event.headers['resend-signature']
                   || event.headers['x-resend-signature']
                   || '';
    if (!verifyResendSignature(event.body || '', sigHeader, inboundSecret)) {
      console.warn('inbound-payout-email: invalid signature — rejected');
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid payload' }) }; }

  const fromAddr = (body.from || body.From || '').toString();
  const subject  = (body.subject || body.Subject || '').toString();
  const textBody = body.text || body.plain || stripHtmlToText(body.html || '');
  const emailText = `${subject}\n\n${textBody}`.trim();

  if (!emailText) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'empty' }) };
  }

  const platform = detectPlatform(fromAddr, subject, textBody);
  if (!platform) {
    console.log('inbound-payout-email: unknown platform, skipping. from=', fromAddr);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'unknown platform' }) };
  }

  // Dedup by content hash
  const hash = createHash('sha256').update(`${platform}|${subject}|${textBody}`).digest('hex').slice(0, 32);
  const processed = await loadProcessedSet();
  if (processed.has(hash)) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'duplicate' }) };
  }

  // Ask Claude to parse
  let parsed = {};
  try {
    const raw = await callClaude(apiKey, platform, emailText);
    const match = raw.match(/\{[\s\S]+\}/);
    if (match) parsed = JSON.parse(match[0]);
  } catch (err) {
    console.error('inbound-payout-email: Claude parse error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI parsing failed' }) };
  }

  const amount = Number(parsed.netPayout);
  if (!Number.isFinite(amount) || amount <= 0) {
    console.log('inbound-payout-email: no amount extracted', parsed);
    processed.add(hash);
    await saveProcessedSet(processed);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'no amount' }) };
  }

  const property = classifyProperty(parsed, emailText) || 'general';
  const platformCat = platform === 'airbnb' ? 'Airbnb' : 'VRBO';

  // Build the transaction. sanitizeTransaction handles the partner-payout calc.
  const config = await loadConfig();
  const tx = sanitizeTransaction({
    type: 'revenue',
    property,
    category: platformCat,
    amount,
    date: parsed.date,
    description: [
      parsed.guestName ? `Guest: ${parsed.guestName}` : null,
      parsed.checkIn && parsed.checkOut ? `Stay: ${parsed.checkIn} → ${parsed.checkOut}` : null,
      parsed.propertyHint ? `Listing: ${parsed.propertyHint}` : null,
      `Auto-imported (confidence: ${parsed.confidence || 'unknown'})`,
    ].filter(Boolean).join(' · '),
    paidBy: platformCat,
    nights: parsed.nights,
    guestName: parsed.guestName || undefined,
    platform,
    source: `${platform}-email`,
  }, config);

  const list = await loadTransactions();
  list.push(tx);
  await saveTransactions(list);
  processed.add(hash);
  await saveProcessedSet(processed);

  console.log(`inbound-payout-email: created ${platform} revenue ${tx.id} for ${property} amount ${amount}`);
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, transactionId: tx.id, property, amount }) };
};
