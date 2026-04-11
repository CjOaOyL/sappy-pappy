/**
 * submit-business.js
 * Handles Green Book business submissions and owner self-service edits.
 *
 * POST /.netlify/functions/submit-business
 *
 * Actions (passed in body.action):
 *   (none)     — Create a new submission. Returns { ok, id, editToken }.
 *   'get'      — Retrieve a submission by editToken. Returns { submission }.
 *   'update'   — Owner updates their submission using editToken.
 *                If pending → updates in place.
 *                If approved → creates a pending edit-request for admin review.
 *                Returns { ok }.
 *
 * Email notifications require RESEND_API_KEY env var (optional).
 * Set NOTIFY_EMAIL to override the default notification address.
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

import { randomUUID } from 'crypto';

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

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

function buildSubmissionFields(body) {
  const certifications = Array.isArray(body.certifications)
    ? body.certifications.filter(c => ALLOWED_CERTS.includes(c))
    : [];

  // If businessName is blank, fall back to the website domain
  let businessName = clean(body.businessName, 100);
  if (!businessName && body.website) {
    try { businessName = new URL(body.website).hostname.replace(/^www\./, ''); } catch { /* noop */ }
  }

  return {
    businessName,
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
    ownerName:       clean(body.ownerName, 100),
    ownerEmail:      clean(body.ownerEmail, 200),
    ownerPhoto:      clean(body.ownerPhoto, 500),
    ownerBio:        clean(body.ownerBio, 1000),
    linkedin:        clean(body.linkedin, 300),
    instagram:       clean(body.instagram, 300),
    twitter:         clean(body.twitter, 300),
    facebook:        clean(body.facebook, 300),
    newsletterOptIn: body.newsletterOptIn === true,
  };
}

function getMissingFields(submission) {
  const checks = [
    ['businessName', 'Business name'],
    ['category',     'Category'],
    ['description',  'Business description'],
    ['phone',        'Phone number'],
    ['location',     'City & state'],
    ['hours',        'Business hours'],
    ['imageUrl',     'Business photo/logo URL'],
    ['instagram',    'Instagram'],
    ['facebook',     'Facebook'],
  ];
  return checks.filter(([field]) => !submission[field]).map(([, label]) => label);
}

async function sendOwnerEmail(submission, editUrl) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  const missing = getMissingFields(submission);
  const replyTo = `reply+${submission.editToken}@inbound.sappy-pappy.com`;

  const missingSection = missing.length > 0 ? `
<div style="background:#fffbea;border:2px solid #c89b2a;border-radius:8px;padding:14px 18px;margin:20px 0;font-family:sans-serif;">
  <p style="font-size:14px;font-weight:bold;margin:0 0 8px;">⚠️ A few things are still missing from your listing:</p>
  <ul style="margin:0;padding-left:18px;font-size:14px;">
    ${missing.map(f => `<li>${f}</li>`).join('\n    ')}
  </ul>
  <p style="font-size:14px;margin:10px 0 0;">
    <strong>Just reply to this email</strong> with the missing info — our AI will read your reply and fill everything in automatically.
    Or use the edit link below to update your listing directly.
  </p>
</div>` : `
<p style="font-family:sans-serif;font-size:15px;color:#2d7d46;">
  ✅ Your listing looks complete! We'll review it shortly.
</p>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Green Book <noreply@sappy-pappy.com>',
        reply_to: replyTo,
        to: [submission.ownerEmail],
        subject: `📗 Your Green Book listing — ${submission.businessName || 'submission received'}`,
        html: `
<h2 style="color:#2d7d46;font-family:sans-serif;">You're in the queue!</h2>
<p style="font-family:sans-serif;font-size:15px;">Hi ${submission.ownerName},</p>
<p style="font-family:sans-serif;font-size:15px;">
  We've received your listing for <strong>${submission.businessName || 'your business'}</strong>.
  We typically review within 48 hours.
</p>
${missingSection}
<p style="font-family:sans-serif;font-size:15px;">
  You can also update your listing at any time using your personal edit link:
