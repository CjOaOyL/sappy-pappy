/**
 * get-businesses-rss.js
 * RSS 2.0 feed of recently approved Green Book businesses.
 * Kit (ConvertKit) subscribes to this URL and auto-sends an email
 * whenever new items appear.
 *
 * GET /.netlify/functions/get-businesses-rss
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

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toRssDate(isoStr) {
  return new Date(isoStr).toUTCString();
}

function buildDescription(card) {
  const tags = Array.isArray(card.tags) && card.tags.length
    ? `<p><strong>Services:</strong> ${escapeXml(card.tags.join(', '))}</p>`
    : '';
  const location = card.location
    ? `<p>📍 ${escapeXml(card.location)}</p>`
    : '';
  const owner = card.ownerData?.name
    ? `<p>👤 Owner: ${escapeXml(card.ownerData.name)}${card.ownerData.blurb ? ' — ' + escapeXml(card.ownerData.blurb) : ''}</p>`
    : '';
  const website = card.url && card.url !== '#'
    ? `<p><a href="${escapeXml(card.url)}">Visit Website →</a></p>`
    : '';
  const listing = `<p><a href="https://sappy-pappy.com/green-book.html?biz=${escapeXml(card.id)}">View Full Listing →</a></p>`;

  return `<![CDATA[
<h2>${escapeXml(card.icon || '')} ${escapeXml(card.name)}</h2>
<p><strong>${escapeXml(card.category)}</strong></p>
${location}
<p>${escapeXml(card.desc)}</p>
${tags}
${owner}
${website}
${listing}
]]>`;
}

export const handler = async () => {
  const corsHeaders = {
    'Content-Type': 'application/rss+xml; charset=utf-8',
    'Cache-Control': 'public, max-age=900', // 15 min cache
    'Access-Control-Allow-Origin': '*',
  };

  try {
    const store = getConfiguredStore('green-book-approved');
    const { blobs } = await store.list();

    const cards = (await Promise.all(
      blobs.map(async ({ key }) => {
        const raw = await store.get(key).catch(() => null);
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      })
    ))
      .filter(Boolean)
      .sort((a, b) => new Date(b.approvedAt || b.updatedAt || 0) - new Date(a.approvedAt || a.updatedAt || 0))
      .slice(0, 20); // last 20 approved listings

    const lastBuild = cards.length > 0
      ? toRssDate(cards[0].approvedAt || cards[0].updatedAt)
      : new Date().toUTCString();

    const items = cards.map(card => `
  <item>
    <title>${escapeXml(card.name)} — ${escapeXml(card.category)}</title>
    <link>https://sappy-pappy.com/green-book.html?biz=${escapeXml(card.id)}</link>
    <description>${buildDescription(card)}</description>
    <pubDate>${toRssDate(card.approvedAt || card.updatedAt || new Date().toISOString())}</pubDate>
    <guid isPermaLink="false">greenbook-biz-${escapeXml(card.id)}@sappy-pappy.com</guid>
    ${card.url && card.url !== '#' ? `<source url="${escapeXml(card.url)}">${escapeXml(card.name)}</source>` : ''}
  </item>`).join('');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>The Green Book — New Listings</title>
    <link>https://sappy-pappy.com/green-book.html</link>
    <description>Newly approved Black-owned businesses on The Green Book at sappy-pappy.com</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="https://sappy-pappy.com/.netlify/functions/get-businesses-rss" rel="self" type="application/rss+xml"/>
    ${items}
  </channel>
</rss>`;

    return { statusCode: 200, headers: corsHeaders, body: rss };

  } catch (err) {
    console.error('get-businesses-rss error:', err);
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>The Green Book</title><link>https://sappy-pappy.com/green-book.html</link><description>The Green Book</description></channel></rss>`,
    };
  }
};
