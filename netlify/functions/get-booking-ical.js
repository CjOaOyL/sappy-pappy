/**
 * get-booking-ical.js
 * Serves confirmed direct bookings as a standard iCal (.ics) feed.
 *
 * Import this URL into Airbnb and VRBO so they automatically block
 * dates when a guest books directly on your site.
 *
 * URL: https://sappy-pappy.com/.netlify/functions/get-booking-ical
 *
 * Airbnb: Calendar → Availability → Import Calendar → paste this URL
 * VRBO:   Calendar → Import Calendar → paste this URL
 *
 * Both platforms re-check this feed every few hours.
 */

import { getStore } from '@netlify/blobs';

function pad(n) { return String(n).padStart(2, '0'); }

function toICalDate(isoStr) {
  // Convert YYYY-MM-DD to YYYYMMDD
  return isoStr.replace(/-/g, '');
}

function escapeIcal(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function buildIcal(bookings) {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const events = bookings
    .filter(b => b.status === 'confirmed' && b.checkIn && b.checkOut)
    .map(b => {
      const uid = `bluebear-direct-${b.id}@sappy-pappy.com`;
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
    'PRODID:-//Blue Bear Cottage//Direct Bookings//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Blue Bear Cottage - Direct Bookings',
    'X-WR-TIMEZONE:America/New_York',
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');
}

export const handler = async () => {
  try {
    const store = getStore('bluebear-bookings');
    const raw = await store.get('all');
    const bookings = raw ? JSON.parse(raw) : [];

    const ical = buildIcal(bookings);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="bluebear-direct-bookings.ics"',
        'Cache-Control': 'no-cache, no-store',
      },
      body: ical,
    };
  } catch (err) {
    console.error('get-booking-ical error:', err);
    // Return empty valid calendar on error — so Airbnb/VRBO don't mark it broken
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Blue Bear Cottage//EN\r\nEND:VCALENDAR',
    };
  }
};
