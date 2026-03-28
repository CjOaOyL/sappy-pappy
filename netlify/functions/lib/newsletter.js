/**
 * lib/newsletter.js
 * Shared newsletter logic for The Green Book auto-announcements.
 *
 * Requires env vars:
 *   CONVERTKIT_API_SECRET  — for creating/sending broadcasts
 *   ANTHROPIC_API_KEY      — for AI-generated content
 */

import { getStore } from '@netlify/blobs';

// ── Store helpers ────────────────────────────────────────────────────────────

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

// ── Settings ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled:        true,
  mode:           'immediate',   // 'immediate' | 'digest'
  digestInterval: 'weekly',      // 'daily' | 'weekly' | 'monthly'
  autoSend:       true,          // true = send immediately; false = save as draft
  lastSentAt:     null,
  pending:        [],            // business IDs queued for next digest
};

export async function getSettings() {
  try {
    const store = getConfiguredStore('green-book-settings');
    const raw   = await store.get('newsletter-settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  const store = getConfiguredStore('green-book-settings');
  await store.set('newsletter-settings', JSON.stringify(settings));
}

// ── Pending digest queue ──────────────────────────────────────────────────────

export async function addToPending(businessId) {
  const settings = await getSettings();
  if (!settings.pending.includes(businessId)) {
    settings.pending.push(businessId);
    await saveSettings(settings);
  }
}

// ── Content generation (Claude) ───────────────────────────────────────────────

export async function generateContent(card) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const icon = card.icon || '🏪';
  const tags = Array.isArray(card.tags) ? card.tags.join(', ') : '';

  const prompt = `Write a short, warm newsletter announcement for a newly listed Black-owned business on The Green Book, a community directory. Keep it to 2 short paragraphs in HTML (use only <p> tags — no headings or other elements). Tone: celebratory, community-focused, welcoming.

Business details:
- Name: ${card.name}
- Category: ${card.category}
- Description: ${card.desc}
- Location: ${card.location || 'Not specified'}
${tags ? `- Tags/Services: ${tags}` : ''}
${card.ownerData?.blurb ? `- About the owner: ${card.ownerData.blurb}` : ''}

Return only the two <p> tags, no extra text.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

// ── Email HTML builder ────────────────────────────────────────────────────────

export function buildEmailHtml({ card, bodyHtml, subject }) {
  const icon        = card.icon || '🏪';
  const listingUrl  = `https://sappy-pappy.com/green-book.html`;
  const tags        = Array.isArray(card.tags) ? card.tags : [];

  const tagsHtml = tags.length
    ? `<p style="margin:0 0 12px;">${tags.map(t =>
        `<span style="display:inline-block;background:#eaf5ee;color:#1b5e35;border-radius:20px;padding:3px 10px;font-size:12px;margin:2px 3px;">${escapeHtml(t)}</span>`
      ).join('')}</p>`
    : '';

  const locationLine = card.location
    ? `<p style="margin:0 0 8px;font-size:14px;color:#555;">📍 ${escapeHtml(card.location)}</p>`
    : '';

  const ownerLine = card.ownerData?.name
    ? `<p style="margin:0 0 8px;font-size:14px;color:#555;">👤 ${escapeHtml(card.ownerData.name)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:#1b5e35;padding:28px 32px;">
          <p style="margin:0;font-size:13px;color:#a8d5b5;letter-spacing:1px;text-transform:uppercase;font-family:sans-serif;">The Green Book</p>
          <h1 style="margin:6px 0 0;font-size:22px;color:#ffffff;font-family:sans-serif;">New Addition to the Directory</h1>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px;">
          ${bodyHtml || ''}

          <!-- Listing card -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#eaf5ee;border-radius:10px;margin:24px 0;overflow:hidden;">
            <tr><td style="padding:20px 24px;">
              <p style="margin:0 0 4px;font-size:22px;">${icon}</p>
              <h2 style="margin:0 0 6px;font-size:20px;color:#f5c842;font-family:sans-serif;">${escapeHtml(card.name)}</h2>
              <p style="margin:0 0 10px;font-size:13px;color:#2d7d46;font-family:sans-serif;font-weight:bold;text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(card.category)}</p>
              ${locationLine}
              ${ownerLine}
              <p style="margin:0 0 14px;font-size:15px;color:#333;line-height:1.6;">${escapeHtml(card.desc)}</p>
              ${tagsHtml}
              <a href="${listingUrl}" style="display:inline-block;background:#1b5e35;color:#ffffff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;font-family:sans-serif;">View Listing →</a>
            </td></tr>
          </table>

          <p style="margin:0;font-size:14px;color:#666;line-height:1.6;">
            Support Black-owned businesses in our community. Share this listing with someone who might love it.
          </p>
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

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Kit broadcast API ─────────────────────────────────────────────────────────

/**
 * Create a Kit broadcast.
 * @param {object} opts
 * @param {string} opts.subject
 * @param {string} opts.html
 * @param {boolean} opts.publish  — true = send immediately; false = save as draft
 */
export async function sendToKit({ subject, html, publish = true }) {
  const apiSecret = process.env.CONVERTKIT_API_SECRET;
  if (!apiSecret) {
    console.error('CONVERTKIT_API_SECRET not set — cannot send newsletter');
    return { ok: false, error: 'CONVERTKIT_API_SECRET not set' };
  }

  const payload = {
    api_secret:   apiSecret,
    subject,
    content:      html,
    description:  subject,
  };

  if (publish) {
    payload.published_at = new Date().toISOString();
  }

  try {
    const res = await fetch('https://api.convertkit.com/v3/broadcasts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('Kit broadcast error:', data);
      return { ok: false, error: data.message || `Kit error ${res.status}` };
    }
    return { ok: true, broadcast: data.broadcast };
  } catch (err) {
    console.error('sendToKit error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Digest helpers ────────────────────────────────────────────────────────────

export function isDigestDue(settings) {
  if (!settings.lastSentAt) return true;
  const last     = new Date(settings.lastSentAt).getTime();
  const now      = Date.now();
  const intervals = { daily: 86400000, weekly: 604800000, monthly: 2592000000 };
  const ms = intervals[settings.digestInterval] || intervals.weekly;
  return now - last >= ms;
}

// ── Main entry point called by approve-business.js ───────────────────────────

/**
 * Called immediately after a business is approved.
 * Respects mode (immediate vs digest) and autoSend settings.
 */
export async function handleNewsletterOnApproval(card) {
  let settings;
  try {
    settings = await getSettings();
  } catch (err) {
    console.error('newsletter: failed to load settings:', err.message);
    return;
  }

  if (!settings.enabled) return;

  if (settings.mode === 'digest') {
    // Queue for next digest
    await addToPending(card.id).catch(err =>
      console.error('newsletter: failed to queue pending:', err.message)
    );
    return;
  }

  // Immediate mode — generate content and send/draft
  try {
    const aiBody = await generateContent(card);
    const fallback = `<p>We're excited to welcome a new listing to The Green Book — ${escapeHtml(card.name)}! Check out this ${escapeHtml(card.category)} business and show them some love.</p>`;
    const bodyHtml = aiBody || fallback;

    const subject = `New on The Green Book: ${card.name}`;
    const html    = buildEmailHtml({ card, bodyHtml, subject });

    await sendToKit({ subject, html, publish: settings.autoSend });
  } catch (err) {
    console.error('newsletter: handleNewsletterOnApproval error:', err.message);
  }
}

