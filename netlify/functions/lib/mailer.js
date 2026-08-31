/**
 * lib/mailer.js
 * Resend wrapper for newsletter sending.
 *
 * Bulk mail goes out one message per recipient (never a shared To/BCC) so each
 * subscriber gets their own unsubscribe link and Resend can attribute bounces
 * to the right address.
 *
 * The from-address must sit on a domain VERIFIED IN RESEND, otherwise every
 * send fails with a domain error. Check resend.com/domains before changing it.
 *
 * Requires env vars:
 *   RESEND_API_KEY
 *   NEWSLETTER_FROM   optional, defaults to The Green Book <news@sappy-pappy.com>
 *   NEWSLETTER_REPLY_TO optional, defaults to jaquan@sappy-pappy.com
 */

const RESEND_URL = 'https://api.resend.com/emails';

/** Resend's default rate limit is 2 requests/second; stay under it. */
const SEND_INTERVAL_MS = 600;

export function fromAddress() {
  return process.env.NEWSLETTER_FROM || 'The Green Book <news@sappy-pappy.com>';
}

/** Replies go to a real monitored mailbox, not the send-only from-address. */
export function replyToAddress() {
  return process.env.NEWSLETTER_REPLY_TO || 'jaquan@sappy-pappy.com';
}

export function siteUrl() {
  return (process.env.URL || 'https://sappy-pappy.com').replace(/\/$/, '');
}

/**
 * Send a single email.
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 */
export async function sendEmail({ to, subject, html, headers = {} }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };

  try {
    const res = await fetch(RESEND_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        from:     fromAddress(),
        to:       [to],
        reply_to: replyToAddress(),
        subject, html, headers,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = data.message || data.name || `Resend error ${res.status}`;
      // Domain verification is the most common cause and the least obvious —
      // name it explicitly so it never reads as a generic failure again.
      console.error(`Resend send failed (${res.status}) from=${fromAddress()}: ${error}`);
      return { ok: false, error, status: res.status };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send one personalised message per recipient, sequentially and rate-limited.
 *
 * @param {Array<{email:string, html:string, headers?:object}>} messages
 * @param {string} subject
 * @returns {Promise<{sent:number, failed:number, failures:Array}>}
 */
export async function sendBulk(messages, subject) {
  let sent = 0, failed = 0;
  const failures = [];

  for (const [i, msg] of messages.entries()) {
    if (i > 0) await new Promise(r => setTimeout(r, SEND_INTERVAL_MS));

    const result = await sendEmail({
      to:      msg.email,
      subject,
      html:    msg.html,
      headers: msg.headers || {},
    });

    if (result.ok) {
      sent++;
    } else {
      failed++;
      failures.push({ email: msg.email, error: result.error });
      console.error(`newsletter send failed for ${msg.email}:`, result.error);
    }
  }

  return { sent, failed, failures };
}

/**
 * List-Unsubscribe headers. Gmail and Outlook surface a native unsubscribe
 * button when these are present, which keeps people from reporting spam
 * instead — the single biggest lever on sender reputation.
 */
export function unsubscribeHeaders(url) {
  return {
    'List-Unsubscribe':      `<${url}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}
