/**
 * approve-business.js
 * Admin endpoint: list pending submissions, approve, or reject them.
 * Password-protected via ADMIN_PASSWORD env var.
 *
 * POST /.netlify/functions/approve-business
 * Body: { password, action: 'list' | 'approve' | 'reject', id?, rejectReason? }
 *
 * On approve: converts submission → business card and saves to green-book-approved store.
 * On reject:  marks submission as rejected (keeps record for audit).
 */

import { getStore } from '@netlify/blobs';

function getConfiguredStore(name) {
  const ctx = process.env.NETLIFY_BLOBS_CONTEXT;
  if (ctx) {
    try {
      const { siteID, token, url } = JSON.parse(Buffer.from(ctx, 'base64').toString('utf8'));
      const opts = { name, siteID, token };
      if (url) opts.url = url;
      return getStore(opts);
    } catch { /* fall through to auto-detect */ }
  }
  return getStore(name);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const CATEGORY_ICONS = {
  'Travel & Lodging':      '🏡',
  'Arts & Culture':        '🎨',
  'Agriculture & Farming': '🌿',
  'Food & Dining':         '🍽️',
  'Health & Wellness':     '💚',
  'Beauty & Style':        '✨',
  'Professional Services': '💼',
  'Retail & Shopping':     '🛍️',
  'Education':             '📚',
};

const CATEGORY_COLORS = {
  'Travel & Lodging':      '#4ecdc4',
  'Arts & Culture':        '#ff6b6b',
  'Agriculture & Farming': '#7dcf80',
  'Food & Dining':         '#ffd93d',
  'Health & Wellness':     '#9b6fc8',
  'Beauty & Style':        '#ff9eb5',
  'Professional Services': '#4e9af1',
  'Retail & Shopping':     '#f4a261',
  'Education':             '#2d7d46',
};

function submissionToCard(sub) {
  const tags = sub.tags
    ? sub.tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 8)
    : [];

  // Include certifications as tags
  if (Array.isArray(sub.certifications)) {
    sub.certifications.forEach(c => { if (!tags.includes(c)) tags.push(c); });
  }

  return {
    // Core card fields
    id:           sub.id,
    name:         sub.businessName,
    category:     sub.category,
    icon:         CATEGORY_ICONS[sub.category] || '🏪',
    image:        sub.imageUrl || null,
    tags,
    desc:         sub.description,
    location:     sub.location || null,
    phone:        sub.phone || null,
    hours:        sub.hours || null,
    rating:       0,
    reviewCount:  0,
    url:          sub.website || '#',
    external:     !!(sub.website),
    featured:     false,
    testimonial:  null,
    bannerColor:  CATEGORY_COLORS[sub.category] || '#2d7d46',

    // Owner — stored inline for dynamic cards
    ownerId: `owner-${sub.id}`,
    ownerData: {
      name:      sub.ownerName,
      photo:     sub.ownerPhoto || null,
      blurb:     sub.ownerBio || '',
      linkedin:  sub.linkedin  || null,
      instagram: sub.instagram || null,
      twitter:   sub.twitter   || null,
      facebook:  sub.facebook  || null,
      website:   sub.website   || null,
    },

    // Metadata
    approvedAt: new Date().toISOString(),
    submittedAt: sub.submittedAt,
  };
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD env var is not set in Netlify dashboard.' }) };
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

  const submissions = getConfiguredStore('green-book-submissions');
  const approved    = getConfiguredStore('green-book-approved');

  // ── LIST pending submissions ──────────────────────────────────────────────
  if (body.action === 'list') {
    try {
      const { blobs } = await submissions.list();
      const all = await Promise.all(blobs.map(async ({ key }) => {
        const raw = await submissions.get(key);
        try { return JSON.parse(raw); } catch { return null; }
      }));
      const pending = all.filter(s => s && s.status === 'pending');
      pending.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return { statusCode: 200, headers, body: JSON.stringify({ submissions: pending }) };
    } catch (err) {
      console.error('list error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list submissions' }) };
    }
  }

  // ── APPROVE ───────────────────────────────────────────────────────────────
  if (body.action === 'approve') {
    if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    try {
      const raw = await submissions.get(body.id);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Submission not found' }) };

      const sub = JSON.parse(raw);
      sub.status = 'approved';
      sub.approvedAt = new Date().toISOString();

      await submissions.set(body.id, JSON.stringify(sub));

      const card = submissionToCard(sub);
      await approved.set(body.id, JSON.stringify(card));

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, card }) };
    } catch (err) {
      console.error('approve error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to approve' }) };
    }
  }

  // ── REJECT ────────────────────────────────────────────────────────────────
  if (body.action === 'reject') {
    if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    try {
      const raw = await submissions.get(body.id);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Submission not found' }) };

      const sub = JSON.parse(raw);
      sub.status = 'rejected';
      sub.rejectedAt = new Date().toISOString();
      sub.rejectReason = String(body.rejectReason || '').trim().slice(0, 500);

      await submissions.set(body.id, JSON.stringify(sub));

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      console.error('reject error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject' }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('approve-business unhandled error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
