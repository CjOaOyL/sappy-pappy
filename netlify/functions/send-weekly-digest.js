/**
 * send-weekly-digest.js
 * Weekly Green Book newsletter: rotating business spotlight + upcoming events + full directory.
 *
 * Runs automatically every Monday at 9 AM UTC (configured in netlify.toml).
 * Can also be triggered manually from the admin panel:
 *   POST /.netlify/functions/send-weekly-digest
 *   Body: { password }
 *
 * Requires env vars: CONVERTKIT_API_SECRET, ADMIN_PASSWORD
 */

import { getStore } from '@netlify/blobs';
import { sendToKit } from './lib/newsletter.js';

// ── Store helper ──────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Picks the spotlight business by rotating weekly — same formula used on the site. */
function getWeekSpotlight(businesses) {
  if (!businesses.length) return null;
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  return businesses[weekNum % businesses.length];
}

/** Returns approved events starting within the next `days` days, up to 5. */
function getUpcomingEvents(events, days = 14) {
  const now    = Date.now();
  const cutoff = now + days * 24 * 60 * 60 * 1000;
  return events
    .filter(ev => {
      const t = new Date(ev.startDate).getTime();
      return t >= now && t <= cutoff;
    })
    .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))
    .slice(0, 5);
}

function formatEventDate(ev) {
  const d = new Date(ev.startDate);
  const date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  if (!ev.startTime) return date;
  const [h, m] = ev.startTime.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  return `${date} · ${((h % 12) || 12)}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ── Email builder ─────────────────────────────────────────────────────────────

function buildWeeklyEmail({ spotlight, events, businesses }) {
  const baseUrl    = 'https://sappy-pappy.com';
  const directoryUrl = `${baseUrl}/green-book.html`;
  const dateLabel  = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Spotlight section
  const spotlightHtml = spotlight ? `
    <tr><td style="padding:0 0 28px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#2d7d46;font-family:sans-serif;">Business Spotlight</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#eaf5ee;border-radius:10px;overflow:hidden;">
        <tr><td style="padding:24px 28px;">
          <p style="margin:0 0 4px;font-size:26px;">${esc(spotlight.icon || '🏪')}</p>
          <h2 style="margin:0 0 4px;font-size:22px;color:#f5c842;font-family:sans-serif;">${esc(spotlight.name)}</h2>
          <p style="margin:0 0 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#2d7d46;font-family:sans-serif;">${esc(spotlight.category)}</p>
          ${spotlight.location ? `<p style="margin:0 0 8px;font-size:14px;color:#555;">📍 ${esc(spotlight.location)}</p>` : ''}
          ${spotlight.ownerData?.name ? `<p style="margin:0 0 8px;font-size:14px;color:#555;">👤 ${esc(spotlight.ownerData.name)}</p>` : ''}
          <p style="margin:0 0 16px;font-size:15px;color:#333;line-height:1.6;">${esc(spotlight.desc)}</p>
          <a href="${directoryUrl}?biz=${esc(spotlight.id)}" style="display:inline-block;background:#1b5e35;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;font-family:sans-serif;">
            View Spotlight →
          </a>
        </td></tr>
      </table>
    </td></tr>` : '';

  // Upcoming events section
  const eventsHtml = events.length ? `
    <tr><td style="padding:0 0 28px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#2d7d46;font-family:sans-serif;">Upcoming Community Events</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;">
        ${events.map((ev, i) => `
        <tr><td style="padding:14px 20px;${i < events.length - 1 ? 'border-bottom:1px solid #f0f0f0;' : ''}background:#fff;">
          <p style="margin:0 0 2px;font-size:13px;font-weight:700;color:#1b5e35;font-family:sans-serif;">${esc(ev.title)}</p>
          <p style="margin:0;font-size:12px;color:#888;font-family:sans-serif;">${formatEventDate(ev)}${ev.location ? ` · ${esc(ev.location)}` : ''}</p>
        </td></tr>`).join('')}
      </table>
      <p style="margin:8px 0 0;font-size:12px;"><a href="${directoryUrl}#community-events" style="color:#2d7d46;">See all community events →</a></p>
    </td></tr>` : '';

  // Directory section — compact rows grouped roughly by category
  const directoryHtml = businesses.length ? `
    <tr><td style="padding:0 0 8px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#2d7d46;font-family:sans-serif;">The Full Directory (${businesses.length} listing${businesses.length !== 1 ? 's' : ''})</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-radius:10px;overflow:hidden;">
        ${businesses.map((biz, i) => `
        <tr><td style="padding:12px 18px;${i < businesses.length - 1 ? 'border-bottom:1px solid #f5f5f5;' : ''}background:#fff;">
          <span style="font-size:18px;vertical-align:middle;margin-right:8px;">${esc(biz.icon || '🏪')}</span>
          <a href="${directoryUrl}?biz=${esc(biz.id)}" style="font-weight:700;color:#1b5e35;text-decoration:none;font-family:sans-serif;font-size:14px;">${esc(biz.name)}</a>
          <span style="font-size:12px;color:#888;font-family:sans-serif;margin-left:6px;">${esc(biz.category)}${biz.location ? ` · ${esc(biz.location)}` : ''}</span>
        </td></tr>`).join('')}
      </table>
      <p style="margin:8px 0 0;text-align:center;font-size:13px;"><a href="${directoryUrl}" style="color:#2d7d46;font-weight:700;">Explore The Green Book →</a></p>
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#1b5e35;padding:28px 32px;">
          <p style="margin:0;font-size:11px;color:#a8d5b5;letter-spacing:1.5px;text-transform:uppercase;font-family:sans-serif;">The Green Book</p>
          <h1 style="margin:6px 0 4px;font-size:22px;color:#ffffff;font-family:sans-serif;">Community Update</h1>
          <p style="margin:0;font-size:13px;color:#a8d5b5;font-family:sans-serif;">${dateLabel}</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 32px 8px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            ${spotlightHtml}
            ${eventsHtml}
            ${directoryHtml}
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f0f0f0;padding:20px 32px;border-top:1px solid #e0e0e0;">
          <p style="margin:0;font-size:12px;color:#888;font-family:sans-serif;line-height:1.6;">
            You're receiving this because you subscribed to The Green Book newsletter at sappy-pappy.com.<br>
            <a href="{{ unsubscribe_url }}" style="color:#2d7d46;">Unsubscribe</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  const respHeaders = { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' };

  // Scheduled invocations have no httpMethod; manual POST requires admin password
  const isScheduled = !event.httpMethod;

  if (!isScheduled) {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: respHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: respHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword || !safeEqual(body.password || '', adminPassword)) {
      await new Promise(r => setTimeout(r, 500));
      return { statusCode: 401, headers: respHeaders, body: JSON.stringify({ error: 'Unauthorized' }) };
    }
  }

  try {
    // Load businesses and events in parallel
    const bizStore = getConfiguredStore('green-book-approved');
    const evtStore = getConfiguredStore('green-book-events-approved');

    const [bizBlobs, evtBlobs] = await Promise.all([
      bizStore.list().then(r => r.blobs).catch(() => []),
      evtStore.list().then(r => r.blobs).catch(() => []),
    ]);

    const [businesses, events] = await Promise.all([
      Promise.all(bizBlobs.map(async ({ key }) => {
        const raw = await bizStore.get(key).catch(() => null);
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      })).then(arr => arr.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name))),
      Promise.all(evtBlobs.map(async ({ key }) => {
        const raw = await evtStore.get(key).catch(() => null);
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      })).then(arr => arr.filter(Boolean)),
    ]);

    if (businesses.length === 0) {
      const msg = 'No approved businesses — weekly digest not sent.';
      console.log(msg);
      return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ ok: false, message: msg }) };
    }

    const spotlight = getWeekSpotlight(businesses);
    const upcoming  = getUpcomingEvents(events);
    const dateLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    const subject   = spotlight
      ? `The Green Book — ${dateLabel} · Spotlight: ${spotlight.name}`
      : `The Green Book — ${dateLabel} Community Update`;

    const html   = buildWeeklyEmail({ spotlight, events: upcoming, businesses });
    const result = await sendToKit({ subject, html, publish: true });

    if (!result.ok) {
      console.error('send-weekly-digest failed:', result.error);
      return { statusCode: 500, headers: respHeaders, body: JSON.stringify({ ok: false, error: result.error }) };
    }

    console.log('Weekly digest sent. Broadcast ID:', result.broadcast?.id);
    return { statusCode: 200, headers: respHeaders, body: JSON.stringify({ ok: true, broadcastId: result.broadcast?.id }) };

  } catch (err) {
    console.error('send-weekly-digest error:', err.message);
    return { statusCode: 500, headers: respHeaders, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
