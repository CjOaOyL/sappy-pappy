/**
 * unsubscribe.js
 * One-click opt-out. No login, no confirmation step — legally the unsubscribe
 * must work immediately from a single click.
 *
 * GET  — person clicked the link in an email; returns an HTML page.
 * POST — Gmail/Outlook one-click unsubscribe (RFC 8058), triggered by the
 *        List-Unsubscribe-Post header; returns 200 with no body.
 */

import { connectBlobs } from './lib/blobs.js';
import { unsubscribe } from './lib/subscribers.js';
import { resultPage, HTML_HEADERS } from './lib/emails.js';

export const handler = async (event) => {
  connectBlobs(event);

  const email = event.queryStringParameters?.e || '';
  const token = event.queryStringParameters?.t || '';
  const isOneClickPost = event.httpMethod === 'POST';

  const page = (statusCode, heading, body, ok) => ({
    statusCode,
    headers: HTML_HEADERS,
    body: resultPage({ heading, body, ok }),
  });

  if (!email || !token) {
    if (isOneClickPost) return { statusCode: 400, body: '' };
    return page(400, 'Something went wrong', 'That unsubscribe link is incomplete. Please use the link at the bottom of the email.', false);
  }

  try {
    const result = await unsubscribe(email, token);

    // Mail clients expect a bare 200 and show their own confirmation.
    if (isOneClickPost) {
      return { statusCode: result.ok ? 200 : 400, body: '' };
    }

    if (result.ok && result.already) {
      return page(200, 'Already unsubscribed', "You're not on the list — no further emails will be sent to this address.", true);
    }
    if (result.ok) {
      return page(200, 'You\'ve been unsubscribed', "You won't receive any more Green Book emails. Sorry to see you go — you're welcome back any time.", true);
    }
    if (result.error === 'not_found') {
      return page(404, 'Address not found', "We couldn't find that address on our list, so there's nothing to unsubscribe.", false);
    }
    return page(400, 'Link not valid', 'That unsubscribe link is not valid. Please use the link at the bottom of a recent email.', false);

  } catch (err) {
    console.error('unsubscribe error:', err.message);
    if (isOneClickPost) return { statusCode: 500, body: '' };
    return page(500, 'Something went wrong', 'We hit an error processing that. Please try again shortly.', false);
  }
};