</p>
<p style="text-align:center;margin:24px 0;">
  <a href="${editUrl}" style="background:#2d7d46;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;font-family:sans-serif;">
    Edit Your Listing →
  </a>
</p>
<p style="font-family:sans-serif;font-size:13px;color:#888;">
  Or copy this link: <a href="${editUrl}">${editUrl}</a>
</p>
<p style="font-family:sans-serif;font-size:13px;color:#888;">
  Save this email — it's the only way to access your personal edit link.
</p>
        `,
      }),
    });
  } catch (emailErr) {
    console.error('Owner email failed (non-fatal):', emailErr.message);
  }
}

async function sendAdminEmail(submission) {
  const resendKey = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.NOTIFY_EMAIL || 'hello@sappy-pappy.com';
  if (!resendKey) return;
  try {
    const isEdit = submission.type === 'edit-request';
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Green Book <noreply@sappy-pappy.com>',
        to: [notifyEmail],
        subject: isEdit
          ? `📝 Edit Request: ${submission.businessName}`
          : `📗 New Green Book Submission: ${submission.businessName}`,
        html: `
<h2 style="color:#2d7d46;">${isEdit ? 'Edit Request' : 'New Business Submission'} — The Green Book</h2>
${isEdit ? `<p style="background:#fffbea;padding:8px 12px;border-radius:6px;font-family:sans-serif;font-size:14px;">⚠️ This is an edit request for an already-approved listing (ID: <code>${submission.originalId}</code>).</p>` : ''}
<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:15px;">
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Business</td><td style="padding:6px 12px;">${submission.businessName}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Category</td><td style="padding:6px 12px;">${submission.category}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Owner</td><td style="padding:6px 12px;">${submission.ownerName}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#e8f5ec;">Owner Email</td><td style="padding:6px 12px;">${submission.ownerEmail}</td></tr>
  <tr><td colspan="2" style="padding:10px 12px;"><strong>Description:</strong><br/>${submission.description}</td></tr>
</table>
<br/>
<p><a href="https://sappy-pappy.com/green-book.html?admin=1" style="background:#2d7d46;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Review in Admin Panel →</a></p>
        `,
      }),
    });
  } catch (emailErr) {
    console.error('Admin email failed (non-fatal):', emailErr.message);
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

  const store = getConfiguredStore('green-book-submissions');

  // ── REQUEST REMOVAL ───────────────────────────────────────────────────────
  if (body.action === 'request-removal') {
    if (!body.editToken) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing edit token.' }) };
    }
    try {
      const idRaw = await store.get('edittoken:' + body.editToken);
      if (!idRaw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Edit link not found.' }) };
      }
      const submissionId = idRaw.trim();
      const raw = await store.get(submissionId);
      if (!raw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Submission not found.' }) };
      }
      const submission = JSON.parse(raw);

      // Send removal request email to admin
      const resendKey   = process.env.RESEND_API_KEY;
      const notifyEmail = process.env.NOTIFY_EMAIL || 'hello@sappy-pappy.com';
      if (resendKey) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'The Green Book <noreply@sappy-pappy.com>',
            to: [notifyEmail],
            subject: `🗑️ Removal Request: ${submission.businessName || 'Unknown Business'}`,
            html: `
<h2 style="color:#dc2626;font-family:sans-serif;">Listing Removal Request</h2>
<p style="font-family:sans-serif;font-size:15px;">A business owner has requested their listing be removed from The Green Book.</p>
<table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:15px;">
  <tr><td style="padding:6px 12px;font-weight:bold;background:#fee2e2;">Business</td><td style="padding:6px 12px;">${submission.businessName || '—'}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#fee2e2;">Owner Name</td><td style="padding:6px 12px;">${submission.ownerName}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#fee2e2;">Owner Email</td><td style="padding:6px 12px;">${submission.ownerEmail}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#fee2e2;">Submission ID</td><td style="padding:6px 12px;font-size:.85rem;">${submissionId}</td></tr>
  <tr><td style="padding:6px 12px;font-weight:bold;background:#fee2e2;">Status</td><td style="padding:6px 12px;">${submission.status}</td></tr>
