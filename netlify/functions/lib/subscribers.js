/**
 * lib/subscribers.js
 * Self-hosted newsletter subscriber list for The Green Book.
 *
 * Replaces Kit's subscriber management. One blob per subscriber in the
 * `green-book-subscribers` store, keyed by a normalised email address.
 *
 * States:
 *   pending      — signed up, has not clicked the confirmation link yet
 *   confirmed    — double opt-in complete; receives mail
 *   unsubscribed — opted out; never receives mail again
 *   suppressed   — hard bounce or spam complaint; never receives mail again
 *
 * Only `confirmed` subscribers are ever mailed. Suppression is permanent and
 * takes precedence over re-subscribing, so a complaint can't be undone by
 * someone re-submitting the signup form.
 */

import { randomUUID, createHash } from 'crypto';
import { getConfiguredStore } from './blobs.js';

const STORE = 'green-book-subscribers';

/** Blob keys must be filesystem-safe; emails are not. Hash for the key, keep the address in the record. */
export function keyFor(email) {
  return createHash('sha256').update(normalise(email)).digest('hex').slice(0, 32);
}

export function normalise(email) {
  return String(email || '').trim().toLowerCase();
}

export function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalise(email));
}

/** Overridable for tests; production always uses the real Blobs store. */
let storeImpl = null;
export function _setStoreForTests(s) { storeImpl = s; }

function store() {
  return storeImpl || getConfiguredStore(STORE);
}

