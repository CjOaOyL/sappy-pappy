/**
 * lib/emails.js
 * Shared chrome for self-hosted newsletter mail: the opt-in email, the
 * footer every broadcast carries, and the browser pages people land on
 * after clicking confirm/unsubscribe.
 *
 * MAILING_ADDRESS is a legal requirement, not decoration — CAN-SPAM requires a
 * physical postal address in every commercial email.
 */

import { siteUrl } from './mailer.js';

export function mailingAddress() {
  return process.env.MAILING_ADDRESS || 'The Green Book · Pennington, NJ';
}

export function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function confirmUrl(email, token) {
  return `${siteUrl()}/.netlify/functions/confirm-subscription`
       + `?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
}

export function unsubscribeUrl(email, token) {
  return `${siteUrl()}/.netlify/functions/unsubscribe`
       + `?e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
}

/** Footer appended to every broadcast. Takes a real per-subscriber URL. */
export function footerHtml(unsubUrl) {
  return `
        <tr><td style="background:#f0f0f0;padding:20px 32px;border-top:1px solid #e0e0e0;">
          <p style="margin:0;font-size:12px;color:#888;font-family:sans-serif;line-height:1.6;">
            You're receiving this because you subscribed to The Green Book newsletter at sappy-pappy.com.<br>
            <a href="${unsubUrl}" style="color:#2d7d46;">Unsubscribe</a><br>
            <span style="color:#aaa;">${escapeHtml(mailingAddress())}</span>
          </p>
        </td></tr>`;
}

/** Double opt-in email. */
export function optInEmail({ firstName, url }) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <tr><td style="background:#1b5e35;padding:28px 32px;">
          <p style="margin:0;font-size:13px;color:#a8d5b5;letter-spacing:1px;text-transform:uppercase;font-family:sans-serif;">The Green Book</p>
          <h1 style="margin:6px 0 0;font-size:22px;color:#ffffff;font-family:sans-serif;">Confirm your subscription</h1>
        </td></tr>

        <tr><td style="padding:32px;">
          <p style="margin:0 0 14px;font-size:15px;color:#333;line-height:1.6;">${greeting}</p>
          <p style="margin:0 0 22px;font-size:15px;color:#333;line-height:1.6;">
            Thanks for signing up for The Green Book — our directory of Black-owned businesses
            and community events. Click below to confirm and you'll be on the list.
          </p>
          <p style="margin:0 0 22px;">
            <a href="${url}" style="display:inline-block;background:#1b5e35;color:#ffffff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px;font-family:sans-serif;">Confirm my subscription →</a>
          </p>
          <p style="margin:0;font-size:13px;color:#666;line-height:1.6;">
            If the button doesn't work, paste this into your browser:<br>
            <a href="${url}" style="color:#2d7d46;word-break:break-all;">${url}</a>
          </p>
          <p style="margin:18px 0 0;font-size:13px;color:#888;line-height:1.6;">
            Didn't sign up? Just ignore this email — we won't add you without this confirmation.
          </p>
        </td></tr>

        <tr><td style="background:#f0f0f0;padding:20px 32px;border-top:1px solid #e0e0e0;">
          <p style="margin:0;font-size:12px;color:#888;font-family:sans-serif;line-height:1.6;">
            ${escapeHtml(mailingAddress())}
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Simple branded page returned to the browser after confirm/unsubscribe. */
export function resultPage({ heading, body, ok = true }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(heading)} — The Green Book</title>
</head>
<body style="margin:0;font-family:Georgia,serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;">
  <div style="max-width:520px;margin:24px;background:#fff;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);overflow:hidden;">
    <div style="background:${ok ? '#1b5e35' : '#7d2d2d'};padding:24px 32px;">
      <p style="margin:0;font-size:13px;color:#a8d5b5;letter-spacing:1px;text-transform:uppercase;font-family:sans-serif;">The Green Book</p>
      <h1 style="margin:6px 0 0;font-size:22px;color:#fff;font-family:sans-serif;">${escapeHtml(heading)}</h1>
    </div>
    <div style="padding:28px 32px;">
      <p style="margin:0 0 20px;font-size:15px;color:#333;line-height:1.6;">${body}</p>
      <a href="${siteUrl()}/green-book.html" style="display:inline-block;background:#1b5e35;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;font-family:sans-serif;">Visit The Green Book →</a>
    </div>
  </div>
</body>
</html>`;
}

export const HTML_HEADERS = {
  'Content-Type':           'text/html; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};