</table>
<p style="font-family:sans-serif;font-size:13px;color:#888;margin-top:16px;">
  To complete removal, delete submission ID <code>${submissionId}</code> from your Netlify Blobs store.
</p>
            `,
          }),
        });
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      console.error('request-removal error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to send removal request.' }) };
    }
  }

  // ── GET submission by editToken ───────────────────────────────────────────
  if (body.action === 'get') {
    if (!body.editToken) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing edit token.' }) };
    }
    try {
      const idRaw = await store.get('edittoken:' + body.editToken);
      if (!idRaw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Edit link not found or expired.' }) };
      }
      const submissionId = idRaw.trim();
      const raw = await store.get(submissionId);
      if (!raw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Submission not found.' }) };
      }
      const submission = JSON.parse(raw);
      // Strip editToken from response
      const { editToken: _et, ...safeSubmission } = submission;
      return { statusCode: 200, headers, body: JSON.stringify({ submission: safeSubmission }) };
    } catch (err) {
      console.error('get submission error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load submission.' }) };
    }
  }

  // ── UPDATE submission by editToken ───────────────────────────────────────
  if (body.action === 'update') {
    if (!body.editToken) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing edit token.' }) };
    }

    if (!body.ownerName?.toString().trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Your name is required.' }) };
    }
    if (!isValidEmail(body.ownerEmail)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email address is required.' }) };
    }
    if (body.category && !ALLOWED_CATEGORIES.includes(body.category)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid category.' }) };
    }
    for (const urlField of ['website', 'imageUrl', 'ownerPhoto', 'linkedin', 'instagram', 'twitter', 'facebook']) {
      if (body[urlField] && !isValidUrl(body[urlField])) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid URL for ${urlField}.` }) };
      }
    }

    try {
      const idRaw = await store.get('edittoken:' + body.editToken);
      if (!idRaw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Edit link not found or expired.' }) };
      }
      const submissionId = idRaw.trim();
      const raw = await store.get(submissionId);
      if (!raw) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Submission not found.' }) };
      }

      const existing = JSON.parse(raw);
      const fields = buildSubmissionFields(body);

      if (existing.status === 'approved') {
        // Approved listing: create an edit-request for admin review
        const editRequest = {
          id: 'edit-' + uid(),
          type: 'edit-request',
          status: 'pending',
          originalId: existing.id,
          submittedAt: new Date().toISOString(),
          ...fields,
        };
        await store.set(editRequest.id, JSON.stringify(editRequest));
        await sendAdminEmail(editRequest);
      } else {
        // Pending/rejected: update in place
        const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
        await store.set(submissionId, JSON.stringify(updated));
      }

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      console.error('update submission error:', err);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update submission.' }) };
    }
  }

  // ── CREATE new submission ─────────────────────────────────────────────────
  if (!body.ownerName?.toString().trim()) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Your name is required.' }) };
  }
  if (!isValidEmail(body.ownerEmail)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email address is required.' }) };
  }
  if (body.category && !ALLOWED_CATEGORIES.includes(body.category)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid category.' }) };
  }
  for (const urlField of ['website', 'imageUrl', 'ownerPhoto', 'linkedin', 'instagram', 'twitter', 'facebook']) {
    if (body[urlField] && !isValidUrl(body[urlField])) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Invalid URL for ${urlField}.` }) };
    }
  }

  const submissionId = uid();
  const editToken    = uid();

  const submission = {
    id: submissionId,
    editToken,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    ...buildSubmissionFields(body),
  };

  try {
    await store.set(submissionId, JSON.stringify(submission));
    await store.set('edittoken:' + editToken, submissionId);

    const siteUrl = process.env.URL || 'https://sappy-pappy.com';
    const editUrl = `${siteUrl}/green-book-apply.html?edit=${editToken}`;

    await sendOwnerEmail(submission, editUrl);
    await sendAdminEmail(submission);

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: submissionId, editToken }) };
  } catch (err) {
    console.error('submit-business error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save your submission. Please try again.' }) };
  }
};
