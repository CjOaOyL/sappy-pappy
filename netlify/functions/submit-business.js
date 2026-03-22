/**
 * submit-business.js
 * Receives a new Green Book business submission, stores it as pending
 * in Netlify Blobs, and sends an email notification to the site owner.
 *
 * POST /.netlify/functions/submit-business
 * Body: { businessName, category, description, ownerName, ownerEmail, ... }
 * Returns: { ok: true, id: string } or { error: string }
 *
 * Email notifications require RESEND_API_KEY env var (optional — submission
 * still saves if missing, just no email is sent).
 * Set NOTIFY_EMAIL to override the default notification address.
 */

import { getStore } from '@netlify/blobs';

function getConfiguredStore(name) {
  // 1. Try NETLIFY_BLOBS_CONTEXT (auto-injected by Netlify runtime)
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
  // 2. Manually configured env vars (set in Netlify dashboard)
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token  = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) return getStore({ name, siteID, token });
  // 3. Last resort — throws if runtime context unavailable
  return getStore(name);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function clean(val, max = 500) {
  return String(val || '').trim().slice(0, max);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidUrl(url) {
  if (!url) return true; // optional fields
  try { new URL(url); return true; } catch { return false; }
}

const ALLOWED_CATEGORIES = [
  'Travel & Lodging', 'Arts & Culture', 'Agriculture & Farming',
  'Food & Dining', 'Health & Wellness', 'Beauty & Style',
  'Professional Services', 'Retail & Shopping', 'Education',
  'Music & Entertainment', 'Finance & Legal', 'Real Estate',
  'Auto & Transportation', 'Technology & Media', 'Faith & Community',
];

const ALLOWED_CERTS = [
  'Black-owned', 'Woman-owned', 'Minority-owned', 'LGBTQ+-friendly', 'Veteran-owned',
];

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Honeypot — bots fill hidden fields
  if (body._hp) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  // Required field validation
  const required = { businessName: 'Business name', category: 'Category', description: 'Description', ownerName: 'Your name', ownerEmail: 'Your email' };
  for (const [field, label] of Object.entries(required)) {
    if (!body[field]?.toString().trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `${label} is required.` }) };
    }
  }

  if (!ALLOWED_CATEGORIES.includes(body.category)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid category.' }) };
  }

  if (!isValidEmail(body.ownerEmail)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email address.' }) };
  }

  for (const urlField of ['website', 'imageUrl', 'ownerPhoto', 'linkedin', 'instagram', 'twitter', 'facebook']) {
    if (body[urlField] && !isValidUrl(body[urlField])) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid URL for ${urlField}.` }) };
    }
  }

  const certifications = Array.isArray(body.certifications)
    ? body.certifications.filter(c => ALLOWED_CERTS.includes(c))
    : [];

  const submission = {
    id: uid(),
    status: 'pending',
    submittedAt: new Date().toISOString(),

    // Business
    businessName:    clean(body.businessName, 100),
    category:        clean(body.category, 60),
    description:     clean(body.description, 600),
    pitch:           clean(body.pitch, 1200),
    tags:            clean(body.tags, 300),
    website:         clean(body.website, 300),
    phone:           clean(body.phone, 30),
    location:        clean(body.location, 120),
    hours:           clean(body.hours, 300),
    imageUrl:        clean(body.imageUrl, 500),
    yearsInBusiness: clean(body.yearsInBusiness, 40),
    certifications,

    // Owner
    ownerName:  clean(body.ownerName, 100),
    ownerEmail: clean(body.ownerEmail, 200),
    ownerPhoto: clean(body.ownerPhoto, 500),
    ownerBio:   clean(body.ownerBio, 1000),
    linkedin:   clean(body.linkedin, 300),
    instagram:  clean(body.instagram, 300),
    twitter:    clean(body.twitter, 300),
    facebook:   clean(body.facebook, 300),
  };

  try {
    const store = getConfiguredStore('green-book-submissions');
    await store.set(submission.id, JSON.stringify(submission));

    // Email notification (optional — requires RESEND_API_KEY)
    const resendKey = process.env.RESEND_API_KEY;
    const notifyEmail = process.env.NOTIFY_EMAIL || 'hello@sappy-pappy.com';

    if (resendKey) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'The Green Book <noreply@sappy-pappy.com>',
            to: [notifyEmail],
            subject: `📗 New Green Book Submission: ${submission.businessName}`,
            html: `
<h2 style="color:#2d7d46;">New Business Submission — The Green Book</h2>
<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:15px;">
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Business</td><td style="padding:6px 12px;">${submission.businessName}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Category</td><td style="padding:6px 12px;">${submission.category}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Location</td><td style="padding:6px 12px;">${submission.location || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Website</td><td style="padding:6px 12px;">${submission.website ? `<a href="${submission.website}">${submission.website}</a>` : '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Tags</td><td style="padding:6px 12px;">${submission.tags || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Certifications</td><td style="padding:6px 12px;">${submission.certifications.join(', ') || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Years in business</td><td style="padding:6px 12px;">${submission.yearsInBusiness || '—'}</td></tr>
  <tr><td colspan="2" style="padding:10px 12px;"><strong>Description:</strong><br/>${submission.description}</td></tr>
  <tr><td colspan="2" style="padding:10px 12px;background:#fffbea;"><strong>Why they should be included:</strong><br/>${submission.pitch || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Owner</td><td style="padding:6px 12px;">${submission.ownerName}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Owner Email</td><td style="padding:6px 12px;">${submission.ownerEmail}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Owner Bio</td><td style="padding:6px 12px;">${submission.ownerBio || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">LinkedIn</td><td style="padding:6px 12px;">${submission.linkedin || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Instagram</td><td style="padding:6px 12px;">${submission.instagram || '—'}</td></tr>
</table>
<br/>
<p style="font-size:13px;color:#666;">Submission ID: <code>${submission.id}</code> &bull; ${submission.submittedAt}</p>
<p><a href="https://sappy-pappy.com/green-book.html?admin=1" style="background:#2d7d46;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Review in Admin Panel →</a></p>
            `,
          }),
        });
      } catch (emailErr) {
        console.error('Email notification failed (non-fatal):', emailErr.message);
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: submission.id }) };
  } catch (err) {
    console.error('submit-business error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save your submission. Please try again.' }) };
  }
};
