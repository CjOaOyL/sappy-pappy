/**
 * get-booking-ical.js
 * Serves confirmed direct bookings as a standard iCal (.ics) feed.
 *
 * GET /.netlify/functions/get-booking-ical?property=bluebear|hikercabin
 *
 * Import into Airbnb/VRBO to auto-block dates when guests book directly.
 *   Blue Bear Cottage:  https://sappy-pappy.com/.netlify/functions/get-booking-ical?property=bluebear
 *   Hiker Delight Cabin: https://sappy-pappy.com/.netlify/functions/get-booking-ical?property=hikercabin
 */

import { getStore } from '@netlify/blobs';
import { DEFAULT_CONFIG, CABIN_DEFAULT_CONFIG } from './get-pricing.js';

function addDays(isoDate, days) {
  if (!isoDate || days === 0) return isoDate;
  const d = new Date(isoDate + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function pad(n) { return String(n).padStart(2, '0'); }

function toICalDate(isoStr) { return isoStr.replace(/-/g, ''); }

function escapeIcal(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function buildIcal(bookings, calName, prodId) {
  const now   = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const events = bookings
    .filter(b => b.status === 'confirmed' && b.checkIn && b.checkOut)
    .map(b => {
      const uid     = `${b.id}@sappy-pappy.com`;
      const summary = 'Booked - Direct';
      return [
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${toICalDate(b.checkIn)}`,
        `DTEND;VALUE=DATE:${toICalDate(b.checkOut)}`,
        `SUMMARY:${escapeIcal(summary)}`,
        `DESCRIPTION:Direct booking via sappy-pappy.com`,
        'STATUS:CONFIRMED',
        'TRANSP:OPAQUE',
        'END:VEVENT',
      ].join('\r\n');
    });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${calName}`,
    'X-WR-TIMEZONE:America/New_York',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

export const handler = async (event) => {
  const prop = event?.queryStringParameters?.property || 'bluebear';
  const isHiker = prop === 'hikercabin';

  const storeName    = isHiker ? 'hikercabin-bookings' : 'bluebear-bookings';
  const pricingStore = isHiker ? 'hikercabin-pricing'  : 'bluebear-pricing';
  const defaultCfg   = isHiker ? CABIN_DEFAULT_CONFIG   : DEFAULT_CONFIG;
  const calName      = isHiker ? 'Hiker Delight Homestead Cabin - Direct Bookings' : 'Blue Bear Cottage - Direct Bookings';
  const prodId       = isHiker ? '-//Hiker Delight Cabin//Direct Bookings//EN' : '-//Blue Bear Cottage//Direct Bookings//EN';

  try {
    const store = getStore(storeName);
    const raw = await store.get('all');
    const bookings = raw ? JSON.parse(raw) : [];

    let bufferBefore = defaultCfg.bufferBefore;
    let bufferAfter  = defaultCfg.bufferAfter;
    try {
      const pStore = getStore(pricingStore);
      const pRaw = await pStore.get('config');
      if (pRaw) {
        const cfg = JSON.parse(pRaw);
        bufferBefore = Math.max(0, Math.min(7, Number(cfg.bufferBefore) ?? 1));
        bufferAfter  = Math.max(0, Math.min(7, Number(cfg.bufferAfter)  ?? 1));
      }
    } catch { /* use defaults */ }

    // Expand confirmed bookings by buffer days
    const expandedBookings = bookings.map(b => {
      if (b.status !== 'confirmed') return b;
      return { ...b, checkIn: addDays(b.checkIn, -bufferBefore), checkOut: addDays(b.checkOut, bufferAfter) };
    });

    const ical = buildIcal(expandedBookings, calName, prodId);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `inline; filename="${isHiker ? 'hikercabin' : 'bluebear'}-direct-bookings.ics"`,
        'Cache-Control': 'no-cache, no-store',
      },
      body: ical,
    };
  } catch (err) {
    console.error('get-booking-ical error:', err);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Sappy Pappy//EN\r\nEND:VCALENDAR',
    };
  }
};
