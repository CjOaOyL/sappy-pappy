/**
 * submit-booking.js
 * Handles booking submissions for Blue Bear Cottage, Hiker Delight Homestead Cabin,
 * or both together (bundle — 25% off the cabin nightly rate).
 *
 * POST /.netlify/functions/submit-booking
 * Body: { name, email, phone, checkIn, checkOut, guests, message, honeypot,
 *         property: "bluebear"|"hikercabin"|"both" }
 *
 * Bundle bookings create two linked records (one per store) joined by bundleId.
 */

import { getStore } from '@netlify/blobs';
import { DEFAULT_CONFIG, CABIN_DEFAULT_CONFIG } from './get-pricing.js';

const BUNDLE_CABIN_DISCOUNT = 0.25; // 25% off cabin nightly rate when booking both

function addDays(isoDate, days) {
  if (!isoDate || days === 0) return isoDate;
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function checkConflict(checkIn, checkOut, existingBookings, bufferBefore, bufferAfter) {
  for (const b of existingBookings) {
    if (b.status !== 'confirmed') continue;
    const actualOverlap = checkIn < b.checkOut && checkOut > b.checkIn;
    if (actualOverlap) return 'conflict';
    const bufferedStart = addDays(b.checkIn,  -bufferBefore);
    const bufferedEnd   = addDays(b.checkOut,  bufferAfter);
    const bufferOverlap = checkIn < bufferedEnd && checkOut > bufferedStart;
    if (bufferOverlap) return 'buffer';
  }
  return null;
}

function generateId(prefix = 'BB') {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

function generateBundleId() {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BUNDLE-${ts}-${rand}`;
}

async function loadBookings(storeName) {
  try {
    const store = getStore(storeName);
    const raw = await store.get('all');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function saveBookings(storeName, bookings) {
  try {
    const store = getStore(storeName);
    await store.set('all', JSON.stringify(bookings));
  } catch (err) {
    console.error('saveBookings error:', err);
  }
}

const rateLimitMap = new Map();
const RATE_LIMIT    = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip) {
  const now  = Date.now();
  const hits = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) return true;
  hits.push(now);
  rateLimitMap.set(ip, hits);
  return false;
}

function sanitizeStr(val, max = 200) {
  return String(val || '').replace(/[<>"'`]/g, '').trim().slice(0, max);
}

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function isValidDate(d)  { return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)); }

function daysBetween(start, end) {
  return Math.round((new Date(end) - new Date(start)) / 86400000);
}

function isWeekend(dateStr) {
  const day = new Date(dateStr + 'T12:00:00').getDay();
  return day === 5 || day === 6;
}

function mmddInRange(mmdd, start, end) {
  if (start <= end) return mmdd >= start && mmdd <= end;
  return mmdd >= start || mmdd <= end;
}

function nightRate(dateStr, config) {
  if (dateStr in config.overrides) return config.overrides[dateStr]; // null = blocked
  const mmdd = dateStr.slice(5);
  for (const s of config.seasons || []) {
    if (mmddInRange(mmdd, s.startMMDD, s.endMMDD)) {
      return s.rate + (isWeekend(dateStr) ? config.weekendPremium : 0);
    }
  }
  return config.baseRate + (isWeekend(dateStr) ? config.weekendPremium : 0);
}

function calculateTotal(checkIn, checkOut, config) {
  const nights = daysBetween(checkIn, checkOut);
  let roomTotal = 0;
  const breakdown = [];
  const d = new Date(checkIn + 'T12:00:00');
  for (let i = 0; i < nights; i++) {
    const ds   = d.toISOString().slice(0, 10);
    const rate = nightRate(ds, config);
    if (rate === null) return null;
    breakdown.push({ date: ds, rate });
    roomTotal += rate;
    d.setDate(d.getDate() + 1);
  }
  const cleaning = config.cleaningFee || 0;
  const tax      = Math.round(roomTotal * (config.taxRate || 0)) / 100;
  return { nights, roomTotal, cleaning, tax, total: roomTotal + cleaning + tax, breakdown };
}

async function loadConfig(storeName, defaultCfg) {
  try {
    const store = getStore(storeName);
    const raw = await store.get('config');
    if (raw) return { ...defaultCfg, ...JSON.parse(raw) };
  } catch { /* use defaults */ }
  return defaultCfg;
}

