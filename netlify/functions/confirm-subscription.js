/**
 * confirm-subscription.js
 * Double opt-in landing point. Clicked from the confirmation email.
 *
 * GET /.netlify/functions/confirm-subscription?e=<email>&t=<token>
 * Returns an HTML page, not JSON — a human is looking at this.
 */

import { connectBlobs } from './lib/blobs.js';
import { confirm } from './lib/subscribers.js';
import { resultPage, HTML_HEADERS } from './lib/emails.js';

export const handler = async (event) => {
  connectBlobs(event);

  const email = event.queryStringParameters?.e || '';
  const token = event.queryStringParameters?.t || '';

  const page = (statusCode, heading, body, ok) => ({
    statusCode,
    headers: HTML_HEADERS,
    body: resultPage({ heading, body, ok }),
  });

  if (!email || !token) {
    return page(400, 'Something went wrong', 'That confirmation link is incomplete. Please use the button in the email we sent you.', false);
  }

  try {
    const result = await confirm(email, token);

    if (result.ok && result.already) {
      return page(200, "You're already subscribed", "Good news — you were already on the list. No further action needed.", true);
    }
    if (result.ok) {
      return page(200, "You're subscribed!", "Thanks for confirming. You'll get the community digest with new Black-owned business listings and upcoming events.", true);
    }

    if (result.error === 'suppressed') {
      return page(200, 'Unable to subscribe', 'This address can no longer be added to our list. If you think that\'s a mistake, please contact us.', false);
    }
    if (result.error === 'not_found') {
      return page(404, 'Link not recognised', "We couldn't find a pending signup for that address. Try subscribing again from The Green Book.", false);
    }
    return page(400, 'Link expired', 'That confirmation link is no longer valid. Please subscribe again to get a fresh one.', false);

  } catch (err) {
    console.error('confirm-subscription error:', err.message);
    return page(500, 'Something went wrong', 'We hit an error confirming your subscription. Please try again shortly.', false);
  }
};