export async function getSubscriber(email) {
  try {
    const raw = await store().get(keyFor(email));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function putSubscriber(sub) {
  await store().set(keyFor(sub.email), JSON.stringify(sub));
  return sub;
}

export async function listSubscribers() {
  try {
    const s = store();
    const { blobs } = await s.list();
    const all = await Promise.all(
      blobs.map(async ({ key }) => {
        const raw = await s.get(key).catch(() => null);
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      }),
    );
    return all.filter(Boolean);
  } catch {
    return [];
  }
}

/** Only these receive broadcasts. */
export async function listConfirmed() {
  return (await listSubscribers()).filter(s => s.state === 'confirmed');
}

/**
 * Sign up an address. Idempotent and safe to call repeatedly.
 *
 * Returns { status, subscriber } where status is one of:
 *   'created'        — new pending record, send them a confirmation
 *   'resend'         — already pending, send the confirmation again
 *   'already'        — already confirmed, nothing to do
 *   'suppressed'     — bounced/complained previously; refuse silently
 */
export async function upsertPending(email, firstName = '') {
  const addr     = normalise(email);
  const existing = await getSubscriber(addr);
  const now      = new Date().toISOString();

  if (existing?.state === 'suppressed') {
    return { status: 'suppressed', subscriber: existing };
  }
  if (existing?.state === 'confirmed') {
    return { status: 'already', subscriber: existing };
  }

  if (existing) {
    // Pending or previously unsubscribed — reissue a fresh confirm token.
    const updated = {
      ...existing,
      firstName:    firstName || existing.firstName || '',
      state:        'pending',
      confirmToken: randomUUID(),
      updatedAt:    now,
    };
    await putSubscriber(updated);
    return { status: 'resend', subscriber: updated };
  }

  const created = {
    email:            addr,
    firstName:        firstName || '',
    state:            'pending',
    confirmToken:     randomUUID(),
    unsubscribeToken: randomUUID(),
    createdAt:        now,
    updatedAt:        now,
    confirmedAt:      null,
  };
  await putSubscriber(created);
  return { status: 'created', subscriber: created };
}

/** Complete double opt-in. Token must match the stored one. */
export async function confirm(email, token) {
  const sub = await getSubscriber(email);
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.state === 'suppressed') return { ok: false, error: 'suppressed' };

  // Validate the token BEFORE reporting state. Answering "already subscribed"
  // to an unauthenticated caller would let anyone test whether an address is
  // on the list. The token is retained rather than cleared on use so that
  // re-clicking a confirmation link still works.
  if (!token || token !== sub.confirmToken) return { ok: false, error: 'bad_token' };

  if (sub.state === 'confirmed') return { ok: true, already: true, subscriber: sub };

  const now     = new Date().toISOString();
  const updated = {
    ...sub,
    state:       'confirmed',
    confirmedAt: now,
    updatedAt:   now,
  };
  await putSubscriber(updated);
  return { ok: true, subscriber: updated };
}

/** One-click opt-out. Token must match, so a stranger can't unsubscribe someone else. */
export async function unsubscribe(email, token) {
  const sub = await getSubscriber(email);
  if (!sub) return { ok: false, error: 'not_found' };
  if (!token || token !== sub.unsubscribeToken) return { ok: false, error: 'bad_token' };
  if (sub.state === 'unsubscribed') return { ok: true, already: true, subscriber: sub };

  const updated = { ...sub, state: 'unsubscribed', updatedAt: new Date().toISOString() };
  await putSubscriber(updated);
  return { ok: true, subscriber: updated };
}

/**
 * Permanently stop mailing an address after a hard bounce or spam complaint.
 * Deliberately has no token check — it is driven by provider webhooks, and it
 * only ever removes permission, never grants it.
 */
export async function suppress(email, reason) {
  const sub = await getSubscriber(email);
  const now = new Date().toISOString();
  const rec = sub
    ? { ...sub, state: 'suppressed', suppressReason: reason, updatedAt: now }
    : {
        email:            normalise(email),
        firstName:        '',
        state:            'suppressed',
        suppressReason:   reason,
        unsubscribeToken: randomUUID(),
        createdAt:        now,
        updatedAt:        now,
      };
  await putSubscriber(rec);
  return rec;
}

/**
 * Sign someone up and email them the opt-in link. The one entry point every
 * signup path should use — public form, owner opt-in, event submitter.
 *
 * Never throws: subscription is always a side concern to whatever the caller
 * is really doing, so failures are reported, not raised.
 */
export async function requestOptIn(email, firstName = '') {
  if (!isValidEmail(email)) return { ok: false, error: 'invalid_email' };

  try {
    const { sendEmail }             = await import('./mailer.js');
    const { optInEmail, confirmUrl } = await import('./emails.js');

    const { status, subscriber } = await upsertPending(email, firstName);

    // Nothing to send: they're already on the list, or permanently suppressed.
    if (status === 'already' || status === 'suppressed') return { ok: true, status };

    const result = await sendEmail({
      to:      subscriber.email,
      subject: 'Confirm your Green Book subscription',
      html:    optInEmail({
        firstName: subscriber.firstName,
        url:       confirmUrl(subscriber.email, subscriber.confirmToken),
      }),
    });

    if (!result.ok) {
      console.error('requestOptIn: send failed for', subscriber.email, result.error);
      return { ok: false, status, error: result.error };
    }
    return { ok: true, status };

  } catch (err) {
    console.error('requestOptIn error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Undo a MANUAL suppression only.
 *
 * Complaints and hard bounces stay locked forever: those record something the
 * recipient or their mail server told us, and an admin clicking a button is not
 * grounds to overrule it. A manual suppression is just bookkeeping, so it can
 * be reversed.
 *
 * Restored addresses return to 'unsubscribed', never straight to 'confirmed' —
 * lifting an admin action must not manufacture consent that was never given.
 * They can subscribe again normally, which re-runs double opt-in.
 */
export async function unsuppress(email) {
  const sub = await getSubscriber(email);
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.state !== 'suppressed') return { ok: false, error: 'not_suppressed' };
  if (sub.suppressReason !== 'manual') {
    return { ok: false, error: 'not_reversible', reason: sub.suppressReason };
  }

  const updated = { ...sub, state: 'unsubscribed', updatedAt: new Date().toISOString() };
  delete updated.suppressReason;
  await putSubscriber(updated);
  return { ok: true, subscriber: updated };
}

export async function counts() {
  const all = await listSubscribers();
  return all.reduce(
    (acc, s) => { acc[s.state] = (acc[s.state] || 0) + 1; acc.total++; return acc; },
    { total: 0 },
  );
}
