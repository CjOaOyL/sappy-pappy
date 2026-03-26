/**
 * analyze-website.js
 * Fetches a business website and uses Claude to extract structured business info.
 *
 * POST /.netlify/functions/analyze-website
 * Body: { website: "https://..." }
 * Returns: { ok, data: { businessName, category, description, phone, location, hours,
 *             imageUrl, tags, instagram, facebook, twitter, linkedin, certifications } }
 *
 * Requires env var: ANTHROPIC_API_KEY
 */

const ALLOWED_CATEGORIES = [
  'Travel & Lodging', 'Arts & Culture', 'Agriculture & Farming',
  'Food & Dining', 'Health & Wellness', 'Beauty & Style',
  'Professional Services', 'Retail & Shopping', 'Education',
  'Music & Entertainment', 'Finance & Legal', 'Real Estate',
  'Auto & Transportation', 'Technology & Media', 'Faith & Community',
];

const ALLOWED_CERTS = ['Black-owned', 'Woman-owned', 'Minority-owned', 'LGBTQ+-friendly', 'Veteran-owned'];

const MAX_HTML_CHARS = 35000;

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

function extractMetaData(html) {
  const meta = {};
  const get = (pattern) => { const m = html.match(pattern); return m ? m[1].trim() : null; };

  meta.title       = get(/<title[^>]*>([^<]{1,200})<\/title>/i);
  meta.description = get(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})["']/i)
                  || get(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
  meta.ogTitle     = get(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i);
  meta.ogDesc      = get(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{1,500})["']/i);
  meta.ogImage     = get(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']{1,500})["']/i);
  meta.phone       = get(/(?:tel:|href=["']tel:)([+\d\s().–-]{7,20})/i);

  return meta;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_HTML_CHARS);
}

async function callClaude(apiKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text || '';
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI analysis not configured on this server.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { website } = body;
  if (!website) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Website URL is required.' }) };
  }

  let siteUrl;
  try {
    siteUrl = new URL(website);
    if (!['http:', 'https:'].includes(siteUrl.protocol)) throw new Error('bad protocol');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid URL (include https://).' }) };
  }

  // Fetch the website
  let html = '';
  let meta = {};
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 12000);
    const fetchRes = await fetch(siteUrl.href, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GreenBookBot/1.0; +https://sappy-pappy.com)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    });
    clearTimeout(t);
    if (fetchRes.ok) {
      const ct = fetchRes.headers.get('content-type') || '';
      if (ct.includes('text/html') || ct.includes('text/plain') || ct === '') {
        html = await fetchRes.text();
      }
    }
  } catch (err) {
    console.warn('Website fetch failed (non-fatal):', err.message);
  }

  if (html) meta = extractMetaData(html);
  const pageText = html ? htmlToText(html) : '';

  const prompt = `You are analyzing a business website to populate a listing in The Green Book, a directory of Black-owned and Black-adjacent businesses.

Website URL: ${siteUrl.href}
${meta.title    ? `Page Title: ${meta.title}` : ''}
${meta.ogTitle  ? `OG Title: ${meta.ogTitle}` : ''}
${meta.description ? `Meta Description: ${meta.description}` : ''}
${meta.ogDesc   ? `OG Description: ${meta.ogDesc}` : ''}
${meta.ogImage  ? `OG Image URL: ${meta.ogImage}` : ''}
${meta.phone    ? `Phone found in page: ${meta.phone}` : ''}

Page text:
${pageText || '(Could not fetch page — infer what you can from the URL)'}

Extract business info and return ONLY valid JSON — no markdown, no explanation, just the JSON object:

{
  "businessName": "Business name or null",
  "category": "Exactly one of [Travel & Lodging, Arts & Culture, Agriculture & Farming, Food & Dining, Health & Wellness, Beauty & Style, Professional Services, Retail & Shopping, Education, Music & Entertainment, Finance & Legal, Real Estate, Auto & Transportation, Technology & Media, Faith & Community] or null",
  "description": "1–4 sentence description of what the business does and who it serves (80–400 chars) or null",
  "phone": "Phone number or null",
  "location": "City and state only, e.g. Atlanta, GA or null",
  "hours": "Business hours string or null",
  "imageUrl": "Direct URL (must start https://) to the business logo, hero image, or og:image already listed above. Do NOT fabricate or guess image URLs. null if not found.",
  "tags": "Up to 6 comma-separated keywords describing this business or null",
  "instagram": "Full URL https://instagram.com/... or null",
  "facebook": "Full URL https://facebook.com/... or null",
  "twitter": "Full URL https://twitter.com/... or https://x.com/... or null",
  "linkedin": "Full URL https://linkedin.com/... or null",
  "certifications": []
}

Rules:
- Only include info you are confident about from the text above. Use null for anything unclear.
- For imageUrl: only use URLs literally found in the HTML above (og:image or visible img src attributes). Never invent a URL.
- certifications array may contain any of: "Black-owned", "Woman-owned", "Minority-owned", "LGBTQ+-friendly", "Veteran-owned" — only if clearly stated on the site.`;

  let extracted;
  try {
    const raw = await callClaude(apiKey, prompt);
    const match = raw.match(/\{[\s\S]+\}/);
    if (!match) throw new Error('No JSON in Claude response');
    extracted = JSON.parse(match[0]);
  } catch (err) {
    console.error('Claude analysis error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data: {}, partial: true, error: 'AI could not analyze this site — please fill in details manually.' }) };
  }

  // Sanitize
  if (extracted.category && !ALLOWED_CATEGORIES.includes(extracted.category)) extracted.category = null;
  for (const f of ['imageUrl', 'instagram', 'facebook', 'twitter', 'linkedin']) {
    if (extracted[f]) { try { new URL(extracted[f]); } catch { extracted[f] = null; } }
  }
  if (!Array.isArray(extracted.certifications)) extracted.certifications = [];
  extracted.certifications = extracted.certifications.filter(c => ALLOWED_CERTS.includes(c));

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data: extracted }) };
};
