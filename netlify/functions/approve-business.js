/**
 * approve-business.js
 * Admin endpoint: list pending submissions, approve, or reject them.
 * Also handles owner edit requests for approved listings.
 * Password-protected via ADMIN_PASSWORD env var.
 *
 * POST /.netlify/functions/approve-business
 * Body: { password, action, id?, rejectReason? }
 *
 * Actions:
 *   'list'         — List all pending new submissions.
 *   'approve'      — Approve a new submission → save to green-book-approved store.
 *   'reject'       — Reject a new submission.
 *   'list-edits'   — List pending edit requests for approved listings.
 *   'approve-edit' — Apply an edit request to the live approved listing.
 *   'reject-edit'  — Reject an edit request (mark as rejected, no change to live listing).
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
  'Music & Entertainment': '🎵',
  'Finance & Legal':       '⚖️',
  'Real Estate':           '🏠',
  'Auto & Transportation': '🚗',
  'Technology & Media':    '💻',
  'Faith & Community':     '✦',
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
  'Music & Entertainment': '#7c3aed',
  'Finance & Legal':       '#1d4ed8',
  'Real Estate':           '#0891b2',
  'Auto & Transportation': '#c2410c',
  'Technology & Media':    '#0f766e',
  'Faith & Community':     '#6d28d9',
};

function submissionToCard(sub, existingCard = null) {
  const tags = sub.tags
    ? sub.tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 8)
    : [];

  if (Array.isArray(sub.certifications)) {
    sub.certifications.forEach(c => { if (!tags.includes(c)) tags.push(c); });
  }

  return {
    // Preserve existing card metadata if updating
    rating:      existingCard?.rating      ?? 0,
    reviewCount: existingCard?.reviewCount ?? 0,
    featured:    existingCard?.featured    ?? false,
    testimonial: existingCard?.testimonial ?? null,
    approvedAt:  existingCard?.approvedAt  ?? new Date().toISOString(),

    // Always update from submission
    id:       sub.id || sub.originalId,
    name:     sub.businessName,
    category: sub.category,
    icon:     CATEGORY_ICONS[sub.category] || '🏪',
    image:    sub.imageUrl || null,
    tags,
    desc:     sub.description,
    location: sub.location || null,
    phone:    sub.phone || null,
    hours:    sub.hours || null,
    url:      sub.website || '#',
    external: !!(sub.website),
    bannerColor: CATEGORY_COLORS[sub.category] || '#2d7d46',

    ownerId: `owner-${sub.id || sub.originalId}`,
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

    updatedAt:   new Date().toISOString(),
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

  const submissions = getConfiguredStore('green-book-submissions');
  const approved    = getConfiguredStore('green-book-approved');

  // ── LIST pending new submissions ──────────────────────────────────────────
  if (body.action === 'list') {
    try {
      const { blobs } = await submissions.list();
      const all = await Promise.all(blobs.map(async ({ key }) => {
        // Skip index keys
        if (key.startsWith('edittoken:')) return null;
        const raw = await submissions.get(key);
        try { return JSON.parse(raw); } catch { return null; }
      }));
      const pending = all.filter(s => s && s.status === 'pending' && s.type !== 'edit-request');
      pending.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return { statusCode: 200, headers, body: JSON.stringify({ submissions: pending }) };
    } catch (err) {
      console.error('list error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list submissions' }) };
    }
  }

  // ── LIST pending edit requests ────────────────────────────────────────────
  if (body.action === 'list-edits') {
    try {
      const { blobs } = await submissions.list();
      const all = await Promise.all(blobs.map(async ({ key }) => {
        if (key.startsWith('edittoken:')) return null;
        const raw = await submissions.get(key);
        try { return JSON.parse(raw); } catch { return null; }
      }));
      const edits = all.filter(s => s && s.type === 'edit-request' && s.status === 'pending');
      edits.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return { statusCode: 200, headers, body: JSON.stringify({ edits }) };
    } catch (err) {
      console.error('list-edits error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to list edit requests' }) };
    }
  }

  // ── APPROVE new submission ────────────────────────────────────────────────
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

  // ── APPROVE edit request ──────────────────────────────────────────────────
  if (body.action === 'approve-edit') {
    if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    try {
      const raw = await submissions.get(body.id);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Edit request not found' }) };

      const editReq = JSON.parse(raw);
      if (editReq.type !== 'edit-request') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Not an edit request' }) };
      }

      // Load the existing approved card to preserve rating, featured, etc.
      const existingRaw = await approved.get(editReq.originalId);
      const existingCard = existingRaw ? JSON.parse(existingRaw) : null;

      // Build updated card, using originalId as the card ID
      const updatedCard = submissionToCard(
        { ...editReq, id: editReq.originalId },
        existingCard
      );
      await approved.set(editReq.originalId, JSON.stringify(updatedCard));

      // Mark edit request as approved
      editReq.status = 'approved';
      editReq.approvedAt = new Date().toISOString();
      await submissions.set(body.id, JSON.stringify(editReq));

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, card: updatedCard }) };
    } catch (err) {
      console.error('approve-edit error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to approve edit' }) };
    }
  }

  // ── REJECT new submission ─────────────────────────────────────────────────
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

  // ── REJECT edit request ───────────────────────────────────────────────────
  if (body.action === 'reject-edit') {
    if (!body.id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing id' }) };
    try {
      const raw = await submissions.get(body.id);
      if (!raw) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Edit request not found' }) };

      const editReq = JSON.parse(raw);
      editReq.status = 'rejected';
      editReq.rejectedAt = new Date().toISOString();
      editReq.rejectReason = String(body.rejectReason || '').trim().slice(0, 500);

      await submissions.set(body.id, JSON.stringify(editReq));

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      console.error('reject-edit error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to reject edit' }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };

  } catch (err) {
    console.error('approve-business unhandled error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
