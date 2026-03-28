/**
 * approve-event.js
 * Admin endpoint: list, approve, and reject community event submissions.
 * Password-protected via ADMIN_PASSWORD env var.
 *
 * POST /.netlify/functions/approve-event
 * Body: { password, action, id?, rejectReason? }
 *
 * Actions:
 *   'list'    — List all pending event submissions.
 *   'approve' — Approve an event → copy to green-book-events-approved store.
 *   'reject'  — Reject an event (marks status, does not delete).
 */

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

async function sendApprovalEmail(event) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  try {
    const dateStr = event.allDay
      ? event.startDate
      : `${event.startDate}${event.startTime ? ' at ' + event.startTime : ''}`;
    const calUrl = `https://sappy-pappy.com/green-book.html#community-events`;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Green Book <noreply@sappy-pappy.com>',
        to: [event.organizerEmail],
        subject: `🎉 Your event is approved — ${event.title}`,
        html: `
<h2 style="color:#2d7d46;font-family:sans-serif;">Your event is live!</h2>
<p style="font-family:sans-serif;font-size:15px;">Hi ${event.organizer},</p>
<p style="font-family:sans-serif;font-size:15px;">
  <strong>${event.title}</strong> has been approved and is now on The Green Book community calendar.
</p>
<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;margin-bottom:16px;">
  <tr><td style="padding:5px 10px;font-weight:bold;background:#e8f5ec;">Date</td><td style="padding:5px 10px;">${dateStr}</td></tr>
  ${event.location ? `<tr><td style="padding:5px 10px;font-weight:bold;background:#e8f5ec;">Location</td><td style="padding:5px 10px;">${event.location}</td></tr>` : ''}
</table>
<p style="text-align:center;margin:24px 0;">
  <a href="${calUrl}" style="background:#2d7d46;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;font-family:sans-serif;">
    View on the Calendar →
  </a>
</p>
<p style="font-family:sans-serif;font-size:13px;color:#888;">
  Community members can add this event to their Google Calendar directly from the listing.
</p>
        `,
      }),
    });
  } catch (err) {
    console.error('Approval email failed (non-fatal):', err.message);
  }
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  };

  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD env var is not set.' }) };
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

    const pending  = getConfiguredStore('green-book-events');
    const approved = getConfiguredStore('green-book-events-approved');

    // ── LIST pending events ────────────────────────────────────────────────
    if (body.action === 'list') {
      const { blobs } = await pending.list();
      const all = await Promise.all(blobs.map(async ({ key }) => {
        const raw = await pending.get(key);
        try { return JSON.parse(raw); } catch { return null; }
      }));
      const items = all.filter(e => e && e.status === 'pending');
      items.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
      return { statusCode: 200, headers, body: JSON.stringify({ events: items }) };
    }

    // ── APPROVE ───────────────────────────────────────────────────────────
    if (body.action === 'approve') {
      if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

      const raw = await pending.get(body.id);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found' }) };

      const ev = JSON.parse(raw);
      ev.status     = 'approved';
      ev.approvedAt = new Date().toISOString();

      // Save back to pending store (so status is updated) and to approved store
      await pending.set(body.id, JSON.stringify(ev));
      await approved.set(body.id, JSON.stringify(ev));

      await sendApprovalEmail(ev);

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, event: ev }) };
    }

    // ── REJECT ────────────────────────────────────────────────────────────
    if (body.action === 'reject') {
      if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };

      const raw = await pending.get(body.id);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event not found' }) };

      const ev = JSON.parse(raw);
      ev.status       = 'rejected';
      ev.rejectedAt   = new Date().toISOString();
      ev.rejectReason = String(body.rejectReason || '').trim().slice(0, 500);

      await pending.set(body.id, JSON.stringify(ev));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('approve-event unhandled error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
