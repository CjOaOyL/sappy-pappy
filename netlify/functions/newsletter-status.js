/**
 * newsletter-status.js
 * Admin diagnostic for the self-hosted newsletter. Answers, in one call,
 * "why isn't mail going out?"
 *
 * Checks env vars, Resend domain verification, and subscriber counts, and
 * reports the from-address alongside the domains Resend will actually accept.
 * Domain verification failing silently is what broke transactional mail on this
 * site for five months — this endpoint exists so that can't happen again.
 *
 * POST /.netlify/functions/newsletter-status
 * Body: { password }
 *
 * Requires env vars: ADMIN_PASSWORD
 */

import { connectBlobs } from './lib/blobs.js';
import { counts } from './lib/subscribers.js';
import { fromAddress, replyToAddress } from './lib/mailer.js';

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

/** Domain of the from-address, e.g. "The Green Book <news@x.com>" → "x.com" */
function fromDomain() {
  const m = fromAddress().match(/<?([^<>@\s]+)@([^<>@\s]+?)>?$/);
  return m ? m[2] : null;
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

  const apiKey = process.env.RESEND_API_KEY;
  const report = {
    env: {
      RESEND_API_KEY:        apiKey ? 'set' : 'MISSING',
      RESEND_WEBHOOK_SECRET: process.env.RESEND_WEBHOOK_SECRET ? 'set' : 'MISSING (bounce handling disabled)',
      NEWSLETTER_FROM:       process.env.NEWSLETTER_FROM || '(default)',
      MAILING_ADDRESS:       process.env.MAILING_ADDRESS  || '(default)',
    },
    from:     fromAddress(),
    replyTo:  replyToAddress(),
    problems: [],
  };

  try {
    report.subscribers = await counts();
  } catch (err) {
    report.problems.push(`Could not read subscriber store: ${err.message}`);
  }

  if (!apiKey) {
    report.problems.push('RESEND_API_KEY is not set — nothing can send.');
    return { statusCode: 200, headers, body: JSON.stringify(report) };
  }

  // Ask Resend which domains are actually verified.
  try {
    const res  = await fetch('https://api.resend.com/domains', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      report.problems.push(`Resend API rejected the key (${res.status}): ${data.message || 'unknown error'}`);
      return { statusCode: 200, headers, body: JSON.stringify(report) };
    }

    const domains = (data.data || []).map(d => ({ name: d.name, status: d.status, region: d.region }));
    report.domains = domains;

    const needed   = fromDomain();
    const verified = domains.filter(d => d.status === 'verified').map(d => d.name);
    report.fromDomain = needed;

    if (!verified.includes(needed)) {
      const found = domains.find(d => d.name === needed);
      report.problems.push(
        found
          ? `From-address domain "${needed}" is registered in Resend but its status is "${found.status}" — sends will fail until it is verified.`
          : `From-address domain "${needed}" is not registered in Resend at all. Add it at resend.com/domains.`,
      );
      if (verified.length) {
        report.problems.push(`Verified domains available: ${verified.join(', ')}. Set NEWSLETTER_FROM to an address on one of these.`);
      }
    }
  } catch (err) {
    report.problems.push(`Could not reach Resend: ${err.message}`);
  }

  report.ok = report.problems.length === 0;
  return { statusCode: 200, headers, body: JSON.stringify(report) };
};
