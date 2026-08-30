/**
 * subscribe-newsletter.js
 * Standalone newsletter signup for The Green Book.
 *
 * POST /.netlify/functions/subscribe-newsletter
 * Body: { email, firstName? }
 *
 * Requires CONVERTKIT_API_KEY and CONVERTKIT_FORM_ID env vars.
 */

import { subscribeToKit } from './lib/newsletter.js';

const headers = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

  const email     = String(body.email || '').trim().toLowerCase();
  const firstName = String(body.firstName || '').trim().slice(0, 100);

  if (!isValidEmail(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'A valid email address is required.' }) };
  }

  const apiKey = process.env.CONVERTKIT_API_KEY;
  const formId = process.env.CONVERTKIT_FORM_ID;

  if (!apiKey || !formId) {
    console.error('CONVERTKIT_API_KEY or CONVERTKIT_FORM_ID not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Newsletter signup is not configured.' }) };
  }

  const result = await subscribeToKit(email, firstName);
  if (!result.ok) {
    console.error('subscribe-newsletter error:', result.error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to subscribe. Please try again.' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
