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
  const res = await fetch(`https://api.convertkit.com/v3/${path}?api_key=${encodeURIComponent(apiKey)}`);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
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
  const report  = { apiKey: !!apiKey, formId: formId || null };

  if (!apiKey) {
    return { statusCode: 200, headers, body: JSON.stringify({ report, error: 'CONVERTKIT_API_KEY is not set in Netlify env vars.' }) };
  }

  // 1. Account info
  const account = await kitGet('account', apiKey);
  report.account = account.ok
    ? { name: account.data.name, email: account.data.email, plan: account.data.plan_type }
    : { error: `Kit API returned ${account.status} — API key may be wrong.`, detail: account.data };

  // 2. Subscriber count
  const subs = await kitGet('subscribers', apiKey);
  report.subscribers = subs.ok
    ? { total: subs.data.total_subscribers, page: subs.data.subscribers?.length ?? 0, recent: subs.data.subscribers?.slice(0, 5).map(s => ({ email: s.email_address, created: s.created_at, state: s.state })) }
    : { error: `Could not fetch subscribers (${subs.status})`, detail: subs.data };

  // 3. Forms list
  const forms = await kitGet('forms', apiKey);
  report.forms = forms.ok
    ? forms.data.forms?.map(f => ({ id: f.id, name: f.name, type: f.type, subscriberCount: f.total_subscribers }))
    : { error: `Could not fetch forms (${forms.status})`, detail: forms.data };

  // 4. Check configured form specifically
  if (formId) {
    const formSubs = await kitGet(`forms/${formId}/subscriptions`, apiKey);
    report.configuredForm = formSubs.ok
      ? { formId, totalSubscriptions: formSubs.data.total_subscriptions, recent: formSubs.data.subscriptions?.slice(0, 5).map(s => ({ email: s.subscriber?.email_address, state: s.subscriber?.state, created: s.created_at })) }
      : { error: `Could not fetch subscriptions for form ${formId} (${formSubs.status})`, detail: formSubs.data };
  } else {
    report.configuredForm = { error: 'CONVERTKIT_FORM_ID is not set in Netlify env vars.' };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ report }) };
};
