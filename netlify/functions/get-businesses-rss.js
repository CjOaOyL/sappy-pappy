/**
 * get-businesses-rss.js — moved to jaquanslist.com. Permanent redirect so calendar
 * subscriptions, feed readers, and links in old emails keep working.
 */
export const handler = async (event) => {
  const qs = event.rawQuery ? `?${event.rawQuery}` : '';
  return {
    statusCode: 301,
    headers: { Location: `https://jaquanslist.com/.netlify/functions/get-businesses-rss${qs}`, 'Cache-Control': 'public, max-age=3600' },
    body: '',
  };
};
