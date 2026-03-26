/**
 * inbound-email.js
 * Processes inbound email replies via Resend webhook.
 *
 * When a business owner replies to their submission email, this function
 * uses Claude to extract field values from their natural-language reply
 * and updates their Green Book submission.
 *
 * ─── Setup ─────────────────────────────────────────────────────────────────
 * 1. In Resend, add the domain "inbound.sappy-pappy.com" for inbound email.
 *    Add an MX record:  inbound.sappy-pappy.com → feedback-smtp.us-east-1.amazonses.com (or Resend's MX)
 *    (Resend's dashboard will show you the exact MX record to add.)
 * 2. Create a catch-all inbound route in Resend:
 *    Pattern: reply+*@inbound.sappy-pappy.com
 *    Webhook: https://sappy-pappy.com/.netlify/functions/inbound-email
 * 3. Set env var RESEND_INBOUND_SECRET to the webhook signing secret from Resend.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * POST /.netlify/functions/inbound-email
 * (called by Resend inbound webhook)
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

function clean(val, max = 500) {
  return String(val || '').trim().slice(0, max);
}

const ALLOWED_CATEGORIES = [
  'Travel & Lodging', 'Arts & Culture', 'Agriculture & Farming',
  'Food & Dining', 'Health & Wellness', 'Beauty & Style',
  'Professional Services', 'Retail & Shopping', 'Education',
  'Music & Entertainment', 'Finance & Legal', 'Real Estate',
  'Auto & Transportation', 'Technology & Media', 'Faith & Community',
];

const ALLOWED_CERTS = ['Black-owned', 'Woman-owned', 'Minority-owned', 'LGBTQ+-friendly', 'Veteran-owned'];

const headers = { 'Content-Type': 'application/json' };

/** Extract editToken from addresses like reply+TOKEN@inbound.sappy-pappy.com */
function extractToken(toAddresses) {
  if (!Array.isArray(toAddresses)) toAddresses = [toAddresses];
  for (const addr of toAddresses) {
    const m = String(addr).match(/reply\+([a-z0-9]+)@/i);
    if (m) return m[1];
  }
  return null;
}

/** Strip quoted reply text to get just the new content the user typed */
function stripQuotedReply(text) {
  // Remove lines starting with > (common email quoting)
  // Remove everything after common "On ... wrote:" patterns
  return text
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/\n?On .+wrote:[\s\S]*/i, '')
    .replace(/\n?-{3,}[\s\S]*/m, '') // strip separators
    .trim()
    .slice(0, 4000);
}

