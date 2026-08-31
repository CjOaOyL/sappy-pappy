/**
 * subscribe-newsletter.js
 * Newsletter signup for The Green Book — self-hosted, no third-party ESP.
 *
 * Stores a pending subscriber and emails them a double opt-in link. Nobody is
 * added to the send list until they click it.
 *
 * POST /.netlify/functions/subscribe-newsletter
 * Body: { email, firstName? }
 *
 * Requires env vars: RESEND_API_KEY
 */

import { connectBlobs } from './lib/blobs.js';
import { upsertPending, isValidEmail } from './lib/subscribers.js';
import { sendEmail } from './lib/mailer.js';
import { optInEmail, confirmUrl } from './lib/emails.js';

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

export const handler = async (event) => {
  connectBlobs(event);

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Honeypot — bots fill hidden fields, humans don't.
  if (body._hp) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const email     = String(body.email || '').trim().toLowerCase();
  const firstName = String(body.firstName || '').trim().slice(0, 100);

  if (!isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email address is required.' }) };
  }

  try {
    const { status, subscriber } = await upsertPending(email, firstName);

    // Already-confirmed and suppressed addresses get the same neutral response
    // as a fresh signup, so this endpoint can't be used to probe who is on the list.
    if (status === 'already' || status === 'suppressed') {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status }) };
    }

    const result = await sendEmail({
      to:      subscriber.email,
      subject: 'Confirm your Green Book subscription',
      html:    optInEmail({
        firstName: subscriber.firstName,
        url:       confirmUrl(subscriber.email, subscriber.confirmToken),
      }),
    });

    if (!result.ok) {
      console.error('subscribe-newsletter: opt-in send failed:', result.error);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not send the confirmation email. Please try again.' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status }) };

  } catch (err) {
    console.error('subscribe-newsletter error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to subscribe. Please try again.' }) };
  }
};