// ── Digest send (called from newsletter-settings.js) ─────────────────────────

export async function sendDigest() {
  const settings = await getSettings();
  if (!settings.pending || settings.pending.length === 0) {
    return { ok: false, error: 'No pending businesses to include.' };
  }

  // Load each approved card
  const approvedStore = getConfiguredStore('green-book-approved');
  const cards = [];
  for (const id of settings.pending) {
    try {
      const raw = await approvedStore.get(id);
      if (raw) cards.push(JSON.parse(raw));
    } catch { /* skip */ }
  }

  if (cards.length === 0) {
    return { ok: false, error: 'Could not load any pending businesses.' };
  }

  const count = cards.length;
  const subject = count === 1
    ? `New on The Green Book: ${cards[0].name}`
    : `${count} New Listings on The Green Book`;

  // Build a digest HTML with each card
  let bodyHtml = `<p>We have ${count} new addition${count > 1 ? 's' : ''} to share with you from The Green Book community directory!</p>`;

  for (const card of cards) {
    const icon  = card.icon || '🏪';
    const tags  = Array.isArray(card.tags) ? card.tags : [];
    const tagsHtml = tags.length
      ? `<p style="margin:0 0 10px;">${tags.map(t =>
          `<span style="display:inline-block;background:#d6eedc;color:#1b5e35;border-radius:20px;padding:2px 9px;font-size:11px;margin:2px;">${escapeHtml(t)}</span>`
        ).join('')}</p>`
      : '';

    bodyHtml += `
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#eaf5ee;border-radius:10px;margin:16px 0;overflow:hidden;">
        <tr><td style="padding:18px 22px;">
          <p style="margin:0 0 4px;font-size:20px;">${icon}</p>
          <h2 style="margin:0 0 4px;font-size:18px;color:#f5c842;font-family:sans-serif;">${escapeHtml(card.name)}</h2>
          <p style="margin:0 0 8px;font-size:12px;color:#2d7d46;font-family:sans-serif;font-weight:bold;text-transform:uppercase;">${escapeHtml(card.category)}</p>
          ${card.location ? `<p style="margin:0 0 6px;font-size:13px;color:#555;">📍 ${escapeHtml(card.location)}</p>` : ''}
          <p style="margin:0 0 10px;font-size:14px;color:#333;line-height:1.5;">${escapeHtml(card.desc)}</p>
          ${tagsHtml}
        </td></tr>
      </table>`;
  }

  bodyHtml += `<p style="margin-top:20px;">Visit <a href="https://sappy-pappy.com/green-book.html" style="color:#1b5e35;">The Green Book</a> to explore all listings.</p>`;

  // Wrap in full email template using first card for header (digest has its own layout)
  const html = buildDigestEmailHtml({ subject, bodyHtml });

  const result = await sendToKit({ subject, html, publish: settings.autoSend });

  if (result.ok) {
    settings.pending    = [];
    settings.lastSentAt = new Date().toISOString();
    await saveSettings(settings);
  }

  return result;
}

function buildDigestEmailHtml({ subject, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 16px;">
    <tr><td>
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr><td style="background:#1b5e35;padding:28px 32px;">
          <p style="margin:0;font-size:13px;color:#a8d5b5;letter-spacing:1px;text-transform:uppercase;font-family:sans-serif;">The Green Book</p>
          <h1 style="margin:6px 0 0;font-size:22px;color:#ffffff;font-family:sans-serif;">${escapeHtml(subject)}</h1>
        </td></tr>
        <tr><td style="padding:32px;">
          ${bodyHtml}
        </td></tr>
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
