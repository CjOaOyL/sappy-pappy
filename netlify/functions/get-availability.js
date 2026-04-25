/**
 * get-availability.js
 * Fetches and merges iCal feeds + direct bookings for a given property.
 *
 * GET /.netlify/functions/get-availability?property=bluebear|hikercabin|both
 *   bluebear   — Blue Bear Cottage (AIRBNB_ICAL_URL, VRBO_ICAL_URL, bluebear-bookings)
 *   hikercabin — Hiker Delight Homestead Cabin (HIKERCABIN_AIRBNB_ICAL_URL, hikercabin-bookings)
 *   both       — Union of both (any blocked date on either property is blocked)
 *
 * Returns: { blocked: [{ start, end, summary, source, isBuffer }], bufferBefore, bufferAfter }
 */

const CACHE_TTL_MS = 15 * 60 * 1000;
const caches = {
  bluebear:   { data: null, ts: 0 },
  hikercabin: { data: null, ts: 0 },
  both:       { data: null, ts: 0 },
};

function addDays(isoDate, days) {
  if (!isoDate || days === 0) return isoDate;
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseICal(text) {
  const events = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let inEvent = false;
  let event = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { inEvent = true; event = {}; }
    else if (line === 'END:VEVENT') {
      inEvent = false;
      if (event.start && event.end) events.push(event);
    } else if (inEvent) {
      if (line.startsWith('DTSTART')) event.start = icalDateToISO(line.split(':').slice(1).join(':'));
      else if (line.startsWith('DTEND'))   event.end   = icalDateToISO(line.split(':').slice(1).join(':'));
      else if (line.startsWith('SUMMARY:')) event.summary = line.slice(8).trim();
    }
  }
  return events;
}

function icalDateToISO(str) {
  const s = str.trim().replace('Z', '');
  const d = s.replace(/T.*/, '');
  if (d.length === 8) return `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}`;
  return null;
}

async function fetchICal(url, label) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'SappyPappy/1.0' } });
    if (!res.ok) throw new Error(`${label} fetch failed: ${res.status}`);
    const text = await res.text();
    return parseICal(text).map(e => ({ ...e, source: label }));
  } catch (err) {
    console.error(`fetchICal error (${label}):`, err.message);
    return [];
  }
}

async function loadDirectBookings(storeName) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(storeName);
    const raw = await store.get('all');
    if (!raw) return [];
    const bookings = JSON.parse(raw);
    return bookings
      .filter(b => b.status === 'confirmed' && b.checkIn && b.checkOut)
      .map(b => ({ start: b.checkIn, end: b.checkOut, summary: 'Booked - Direct', source: 'Direct' }));
  } catch (err) {
    console.error(`loadDirectBookings error (${storeName}):`, err.message);
    return [];
  }
}

async function loadBufferConfig(storeName) {
  try {
    const { getStore } = await import('@netlify/blobs');
    const store = getStore(storeName);
    const raw = await store.get('config');
    if (raw) {
      const cfg = JSON.parse(raw);
      return {
        bufferBefore: Math.max(0, Math.min(7, Number(cfg.bufferBefore) ?? 1)),
        bufferAfter:  Math.max(0, Math.min(7, Number(cfg.bufferAfter)  ?? 1)),
      };
    }
  } catch { /* use defaults */ }
  return { bufferBefore: 1, bufferAfter: 1 };
}

function buildBlocked(allEvents, bufferBefore, bufferAfter, today) {
  const seen = new Set();
  const core = allEvents
    .filter(e => e.start && e.end && e.end >= today)
    .filter(e => {
      const key = `${e.start}|${e.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(e => ({ start: e.start, end: e.end, summary: e.summary || 'Booked', source: e.source, isBuffer: false }));

  const buffers = [];
  for (const ev of core) {
    if (bufferBefore > 0) buffers.push({ start: addDays(ev.start, -bufferBefore), end: ev.start,           summary: 'Buffer', source: ev.source, isBuffer: true });
    if (bufferAfter > 0)  buffers.push({ start: ev.end,                           end: addDays(ev.end, bufferAfter), summary: 'Buffer', source: ev.source, isBuffer: true });
  }

  return [...core, ...buffers].filter(e => e.end >= today);
}

async function fetchPropertyAvail(prop, today) {
  let allEvents = [];
  let pricingStore;

  if (prop === 'bluebear') {
    const airbnbUrl = process.env.AIRBNB_ICAL_URL;
    if (airbnbUrl) allEvents.push(...await fetchICal(airbnbUrl, 'Airbnb'));
    const vrboUrl = process.env.VRBO_ICAL_URL;
    if (vrboUrl) allEvents.push(...await fetchICal(vrboUrl, 'VRBO'));
    allEvents.push(...await loadDirectBookings('bluebear-bookings'));
    pricingStore = 'bluebear-pricing';
  } else {
    const cabinUrl = process.env.HIKERCABIN_AIRBNB_ICAL_URL;
    if (cabinUrl) allEvents.push(...await fetchICal(cabinUrl, 'Airbnb'));
    allEvents.push(...await loadDirectBookings('hikercabin-bookings'));
    pricingStore = 'hikercabin-pricing';
  }

  const { bufferBefore, bufferAfter } = await loadBufferConfig(pricingStore);
  const blocked = buildBlocked(allEvents, bufferBefore, bufferAfter, today);
  return { blocked, bufferBefore, bufferAfter, fetchedAt: new Date().toISOString() };
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=900',
  };

  const prop = event?.queryStringParameters?.property || 'bluebear';
  if (!['bluebear', 'hikercabin', 'both'].includes(prop)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid property', blocked: [] }) };
  }

  const propCache = caches[prop];
  if (propCache.data && Date.now() - propCache.ts < CACHE_TTL_MS) {
    return { statusCode: 200, headers, body: JSON.stringify(propCache.data) };
  }

  const today = new Date().toISOString().slice(0, 10);
  let data;

  if (prop === 'both') {
    const [bb, hc] = await Promise.all([
      fetchPropertyAvail('bluebear', today),
      fetchPropertyAvail('hikercabin', today),
    ]);
    data = {
      blocked: [...bb.blocked, ...hc.blocked],
      bufferBefore: Math.max(bb.bufferBefore, hc.bufferBefore),
      bufferAfter:  Math.max(bb.bufferAfter,  hc.bufferAfter),
      fetchedAt: new Date().toISOString(),
    };
  } else {
    data = await fetchPropertyAvail(prop, today);
  }

  caches[prop] = { data, ts: Date.now() };
  return { statusCode: 200, headers, body: JSON.stringify(data) };
};
