/**
 * submit-event.js
 * Handles community event submissions for The Green Book calendar.
 *
 * POST /.netlify/functions/submit-event
 * Body: { title, description, category, startDate, startTime?, endDate?, endTime?,
 *         allDay?, location?, locationAddress?, organizer, organizerEmail, externalLink?,
 *         newsletterOptIn? }
 *
 * Returns: { ok: true, id }
 *
 * Email notifications require RESEND_API_KEY env var (optional).
 */

import { getStore } from '@netlify/blobs';
import { randomUUID } from 'crypto';

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

function uid() {
  return randomUUID().replace(/-/g, '');
}

function clean(val, max = 500) {
  return String(val || '').trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  if (!url) return true;
  try { new URL(url); return true; } catch { return false; }
}

function isValidDate(str) {
  if (!str) return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(Date.parse(str));
}

function isValidTime(str) {
  if (!str) return true; // optional
  return /^\d{2}:\d{2}$/.test(str);
}

const ALLOWED_CATEGORIES = [
  'Festival', 'Workshop', 'Market', 'Community', 'Arts & Culture',
  'Music', 'Food & Drink', 'Activism', 'Health & Wellness',
  'Business', 'Education', 'Celebration', 'Other',
];

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

async function sendSubmitterEmail(event) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Green Book <noreply@sappy-pappy.com>',
        to: [event.organizerEmail],
        subject: `📅 Event submission received — ${event.title}`,
        html: `
<h2 style="color:#2d7d46;font-family:sans-serif;">Event Submission Received</h2>
<p style="font-family:sans-serif;font-size:15px;">Hi ${event.organizer},</p>
<p style="font-family:sans-serif;font-size:15px;">
  We've received your event submission: <strong>${event.title}</strong> on ${event.startDate}.
  We typically review within 48 hours.
</p>
<p style="font-family:sans-serif;font-size:15px;color:#555;">
  Once approved, your event will appear on The Green Book community calendar and be included in the iCal feed.
</p>
<p style="font-family:sans-serif;font-size:13px;color:#888;">
  Questions? Reply to this email or contact us at hello@sappy-pappy.com.
</p>
        `,
      }),
    });
  } catch (err) {
    console.error('Submitter event email failed (non-fatal):', err.message);
  }
}

async function sendAdminEmail(event) {
  const resendKey   = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFY_EMAIL || 'hello@sappy-pappy.com';
  if (!resendKey) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Green Book <noreply@sappy-pappy.com>',
        to: [notifyEmail],
        subject: `📅 New Event Submission: ${event.title}`,
        html: `
<h2 style="color:#2d7d46;font-family:sans-serif;">New Community Event Submission</h2>
<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:15px;">
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Event</td><td style="padding:6px 12px;">${event.title}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Date</td><td style="padding:6px 12px;">${event.startDate}${event.startTime ? ' ' + event.startTime : ''}${event.endDate && event.endDate !== event.startDate ? ' → ' + event.endDate : ''}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Category</td><td style="padding:6px 12px;">${event.category}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Location</td><td style="padding:6px 12px;">${event.location || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Organizer</td><td style="padding:6px 12px;">${event.organizer}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Organizer Email</td><td style="padding:6px 12px;">${event.organizerEmail}</td></tr>
  <tr><td colspan="2" style="padding:10px 12px;"><strong>Description:</strong><br/>${event.description}</td></tr>
</table>
<br/>
<p><a href="https://sappy-pappy.com/green-book.html?admin=1" style="background:#2d7d46;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Review in Admin Panel →</a></p>
        `,
      }),
    });
  } catch (err) {
    console.error('Admin event email failed (non-fatal):', err.message);
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Honeypot
  if (body._hp) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // Validation
  const title = clean(body.title, 120);
  if (!title) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Event title is required.' }) };
  }

  const description = clean(body.description, 1200);
  if (!description) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Event description is required.' }) };
  }

  const category = clean(body.category, 60);
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please select a valid event category.' }) };
  }

  if (!isValidDate(body.startDate)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid start date is required.' }) };
  }

  const endDate = body.endDate && isValidDate(body.endDate) ? body.endDate : body.startDate;

  if (new Date(endDate) < new Date(body.startDate)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'End date cannot be before start date.' }) };
  }

  if (!isValidTime(body.startTime)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid start time format.' }) };
  }
  if (!isValidTime(body.endTime)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid end time format.' }) };
  }

  const organizer = clean(body.organizer, 100);
  if (!organizer) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Organizer name is required.' }) };
  }

  if (!isValidEmail(body.organizerEmail)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid organizer email is required.' }) };
  }

  if (body.externalLink && !isValidUrl(body.externalLink)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid URL for event link.' }) };
  }

  // Check the event isn't more than 2 years in the past (basic sanity check)
  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  if (new Date(body.startDate) < twoYearsAgo) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Event date is too far in the past.' }) };
  }

  const submission = {
    id:              uid(),
    status:          'pending',
    submittedAt:     new Date().toISOString(),
    title,
    description,
    category,
    startDate:       body.startDate,
    startTime:       clean(body.startTime, 10) || null,
    endDate,
    endTime:         clean(body.endTime, 10) || null,
    allDay:          body.allDay === true || body.allDay === 'true',
    location:        clean(body.location, 150),
    locationAddress: clean(body.locationAddress, 300),
    organizer,
    organizerEmail:  clean(body.organizerEmail, 200),
    externalLink:    clean(body.externalLink, 300) || null,
    newsletterOptIn: body.newsletterOptIn === true || body.newsletterOptIn === 'true',
  };

  try {
    const store = getConfiguredStore('green-book-events');
    await store.set(submission.id, JSON.stringify(submission));

    await sendSubmitterEmail(submission);
    await sendAdminEmail(submission);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: submission.id }) };
  } catch (err) {
    console.error('submit-event error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save your event submission. Please try again.' }) };
  }
};
