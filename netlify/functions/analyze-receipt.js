/**
 * analyze-receipt.js
 * Sends a receipt image to Claude and returns extracted transaction metadata.
 *
 * POST /.netlify/functions/analyze-receipt
 * Body: { password, data: "<base64>", contentType: "image/jpeg|png|webp" }
 *   OR: { password, key: "rcpt-<id>.jpg" } to analyze an already-uploaded receipt
 *
 * Returns: { ok: true, extracted: { date, vendor, amount, category, description, items? } }
 */

import { getConfiguredStore, checkAuth, connectBlobs} from './lib/finance.js';

const EXPENSE_CATS = [
  'Rental Supplies','Rental Maintenance','Rental Utilities','Cleaning',
  'Furnishings','Repairs','Mortgage','Insurance','Property Tax',
  'Platform Fees','Marketing','Other',
];

const ALLOWED = ['image/jpeg','image/png','image/webp'];

async function loadKey(key) {
  if (!/^rcpt-[a-f0-9]+\.(jpg|png|webp)$/i.test(key)) return null;
  const store = getConfiguredStore('finance-receipts');
  const r = await store.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!r || !r.data) return null;
  const ct = r.metadata?.contentType || 'image/jpeg';
  return { data: Buffer.from(r.data).toString('base64'), contentType: ct };
}

export const handler = async (event) => {
  connectBlobs(event);
  const auth = await checkAuth(event);
  if (auth.error) return auth.error;
  const { body, headers } = auth;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI not configured' }) };

  let imgData = null, imgType = null;
  if (body.key) {
    const loaded = await loadKey(body.key);
    if (!loaded) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Receipt not found' }) };
    imgData = loaded.data; imgType = loaded.contentType;
  } else if (body.data && ALLOWED.includes(body.contentType)) {
    imgData = body.data; imgType = body.contentType;
  } else {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provide key or data+contentType' }) };
  }

  const prompt = `You are extracting transaction details from a receipt photo. Return ONLY valid JSON, no prose.

Shape:
{
  "date": "YYYY-MM-DD",       // receipt date if visible, else null
  "vendor": "string",         // store / merchant name
  "amount": number,           // grand total in dollars (after tax)
  "subtotal": number or null,
  "tax": number or null,
  "category": "one of: ${EXPENSE_CATS.join(', ')}",
  "description": "short summary of what was bought",
  "items": ["string", ...]    // up to 6 short item descriptions if visible
}

Pick the category that best matches a short-term rental business expense.
If a field isn't readable, set it to null. If amount can't be determined, set it to null.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imgType, data: imgData } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.error('analyze-receipt Claude err:', res.status, txt);
      return { statusCode: 502, headers, body: JSON.stringify({ error: `AI error ${res.status}` }) };
    }
    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    const match = raw.match(/\{[\s\S]+\}/);
    if (!match) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, extracted: null, raw }) };
    let extracted;
    try { extracted = JSON.parse(match[0]); }
    catch { return { statusCode: 200, headers, body: JSON.stringify({ ok: true, extracted: null, raw }) }; }

    if (extracted.category && !EXPENSE_CATS.includes(extracted.category)) {
      extracted.category = 'Other';
    }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, extracted }) };
  } catch (err) {
    console.error('analyze-receipt error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed' }) };
  }
};
