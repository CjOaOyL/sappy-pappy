/**
 * get-availability.js
 * Fetches and merges iCal feeds from Airbnb, VRBO, and confirmed direct bookings.
 * iCal URLs are stored in env vars — never exposed to the browser.
 *
 * Sources merged:
 *   AIRBNB_ICAL_URL — Airbnb export calendar URL
 *   VRBO_ICAL_URL   — VRBO export calendar URL (optional, add when available)
 *   Direct bookings are also included from Netlify Blobs (confirmed status only)
 *
 * GET /.netlify/functions/get-availability
 * Returns: { blocked: [{ start: "YYYY-MM-DD", end: "YYYY-MM-DD", summary: "..." }] }
 */

const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
let cache = { data: null, ts: 0 };

function addDays(isoDate, days) {
  if (!isoDate || days === 0) return isoDate;
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

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

async function fetchICal(url, label) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'BlueBearCottage/1.0' } });
    if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`);
    const text = await res.text();
    return parseICal(text).map(e => ({ ...e, source: label }));
  } catch (err) {
    console.error(`fetchICal error (${label}):`, err.message);
    return [];
  }
}

export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=900',
  };

  // Serve from in-memory cache
  if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
    return { statusCode: 200, headers, body: JSON.stringify(cache.data) };
  }

  const today = new Date().toISOString().slice(0, 10);
  let allEvents = [];

  // Fetch Airbnb
  const airbnbUrl = process.env.AIRBNB_ICAL_URL;
  if (airbnbUrl) {
    allEvents.push(...await fetchICal(airbnbUrl, 'Airbnb'));
  }

  // Fetch VRBO (optional — add VRBO_ICAL_URL env var when available)
  const vrboUrl = process.env.VRBO_ICAL_URL;
  if (vrboUrl) {
    allEvents.push(...await fetchICal(vrboUrl, 'VRBO'));
  }

  // Include confirmed direct bookings from Netlify Blobs
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore('bluebear-bookings');
    const raw = await store.get('all');
    if (raw) {
      const bookings = JSON.parse(raw);
      const confirmed = bookings
        .filter(b => b.status === 'confirmed' && b.checkIn && b.checkOut)
        .map(b => ({ start: b.checkIn, end: b.checkOut, summary: 'Booked - Direct', source: 'Direct' }));
      allEvents.push(...confirmed);
    }
  } catch (err) {
    console.error('Direct bookings load error:', err.message);
  }

  if (allEvents.length === 0 && !airbnbUrl && !vrboUrl) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'No iCal sources configured', blocked: [] }),
    };
  }

  // Load buffer settings from pricing config
  let bufferBefore = 1;
  let bufferAfter = 1;
  try {
    const { getStore: getStoreB } = await import('@netlify/blobs');
    const pStore = getStoreB('bluebear-pricing');
    const pRaw = await pStore.get('config');
    if (pRaw) {
      const cfg = JSON.parse(pRaw);
      bufferBefore = Math.max(0, Math.min(7, Number(cfg.bufferBefore) ?? 1));
      bufferAfter  = Math.max(0, Math.min(7, Number(cfg.bufferAfter)  ?? 1));
    }
  } catch { /* use defaults */ }

  // Deduplicate core events, then add buffer blocks
  const seen = new Set();
  const coreBlocked = allEvents
    .filter(e => e.start && e.end && e.end >= today)
    .filter(e => {
      const key = `${e.start}|${e.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(e => ({ start: e.start, end: e.end, summary: e.summary || 'Booked', source: e.source, isBuffer: false }));

  // Expand each booking by buffer days (tagged as buffer so calendar can style differently)
  const bufferBlocks = [];
  if (bufferBefore > 0 || bufferAfter > 0) {
    for (const ev of coreBlocked) {
      if (bufferBefore > 0) {
        bufferBlocks.push({
          start: addDays(ev.start, -bufferBefore),
          end: ev.start,
          summary: 'Buffer',
          source: ev.source,
          isBuffer: true,
        });
      }
      if (bufferAfter > 0) {
        bufferBlocks.push({
          start: ev.end,
          end: addDays(ev.end, bufferAfter),
          summary: 'Buffer',
          source: ev.source,
          isBuffer: true,
        });
      }
    }
  }

  const blocked = [...coreBlocked, ...bufferBlocks].filter(e => e.end >= today);

  const data = { blocked, bufferBefore, bufferAfter, fetchedAt: new Date().toISOString() };
  cache = { data, ts: Date.now() };

  return { statusCode: 200, headers, body: JSON.stringify(data) };
};
