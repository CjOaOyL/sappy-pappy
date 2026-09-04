/**
 * subscribe-existing-owners.js
 * Invites business owners already in the directory to the newsletter.
 *
 * Owner email addresses live in the SUBMISSIONS store, not the approved store:
 * submissionToCard() deliberately omits the email, so approved cards (which are
 * served publicly) never carry one. An earlier version of this function read the
 * approved store and therefore always found zero owners.
 *
 * Everyone found is sent a double opt-in email — nobody is added to the send
 * list without clicking it. `optInOnly` (default true) further restricts this to
 * owners who actually ticked the newsletter box on their application.
 *
 * POST /.netlify/functions/subscribe-existing-owners
 * Body: { password, optInOnly? }
 *
 * Requires env vars: ADMIN_PASSWORD, RESEND_API_KEY
 */

import { connectBlobs, getConfiguredStore } from './lib/blobs.js';
import { requestOptIn, isValidEmail, normalise, getSubscriber } from './lib/subscribers.js';

const headers = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };

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

  // Default to the conservative reading of consent.
  const optInOnly = body.optInOnly !== false;
  const dryRun    = body.dryRun === true;

  try {
    const store = getConfiguredStore('green-book-submissions');
    const { blobs } = await store.list();

    const submissions = (await Promise.all(
      blobs.map(async ({ key }) => {
        if (key.startsWith('edittoken:')) return null;
        const raw = await store.get(key).catch(() => null);
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      }),
    )).filter(Boolean);

    // Unique owner addresses, most recent submission wins for name/opt-in.
    const byEmail = new Map();
    for (const sub of submissions) {
      if (sub.type === 'edit-request') continue;
      const email = normalise(sub.ownerEmail);
      if (!email || !isValidEmail(email)) continue;

      const prev = byEmail.get(email);
      byEmail.set(email, {
        email,
        name:     sub.ownerName || prev?.name || '',
        // If they opted in on ANY submission, treat that as consent.
        optedIn:  !!sub.newsletterOptIn || !!prev?.optedIn,
        business: sub.businessName || prev?.business || '',
        status:   sub.status || prev?.status || '',
      });
    }

    const all       = [...byEmail.values()];
    const optedIn   = all.filter(o => o.optedIn);
    const candidates = optInOnly ? optedIn : all;

    // Anyone already known to the list is skipped — no duplicate invitations,
    // and suppressed addresses are never re-contacted.
    const fresh = [];
    for (const owner of candidates) {
      const existing = await getSubscriber(owner.email);
      if (existing) continue;
      fresh.push(owner);
    }

    const summary = {
      ownersFound:      all.length,
      optedIn:          optedIn.length,
      notOptedIn:       all.length - optedIn.length,
      alreadyOnList:    candidates.length - fresh.length,
      wouldInvite:      fresh.length,
      optInOnly,
    };

    if (dryRun) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, dryRun: true, ...summary }) };
    }

    let invited = 0, failed = 0;
    for (const owner of fresh) {
      const result = await requestOptIn(owner.email, owner.name);
      if (result.ok) invited++; else failed++;
      // Stay under Resend's rate limit.
      await new Promise(r => setTimeout(r, 600));
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, ...summary, invited, failed }),
    };

  } catch (err) {
    console.error('subscribe-existing-owners error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
