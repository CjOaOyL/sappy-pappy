/**
 * get-events-ical.js
 * Serves approved Green Book community events as a standard iCal (.ics) feed.
 *
 * Subscribe to this URL in Google Calendar, Apple Calendar, Outlook, etc.:
 *   https://sappy-pappy.com/.netlify/functions/get-events-ical
 *
 * Google Calendar: Other calendars → + → From URL → paste URL → Add calendar
 * Apple Calendar:  File → New Calendar Subscription → paste URL
 * Outlook:         Add calendar → From internet → paste URL
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

function pad(n) { return String(n).padStart(2, '0'); }

function nowStamp() {
  const d = new Date();
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function toICalDate(dateStr) {
  // YYYY-MM-DD → YYYYMMDD
  return dateStr.replace(/-/g, '');
}

function toICalDateTime(dateStr, timeStr) {
  // Returns floating local datetime (no Z, no TZID) — Google Calendar respects
  // the TZID on the calendar itself. Using Eastern as the canonical TZ.
  const [h, m] = timeStr.split(':');
  return `${toICalDate(dateStr)}T${h}${m}00`;
}

function escapeIcal(str) {
  return String(str || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
}

// iCal line folding: lines > 75 octets must be folded
function foldLine(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let i = 0;
  while (i < line.length) {
    // Take up to 75 bytes worth of characters
    let chunk = '';
    let byteCount = i === 0 ? 0 : 1; // continuation lines start with space (1 byte)
    while (i < line.length && byteCount + Buffer.byteLength(line[i], 'utf8') <= 75) {
      byteCount += Buffer.byteLength(line[i], 'utf8');
      chunk += line[i++];
    }
    parts.push(chunk);
  }
  return parts.join('\r\n ');
}

function buildIcal(events) {
  const stamp = nowStamp();

  const vevents = events.map(ev => {
    const uid = `greenbook-event-${ev.id}@sappy-pappy.com`;
    const lines = [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${stamp}`,
    ];

    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${toICalDate(ev.startDate)}`);
      // iCal all-day DTEND is exclusive — add one day
      const endD = new Date(ev.endDate + 'T12:00:00');
      endD.setDate(endD.getDate() + 1);
      lines.push(`DTEND;VALUE=DATE:${toICalDate(endD.toISOString().slice(0, 10))}`);
    } else if (ev.startTime) {
      lines.push(`DTSTART;TZID=America/New_York:${toICalDateTime(ev.startDate, ev.startTime)}`);
      if (ev.endTime) {
        lines.push(`DTEND;TZID=America/New_York:${toICalDateTime(ev.endDate || ev.startDate, ev.endTime)}`);
      } else {
        // No end time — default duration 2 hours
        const [h, m] = ev.startTime.split(':').map(Number);
        const endH = String(h + 2).padStart(2, '0');
        lines.push(`DTEND;TZID=America/New_York:${toICalDateTime(ev.startDate, endH + ':' + String(m).padStart(2, '0'))}`);
      }
    } else {
      // No time specified — treat as all-day
      lines.push(`DTSTART;VALUE=DATE:${toICalDate(ev.startDate)}`);
      const endD = new Date(ev.endDate + 'T12:00:00');
      endD.setDate(endD.getDate() + 1);
      lines.push(`DTEND;VALUE=DATE:${toICalDate(endD.toISOString().slice(0, 10))}`);
    }

    lines.push(foldLine(`SUMMARY:${escapeIcal(ev.title)}`));

    const descParts = [ev.description];
    if (ev.externalLink) descParts.push(`More info: ${ev.externalLink}`);
    if (ev.organizer)    descParts.push(`Organized by: ${ev.organizer}`);
    lines.push(foldLine(`DESCRIPTION:${escapeIcal(descParts.join('\\n\\n'))}`));

    if (ev.location || ev.locationAddress) {
      const loc = [ev.location, ev.locationAddress].filter(Boolean).join(', ');
      lines.push(foldLine(`LOCATION:${escapeIcal(loc)}`));
    }

    if (ev.externalLink) {
      lines.push(foldLine(`URL:${escapeIcal(ev.externalLink)}`));
    }

    lines.push(`CATEGORIES:${escapeIcal(ev.category)}`);
    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');

    return lines.join('\r\n');
  });

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//The Green Book//Community Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:The Green Book — Community Events',
    'X-WR-CALDESC:Community events curated by The Green Book at sappy-pappy.com',
    'X-WR-TIMEZONE:America/New_York',
    ...vevents,
    'END:VCALENDAR',
  ].join('\r\n');
}

export const handler = async () => {
  try {
    const store = getConfiguredStore('green-book-events-approved');
    const { blobs } = await store.list();

    const events = await Promise.all(
      blobs.map(async ({ key }) => {
        const raw = await store.get(key);
        try { return JSON.parse(raw); } catch { return null; }
      })
    );

    const approved = events.filter(Boolean);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="green-book-community-events.ics"',
        'Cache-Control': 'no-cache, no-store',
        'Access-Control-Allow-Origin': '*',
      },
      body: buildIcal(approved),
    };
  } catch (err) {
    console.error('get-events-ical error:', err);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
      body: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//The Green Book//EN\r\nEND:VCALENDAR',
    };
  }
};
