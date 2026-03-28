/**
 * kit-status.js
 * Admin-only diagnostic endpoint: checks Kit account, subscribers, and form.
 *
 * POST /.netlify/functions/kit-status
 * Body: { password }
 */

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

async function kitGet(path, apiKey) {
  // Try v4 API first (keys starting with kit_), fall back to v3
  const isV4 = apiKey.startsWith('kit_');
  if (isV4) {
    const res = await fetch(`https://api.kit.com/v4/${path}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'X-Kit-Api-Key': apiKey },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data, apiVersion: 'v4' };
  }
  const res = await fetch(`https://api.convertkit.com/v3/${path}?api_key=${encodeURIComponent(apiKey)}`);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data, apiVersion: 'v3' };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'ADMIN_PASSWORD not set' }) };
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

  const apiKey  = process.env.CONVERTKIT_API_KEY;
  const formId  = process.env.CONVERTKIT_FORM_ID;
  const report  = { apiKey: !!apiKey, apiKeyPreview: apiKey ? apiKey.slice(0, 6) + '…' : null, apiKeyLength: apiKey?.length ?? 0, formId: formId || null };

  if (!apiKey) {
    return { statusCode: 200, headers, body: JSON.stringify({ report, error: 'CONVERTKIT_API_KEY is not set in Netlify env vars.' }) };
  }

  const isV4 = apiKey.startsWith('kit_');
  report.apiVersion = isV4 ? 'v4' : 'v3';

  // 1. Account info
  const accountPath = isV4 ? 'account' : 'account';
  const account = await kitGet(accountPath, apiKey);
  report.account = account.ok
    ? { name: account.data.name, email: account.data.email, plan: account.data.plan_type ?? account.data.plan }
    : { error: `Kit API returned ${account.status}`, detail: account.data };

  // 2. Subscriber count
  const subsPath = isV4 ? 'subscribers' : 'subscribers';
  const subs = await kitGet(subsPath, apiKey);
  report.subscribers = subs.ok
    ? {
        total: subs.data.total_subscribers ?? subs.data.pagination?.total ?? '(see raw)',
        raw: subs.data,
      }
    : { error: `Could not fetch subscribers (${subs.status})`, detail: subs.data };

  // 3. Forms list
  const forms = await kitGet('forms', apiKey);
  report.forms = forms.ok
    ? (forms.data.forms ?? forms.data)
    : { error: `Could not fetch forms (${forms.status})`, detail: forms.data };

  // 4. Check configured form specifically
  if (formId) {
    const formPath = isV4 ? `forms/${formId}/subscribers` : `forms/${formId}/subscriptions`;
    const formSubs = await kitGet(formPath, apiKey);
    report.configuredForm = formSubs.ok
      ? { formId, raw: formSubs.data }
      : { error: `Could not fetch form ${formId} (${formSubs.status})`, detail: formSubs.data };
  } else {
    report.configuredForm = { error: 'CONVERTKIT_FORM_ID is not set in Netlify env vars.' };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ report }) };
};
