const staffPath = '/bookings/v1/staff-members/query';
const templePath = '/events/v3/events/query';
const hoursPath = '/calendar/v3/events/query';
const wixOrigin = 'https://www.wixapis.com';
const sessionCookie = 'cranio_calendar_session';

function respond(status, data, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function session(value, maxAge) {
  return `${sessionCookie}=${value}; Path=/api/calendar; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function emailKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function settings() {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, WIX_API_KEY, WIX_SITE_ID, STILLEPUNKT_WIX_SITE_ID, CALENDAR_USERS } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !WIX_API_KEY || !WIX_SITE_ID || !CALENDAR_USERS) {
    throw new Error('Calendar configuration incomplete');
  }
  const authOrigin = new URL(SUPABASE_URL);
  if (authOrigin.protocol !== 'https:' || authOrigin.href !== authOrigin.origin + '/') {
    throw new Error('Invalid authentication origin');
  }
  const users = new Map(Object.entries(JSON.parse(CALENDAR_USERS)).map(([email, role]) => [emailKey(email), role]));
  return { authOrigin: authOrigin.origin, authKey: SUPABASE_PUBLISHABLE_KEY, wixKey: WIX_API_KEY, siteId: WIX_SITE_ID, templeSiteId: STILLEPUNKT_WIX_SITE_ID, users };
}

function roleFor(config, email) {
  const role = config.users.get(emailKey(email));
  return ['admin', 'therapist', 'rental-manager'].includes(role) ? role : null;
}

function authRequest(config, path, { body, token } = {}) {
  return fetch(config.authOrigin + '/auth/v1/' + path, {
    method: body ? 'POST' : 'GET',
    headers: {
      apikey: config.authKey,
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
}

async function wixRequest(config, path, body) {
  const res = await fetch(wixOrigin + path, {
    method: 'POST',
    headers: { Authorization: config.wixKey, 'wix-site-id': config.siteId, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error('Wix request failed');
  return res.json();
}

async function readPages(config, path, body, collection) {
  const items = [];
  const seen = new Set();
  let cursor;
  do {
    if (cursor && seen.has(cursor)) throw new Error('Invalid Wix paging cursor');
    if (cursor) seen.add(cursor);
    const page = await wixRequest(config, path, {
      ...body,
      query: { ...body.query, ...(cursor ? { cursorPaging: { cursor } } : {}) },
    });
    if (!Array.isArray(page[collection])) throw new Error('Unexpected Wix response');
    items.push(...page[collection]);
    cursor = page.pagingMetadata?.cursors?.next;
    if (!cursor && page.pagingMetadata?.hasNext) throw new Error('Wix page is incomplete');
  } while (cursor);
  return items;
}

async function readWeek(config, monday) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday)) return null;
  const start = new Date(monday + 'T00:00:00Z');
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== monday || start.getUTCDay() !== 1) return null;
  const until = new Date(start.getTime() + 7 * 86400000).toISOString().slice(0, 10);
  const [staff, events] = await Promise.all([
    readPages(config, staffPath, { fields: ['RESOURCE_DETAILS'] }, 'staffMembers'),
    readPages(config, hoursPath, {
      fromLocalDate: monday + 'T00:00:00',
      toLocalDate: until + 'T00:00:00',
      timeZone: 'Europe/Oslo',
      query: { filter: { type: 'WORKING_HOURS' } },
    }, 'events'),
  ]);
  const bySchedule = new Map(staff.flatMap(person => {
    const role = roleFor(config, person.email);
    const scheduleId = person.resource?.eventsSchedule?.id;
    if (!scheduleId || person.resource?.usesDefaultWorkingHours || !['admin', 'therapist'].includes(role)) return [];
    return [[scheduleId, person.name.trim().split(/\s+/)[0]]];
  }));
  const knownSchedules = new Set(staff.map(person => person.resource?.eventsSchedule?.id).filter(Boolean));
  const active = events.filter(event => !['CANCELLED', 'CANCELED'].includes(event.status));
  const hours = [];
  const issues = [];
  const perSchedule = new Map();
  for (const event of active) {
    const start = event.start?.localDate;
    const end = event.end?.localDate;
    const name = bySchedule.get(event.scheduleId);
    if (!name && knownSchedules.has(event.scheduleId)) continue;
    if (!start || !end || start >= end) {
      issues.push({ type: 'invalid', name, start, end });
      continue;
    }
    if (!name) {
      issues.push({ type: 'unknown', start, end });
      continue;
    }
    const row = { name, start, end };
    hours.push(row);
    const periods = perSchedule.get(event.scheduleId) ?? [];
    periods.push(row);
    perSchedule.set(event.scheduleId, periods);
  }
  for (const periods of perSchedule.values()) {
    periods.sort((a, b) => a.start.localeCompare(b.start));
    let previous;
    for (const row of periods) {
      if (previous && row.start < previous.end) {
        issues.push({ type: 'overlap', ...row, otherStart: previous.start, otherEnd: previous.end });
      }
      if (!previous || row.end > previous.end) previous = row;
    }
  }
  return { hours, issues };
}

async function readTemple(config, monday) {
  if (!config.templeSiteId) return null;
  const start = Date.parse(monday + 'T00:00:00Z');
  // Query slightly wider UTC bounds, then use Oslo dates for the calendar display.
  const lower = new Date(start - 86400000).toISOString();
  const upper = new Date(start + 8 * 86400000).toISOString();
  const limit = 50;
  const events = [];
  for (let offset = 0; ; offset += limit) {
    const page = await wixRequest({ ...config, siteId: config.templeSiteId }, templePath, {
      query: {
        filter: {
          $and: [
            { 'dateAndTimeSettings.startDate': { $lt: upper } },
            { 'dateAndTimeSettings.endDate': { $gte: lower } },
          ],
        },
        paging: { limit, offset },
      },
    });
    if (!Array.isArray(page.events)) throw new Error('Unexpected Stillepunkt response');
    for (const event of page.events) {
      const { startDate: start, endDate: end, dateAndTimeTbd } = event.dateAndTimeSettings ?? {};
      if (event.status === 'CANCELED' || event.status === 'CANCELLED' || dateAndTimeTbd || !event.title) continue;
      if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) continue;
      events.push({ title: event.title, start, end });
    }
    if (page.events.length < limit || offset + limit >= page.pagingMetadata?.total) break;
  }
  return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export default async function handler(request) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return respond(405, { error: 'Metoden støttes ikke.' });
  try {
    if (request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) return respond(403, { error: 'Ugyldig forespørsel.' });
      const { action, email, code } = await request.json();
      if (action === 'logout') return respond(200, {}, { 'Set-Cookie': session('', 0) });
      if (!['request-code', 'verify-code'].includes(action)) return respond(400, { error: 'Ugyldig forespørsel.' });
      const config = settings();
      const address = emailKey(email);
      const allowed = roleFor(config, address);
      if (action === 'request-code') {
        if (allowed) {
          const res = await authRequest(config, 'otp', { body: { email: address, create_user: false } });
          if (!res.ok && res.status >= 500) return respond(503, { error: 'Innloggingen er midlertidig utilgjengelig.' });
        }
        return respond(200, { message: 'Hvis adressen har tilgang, får du en kode på e-post.' });
      }
      if (!allowed || !/^\d{6,10}$/.test(String(code))) return respond(401, { error: 'Ugyldig eller utløpt kode.' });
      const res = await authRequest(config, 'verify', { body: { email: address, token: code, type: 'email' } });
      if (!res.ok) return respond(401, { error: 'Ugyldig eller utløpt kode.' });
      const data = await res.json();
      if (emailKey(data.user?.email) !== address || !/^[\w.-]+$/.test(data.access_token ?? '')) {
        return respond(401, { error: 'Innloggingen kunne ikke bekreftes.' });
      }
      return respond(200, {}, { 'Set-Cookie': session(data.access_token, Math.min(data.expires_in || 3600, 3600)) });
    }

    const cookie = request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(sessionCookie + '='));
    if (!cookie) return respond(401, { error: 'Logg inn for å se arbeidstid.' });
    const config = settings();
    const res = await authRequest(config, 'user', { token: cookie.slice(sessionCookie.length + 1) });
    const user = res.ok ? await res.json() : null;
    const role = roleFor(config, user?.email);
    if (!role) return respond(401, { error: 'Logg inn for å se arbeidstid.' }, { 'Set-Cookie': session('', 0) });
    const monday = url.searchParams.get('week') ?? '';
    const week = await readWeek(config, monday);
    if (!week) return respond(400, { error: 'Velg mandag i uken du vil vise.' });
    const temple = await readTemple(config, monday).catch(() => null);
    return respond(200, { role, hours: week.hours, temple, issues: role === 'admin' ? week.issues : [] });
  } catch {
    return respond(503, { error: 'Kalenderen er midlertidig utilgjengelig.' });
  }
}

export const config = { path: '/api/calendar' };