async function callClaude(apiKey, currentSubmission, replyText) {
  const missingFields = [];
  if (!currentSubmission.businessName) missingFields.push('businessName');
  if (!currentSubmission.category)     missingFields.push('category');
  if (!currentSubmission.description)  missingFields.push('description');
  if (!currentSubmission.phone)        missingFields.push('phone');
  if (!currentSubmission.location)     missingFields.push('location');
  if (!currentSubmission.hours)        missingFields.push('hours');
  if (!currentSubmission.imageUrl)     missingFields.push('imageUrl');
  if (!currentSubmission.instagram)    missingFields.push('instagram');
  if (!currentSubmission.facebook)     missingFields.push('facebook');
  if (!currentSubmission.twitter)      missingFields.push('twitter');
  if (!currentSubmission.linkedin)     missingFields.push('linkedin');

  const prompt = `A business owner replied to an email asking them to fill in missing details for their Green Book listing.

Current submission (may have empty fields):
${JSON.stringify({
  businessName: currentSubmission.businessName || null,
  category:     currentSubmission.category     || null,
  description:  currentSubmission.description  || null,
  phone:        currentSubmission.phone        || null,
  location:     currentSubmission.location     || null,
  hours:        currentSubmission.hours        || null,
  imageUrl:     currentSubmission.imageUrl     || null,
}, null, 2)}

Fields still missing: ${missingFields.join(', ') || '(none — but owner may be updating something)'}

Owner's reply:
"${replyText}"

Extract any field values from the owner's reply and return ONLY valid JSON — no explanation, just the object.
Only include fields that are clearly provided in the reply. Omit fields that are not mentioned.

{
  "businessName": "string or omit",
  "category": "one of the allowed categories or omit",
  "description": "string or omit",
  "phone": "string or omit",
  "location": "City, State format or omit",
  "hours": "string or omit",
  "imageUrl": "https://... url or omit",
  "tags": "comma-separated or omit",
  "instagram": "https://instagram.com/... or omit",
  "facebook": "https://facebook.com/... or omit",
  "twitter": "https://twitter.com/... or https://x.com/... or omit",
  "linkedin": "https://linkedin.com/... or omit",
  "certifications": ["Black-owned","Woman-owned","Minority-owned","LGBTQ+-friendly","Veteran-owned"] — array of any that apply, or omit
}

Allowed categories: ${ALLOWED_CATEGORIES.join(', ')}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

async function sendConfirmationEmail(resendKey, submission) {
  if (!resendKey || !submission.ownerEmail) return;
  const siteUrl = process.env.URL || 'https://sappy-pappy.com';
  const editUrl = `${siteUrl}/green-book-apply.html?edit=${submission.editToken}`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'The Green Book <noreply@sappy-pappy.com>',
        to: [submission.ownerEmail],
        subject: `📗 Got it! Your listing has been updated`,
        html: `
<h2 style="color:#2d7d46;font-family:sans-serif;">Thanks! We've updated your listing.</h2>
<p style="font-family:sans-serif;font-size:15px;">Hi ${submission.ownerName},</p>
<p style="font-family:sans-serif;font-size:15px;">
  We received your reply and updated your Green Book listing for <strong>${submission.businessName || 'your business'}</strong>.
</p>
<p style="font-family:sans-serif;font-size:15px;">
  You can always make further changes using your edit link:
</p>
<p style="text-align:center;margin:24px 0;">
  <a href="${editUrl}" style="background:#2d7d46;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;font-family:sans-serif;">
    Edit Your Listing →
  </a>
</p>
<p style="font-family:sans-serif;font-size:13px;color:#888;">
  Or copy this link: <a href="${editUrl}">${editUrl}</a>
</p>
        `,
      }),
    });
  } catch (err) {
    console.error('Confirmation email failed (non-fatal):', err.message);
  }
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey    = process.env.ANTHROPIC_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI not configured.' }) };
  }

  // Parse body — Resend sends JSON
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid payload' }) }; }

  // Extract editToken from the To address
  const toAddrs = body.to || body.To || [];
  const editToken = extractToken(toAddrs);

  if (!editToken) {
    console.error('inbound-email: no editToken found in To addresses:', toAddrs);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'no token' }) };
  }

  // Get email body text
  const replyText = stripQuotedReply(body.text || body.plain || body.html?.replace(/<[^>]+>/g, ' ') || '');
  if (!replyText) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'empty reply' }) };
  }

  const store = getConfiguredStore('green-book-submissions');

  // Load submission by editToken
  let submissionId, submission;
  try {
    const idRaw = await store.get('edittoken:' + editToken);
    if (!idRaw) {
      console.warn('inbound-email: editToken not found:', editToken);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'token not found' }) };
    }
    submissionId = idRaw.trim();
    const raw = await store.get(submissionId);
    if (!raw) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'submission not found' }) };
    }
    submission = JSON.parse(raw);
  } catch (err) {
    console.error('inbound-email: store error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Store error' }) };
  }

  // Don't update already-approved submissions via email (require admin review for edits)
  if (submission.status === 'approved') {
    console.log('inbound-email: submission already approved, skipping email update');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'approved' }) };
  }

  // Call Claude to parse the reply
  let updates = {};
  try {
    const raw = await callClaude(apiKey, submission, replyText);
    const match = raw.match(/\{[\s\S]+\}/);
    if (match) updates = JSON.parse(match[0]);
  } catch (err) {
    console.error('inbound-email: Claude parse error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI parsing failed' }) };
  }

  // Apply updates — only overwrite fields that were extracted
  const allowedUpdates = ['businessName', 'category', 'description', 'phone', 'location', 'hours', 'imageUrl', 'tags', 'instagram', 'facebook', 'twitter', 'linkedin', 'certifications'];
  const cleaned = {};
  for (const field of allowedUpdates) {
    if (updates[field] == null) continue;
    if (field === 'category' && !ALLOWED_CATEGORIES.includes(updates[field])) continue;
    if (field === 'certifications') {
      if (Array.isArray(updates[field])) {
        cleaned[field] = updates[field].filter(c => ALLOWED_CERTS.includes(c));
      }
      continue;
    }
    cleaned[field] = clean(updates[field], field === 'description' ? 600 : 500);
  }

  if (Object.keys(cleaned).length === 0) {
    console.log('inbound-email: no usable fields extracted from reply');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, skipped: 'nothing extracted' }) };
  }

  const updated = { ...submission, ...cleaned, updatedAt: new Date().toISOString(), lastEmailReply: new Date().toISOString() };

  try {
    await store.set(submissionId, JSON.stringify(updated));
    await sendConfirmationEmail(resendKey, updated);
    console.log(`inbound-email: updated submission ${submissionId} with fields:`, Object.keys(cleaned));
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, updated: Object.keys(cleaned) }) };
  } catch (err) {
    console.error('inbound-email: store write error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save updates' }) };
  }
};
