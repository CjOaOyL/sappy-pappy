/**
 * get-availability.js
 * Fetches and parses the Airbnb iCal feed, returns blocked date ranges as JSON.
 * The iCal URL is stored in the AIRBNB_ICAL_URL environment variable — never
 * exposed to the browser.
 *
 * GET /.netlify/functions/get-availability
 * Returns: { blocked: [{ start: "YYYY-MM-DD", end: "YYYY-MM-DD", summary: "..." }] }
 */

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let cache = { data: null, ts: 0 };

// Simple iCal parser — no external deps needed
function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let inEvent = false;
  let event = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      event = {};
    } else if (line === 'END:VEVENT') {
      inEvent = false;
      if (event.start && event.end) events.push(event);
    } else if (inEvent) {
      if (line.startsWith('DTSTART')) {
        event.start = icalDateToISO(line.split(':').slice(1).join(':'));
      } else if (line.startsWith('DTEND')) {
        event.end = icalDateToISO(line.split(':').slice(1).join(':'));
      } else if (line.startsWith('SUMMARY:')) {
        event.summary = line.slice(8).trim();
      }
    }
  }
  return events;
}

function icalDateToISO(str) {
  const s = str.trim().replace('Z', '');
  // Handle YYYYMMDD and YYYYMMDDTHHMMSS
  const d = s.replace(/T.*/, '');
  if (d.length === 8) {
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  return null;
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=900', // 15 min browser cache
  };

  // Serve from in-memory cache
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
  }

  const icalUrl = process.env.AIRBNB_ICAL_URL;
  if (!icalUrl) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'iCal URL not configured' }),
    };
  }

  try {
    const res = await fetch(icalUrl, {
      headers: { 'User-Agent': 'BlueBearCottage/1.0' },
    });
    if (!res.ok) throw new Error(`iCal fetch failed: ${res.status}`);

    const text = await res.text();
    const events = parseICal(text);

    // Filter to future events only, exclude "Not available" blocks far in the past
    const today = new Date().toISOString().slice(0, 10);
    const blocked = events
      .filter(e => e.end >= today)
      .map(e => ({ start: e.start, end: e.end, summary: e.summary || 'Booked' }));

    const data = { blocked, fetchedAt: new Date().toISOString() };
    cache = { data, ts: Date.now() };

    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (err) {
    console.error('get-availability error:', err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'Could not fetch availability', blocked: [] }),
    };
  }
};