async function sendOwnerNotification(booking, pricing, property) {
  const propertyName = property === 'hikercabin' ? 'Hiker Delight Homestead Cabin' : 'Blue Bear Cottage';
  const smtpUser  = process.env.SMTP_USER;
  const smtpPass  = process.env.SMTP_PASS;
  const ownerEmail = process.env.OWNER_EMAIL || 'levonsvacation@gmail.com';

  if (!smtpUser || !smtpPass) {
    console.log(`=== NEW BOOKING REQUEST [${propertyName}] ===`);
    console.log(JSON.stringify(booking, null, 2));
    return;
  }

  const subject = booking.bufferConflict
    ? `⚠️ BUFFER CONFLICT — ${propertyName}: ${booking.checkIn} to ${booking.checkOut}`
    : `New Booking Request — ${propertyName}: ${booking.checkIn} to ${booking.checkOut}`;
  console.log('Email would send to:', ownerEmail, '\nSubject:', subject);
}

export const handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ip = event.headers['x-forwarded-for']?.split(',')[0] || event.headers['client-ip'] || 'unknown';
  if (isRateLimited(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please try again later.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  if (body.honeypot) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const prop = body.property || 'bluebear';
  if (!['bluebear', 'hikercabin', 'both'].includes(prop)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid property' }) };
  }

  // Validate common fields
  const name    = sanitizeStr(body.name, 100);
  const email   = sanitizeStr(body.email, 100);
  const phone   = sanitizeStr(body.phone, 30);
  const checkIn  = sanitizeStr(body.checkIn  || body.checkin,  10);
  const checkOut = sanitizeStr(body.checkOut || body.checkout, 10);
  const guests  = Math.min(20, Math.max(1, parseInt(body.guests) || 1));
  const message = sanitizeStr(body.message, 1000);

  if (!name || name.length < 2) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter your name.' }) };
  if (!isValidEmail(email))     return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please enter a valid email address.' }) };
  if (!isValidDate(checkIn) || !isValidDate(checkOut)) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please select valid check-in and check-out dates.' }) };
  if (checkIn >= checkOut)      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Check-out must be after check-in.' }) };

  const today = new Date().toISOString().slice(0, 10);
  if (checkIn < today)          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Check-in date cannot be in the past.' }) };

  // ── BUNDLE BOOKING ──────────────────────────────────────────────────────────
  if (prop === 'both') {
    const [bbConfig, hcConfig] = await Promise.all([
      loadConfig('bluebear-pricing',   DEFAULT_CONFIG),
      loadConfig('hikercabin-pricing', CABIN_DEFAULT_CONFIG),
    ]);

    // Check minimum stay against the stricter of the two
    const nights = daysBetween(checkIn, checkOut);
    const minStay = Math.max(bbConfig.minimumStay, hcConfig.minimumStay);
    if (nights < minStay) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: `Minimum stay is ${minStay} nights.` }) };
    }

    // Check availability in both stores
    const [bbBookings, hcBookings] = await Promise.all([
      loadBookings('bluebear-bookings'),
      loadBookings('hikercabin-bookings'),
    ]);
    const bbConflict = checkConflict(checkIn, checkOut, bbBookings, bbConfig.bufferBefore ?? 1, bbConfig.bufferAfter ?? 1);
    const hcConflict = checkConflict(checkIn, checkOut, hcBookings, hcConfig.bufferBefore ?? 1, hcConfig.bufferAfter ?? 1);

    if (bbConflict === 'conflict' || hcConflict === 'conflict') {
      const which = bbConflict === 'conflict' ? 'Blue Bear Cottage' : 'Hiker Delight Cabin';
      return { statusCode: 409, headers, body: JSON.stringify({ error: `${which} is not available for those dates. Please select different dates.` }) };
    }

    const bbPricing = calculateTotal(checkIn, checkOut, bbConfig);
    const hcPricing = calculateTotal(checkIn, checkOut, hcConfig);
    if (!bbPricing || !hcPricing) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'One or more selected dates is not available.' }) };
    }

    // 25% off cabin nightly rate
    const cabinDiscount   = Math.round(hcPricing.roomTotal * BUNDLE_CABIN_DISCOUNT * 100) / 100;
    const hcDiscountedTotal = hcPricing.roomTotal - cabinDiscount + hcPricing.cleaning + hcPricing.tax;
    const bundleTotal     = bbPricing.total + hcDiscountedTotal;

    const bundleId   = generateBundleId();
    const bufferConflict = bbConflict === 'buffer' || hcConflict === 'buffer';
    const status     = bufferConflict ? 'buffer_conflict' : 'pending';
    const now        = new Date().toISOString();

    const bbBooking = {
      id: generateId('BB'), bundleId, property: 'bluebear',
      name, email, phone, checkIn, checkOut, guests, message,
      total: bbPricing.total, nights: bbPricing.nights, status, bufferConflict, submittedAt: now,
    };
    const hcBooking = {
      id: generateId('HC'), bundleId, property: 'hikercabin',
      name, email, phone, checkIn, checkOut, guests, message,
      total: hcDiscountedTotal, nights: hcPricing.nights,
      bundleDiscount: BUNDLE_CABIN_DISCOUNT, status, bufferConflict, submittedAt: now,
    };

    bbBookings.push(bbBooking);
    hcBookings.push(hcBooking);
    await Promise.all([
      saveBookings('bluebear-bookings',   bbBookings),
      saveBookings('hikercabin-bookings', hcBookings),
    ]);

    console.log(`=== BUNDLE BOOKING [${bundleId}] ===`);
    console.log(JSON.stringify({ bbBooking, hcBooking }, null, 2));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        bundleId,
        status,
        pricing: {
          nights: bbPricing.nights,
          cottage: { roomTotal: bbPricing.roomTotal, cleaning: bbPricing.cleaning, tax: bbPricing.tax, total: bbPricing.total },
          cabin:   { roomTotal: hcPricing.roomTotal, discount: cabinDiscount, cleaning: hcPricing.cleaning, tax: hcPricing.tax, total: hcDiscountedTotal },
          bundleTotal,
        },
        message: `Thanks ${name}! We've received your bundle request for ${checkIn} to ${checkOut}. We'll review and send payment instructions to ${email} within 24 hours.`,
        guestNotes: [bbConfig.guestNotes, hcConfig.guestNotes].filter(Boolean).join('\n\n'),
      }),
    };
  }

  // ── SINGLE PROPERTY BOOKING ─────────────────────────────────────────────────
  const isHiker    = prop === 'hikercabin';
  const defaultCfg = isHiker ? CABIN_DEFAULT_CONFIG : DEFAULT_CONFIG;
  const bookingStore  = isHiker ? 'hikercabin-bookings'  : 'bluebear-bookings';
  const pricingStore  = isHiker ? 'hikercabin-pricing'   : 'bluebear-pricing';
  const idPrefix      = isHiker ? 'HC' : 'BB';
  const propertyName  = isHiker ? 'Hiker Delight Homestead Cabin' : 'Blue Bear Cottage';

  const config = await loadConfig(pricingStore, defaultCfg);

  const nights = daysBetween(checkIn, checkOut);
  if (nights < config.minimumStay) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Minimum stay is ${config.minimumStay} nights.` }) };
  }

  const existingBookings = await loadBookings(bookingStore);
  const conflictType = checkConflict(checkIn, checkOut, existingBookings, config.bufferBefore ?? 1, config.bufferAfter ?? 1);

  if (conflictType === 'conflict') {
    return { statusCode: 409, headers, body: JSON.stringify({ error: 'Those dates are no longer available. Please select different dates.' }) };
  }

  const pricing = calculateTotal(checkIn, checkOut, config);
  if (!pricing) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'One or more of your selected dates is not available.' }) };
  }

  const status = conflictType === 'buffer' ? 'buffer_conflict' : 'pending';
  const booking = {
    id: generateId(idPrefix),
    property: prop,
    name, email, phone, checkIn, checkOut, guests, message,
    total: pricing.total,
    nights: pricing.nights,
    status,
    bufferConflict: status === 'buffer_conflict',
    submittedAt: new Date().toISOString(),
  };

  existingBookings.push(booking);
  await saveBookings(bookingStore, existingBookings);
  await sendOwnerNotification(booking, pricing, prop);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      bookingId: booking.id,
      property: prop,
      pricing,
      status: 'pending',
      message: `Thanks ${name}! We've received your request for ${propertyName} (${checkIn} to ${checkOut}). We'll review and send payment instructions to ${email} within 24 hours.`,
      guestNotes: config.guestNotes,
    }),
  };
};
