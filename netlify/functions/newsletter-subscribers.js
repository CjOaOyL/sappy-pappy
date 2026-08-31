/**
 * newsletter-subscribers.js
 * Admin view and maintenance for the self-hosted subscriber list.
 *
 * POST /.netlify/functions/newsletter-subscribers
 * Body: { password, action, email?, firstName?, subscribers? }
 *
 * Actions:
 *   'list'       — all subscribers with state counts
 *   'import'     — bulk add already-consented addresses as confirmed (migration)
 *   'suppress'   — manually stop mailing an address
 *   'unsuppress' — undo a MANUAL suppression only (bounces/complaints stay locked)
 *   'resend'     — reissue the opt-in email to a pending subscriber
 *
 * Requires env vars: ADMIN_PASSWORD
 */

import { connectBlobs } from './lib/blobs.js';
import {
  listSubscribers, counts, putSubscriber, getSubscriber,
  suppress, unsuppress, requestOptIn, normalise, isValidEmail,
} from './lib/subscribers.js';
import { randomUUID } from 'crypto';

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const handler = async (event) => {
  connectBlobs(event);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
  }
  if (!safeEqual(body.password || '', adminPassword)) {
    await new Promise(r => setTimeout(r, 500));
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    // ── LIST ────────────────────────────────────────────────────────────────
    if (body.action === 'list') {
      const all = await listSubscribers();
      all.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          counts: await counts(),
          subscribers: all.map(s => ({
            email:       s.email,
            firstName:   s.firstName,
            state:       s.state,
            createdAt:   s.createdAt,
            confirmedAt: s.confirmedAt,
            suppressReason: s.suppressReason || null,
          })),
        }),
      };
    }

    // ── IMPORT ──────────────────────────────────────────────────────────────
    // For addresses that already gave consent elsewhere (e.g. confirmed in Kit).
    // Marked confirmed directly — do NOT use this for addresses that never opted in.
    if (body.action === 'import') {
      const incoming = Array.isArray(body.subscribers) ? body.subscribers : [];
      if (!incoming.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'subscribers array required' }) };
      }

      let imported = 0, skipped = 0;
      const now = new Date().toISOString();

      for (const item of incoming) {
        const email = normalise(typeof item === 'string' ? item : item.email);
        if (!isValidEmail(email)) { skipped++; continue; }

        const existing = await getSubscriber(email);
        // Never resurrect a suppressed address, and don't clobber an existing record.
        if (existing && (existing.state === 'suppressed' || existing.state === 'confirmed')) {
          skipped++; continue;
        }

        await putSubscriber({
          email,
          firstName:        (typeof item === 'object' && item.firstName) || existing?.firstName || '',
          state:            'confirmed',
          confirmToken:     null,
          unsubscribeToken: existing?.unsubscribeToken || randomUUID(),
          createdAt:        existing?.createdAt || now,
          updatedAt:        now,
          confirmedAt:      now,
          importedFrom:     (typeof item === 'object' && item.source) || 'import',
        });
        imported++;
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, imported, skipped, counts: await counts() }) };
    }

    // ── SUPPRESS ────────────────────────────────────────────────────────────
    if (body.action === 'suppress') {
      if (!isValidEmail(body.email || '')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
      }
      await suppress(body.email, body.reason || 'manual');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, counts: await counts() }) };
    }

    // ── UNSUPPRESS (manual suppressions only) ───────────────────────────────
    if (body.action === 'unsuppress') {
      if (!isValidEmail(body.email || '')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
      }
      const result = await unsuppress(body.email);
      if (!result.ok) {
        const msg = result.error === 'not_reversible'
          ? `This address was suppressed because of a ${result.reason === 'complaint' ? 'spam complaint' : 'hard bounce'}, which cannot be undone.`
          : result.error === 'not_suppressed'
            ? 'That address is not suppressed.'
            : 'Address not found.';
        return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, counts: await counts() }) };
    }

    // ── RESEND OPT-IN ───────────────────────────────────────────────────────
    if (body.action === 'resend') {
      if (!isValidEmail(body.email || '')) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
      }
      const result = await requestOptIn(body.email, body.firstName || '');
      return {
        statusCode: result.ok ? 200 : 500, headers,
        body: JSON.stringify(result),
      };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('newsletter-subscribers error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
