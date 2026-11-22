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

async function settings() {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, WIX_API_KEY, WIX_SITE_ID, STILLEPUNKT_WIX_SITE_ID, CALENDAR_ADMIN_EMAIL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !WIX_API_KEY || !WIX_SITE_ID || !SUPABASE_SECRET_KEY || !emailKey(CALENDAR_ADMIN_EMAIL)) {
    throw new Error('Calendar configuration incomplete');
  }
  const authOrigin = new URL(SUPABASE_URL);
  if (authOrigin.protocol !== 'https:' || authOrigin.href !== authOrigin.origin + '/') {
    throw new Error('Invalid authentication origin');
  }
  const config = {
    authOrigin: authOrigin.origin, authKey: SUPABASE_PUBLISHABLE_KEY, databaseKey: SUPABASE_SECRET_KEY,
    wixKey: WIX_API_KEY, siteId: WIX_SITE_ID, templeSiteId: STILLEPUNKT_WIX_SITE_ID,
    adminEmail: emailKey(CALENDAR_ADMIN_EMAIL),
  };
  const res = await databaseRequest(config, 'select=email,name,role&order=name', undefined, 'GET', 'calendar_members');
  if (!res.ok) throw new Error('Calendar membership unavailable');
  const members = await res.json();
  const users = new Map(members.map(row => [row.email, row.role]));
  users.set(config.adminEmail, 'admin');
  return { ...config, members, users };
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
  if (!res.ok) throw Object.assign(new Error('Wix request failed'), { httpStatus: res.status });
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
    if (!name && (knownSchedules.has(event.scheduleId) || event.scheduleName === 'business')) continue;
    if (!start || !end || start >= end) {
      issues.push({ type: 'invalid', name, start, end });
      continue;
    }
    if (!name) {
      issues.push({ type: 'unknown', start, end });
      continue;
    }
    const prefersMaxilla = staff.some(person => person.resource?.eventsSchedule?.id === event.scheduleId && emailKey(person.email) === config.adminEmail);
    const row = { id: event.id, name, prefersMaxilla, start, end, scheduleId: event.scheduleId };
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
  return { hours, issues, staff };
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

async function signedInUser(config, request) {
  const cookie = request.headers.get('Cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(sessionCookie + '='));
  if (!cookie) return null;
  const res = await authRequest(config, 'user', { token: cookie.slice(sessionCookie.length + 1) });
  if (!res.ok) return null;
  const email = emailKey((await res.json()).email);
  const role = roleFor(config, email);
  return role ? { email, role } : null;
}

function databaseRequest(config, query, row, method = row ? 'POST' : 'GET', collection = 'room_assignments') {
  const headers = { apikey: config.databaseKey };
  if (row) {
    headers['Content-Type'] = 'application/json';
    headers.Prefer = method === 'PATCH' ? 'return=representation' :
      query === 'on_conflict=wix_event_id' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal';
  }
  return fetch(config.authOrigin + '/rest/v1/' + collection + '?' + query, {
    method,
    headers,
    body: row ? JSON.stringify(row) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
}

async function readRooms(config, monday, hours) {
  if (!config.databaseKey) return false;
  const end = new Date(Date.parse(monday + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
  const query = new URLSearchParams({
    select: 'wix_event_id,room,starts_at,ends_at,tenant_id,room_tenants(name)',
    starts_at: 'lt.' + end + 'T00:00:00',
    ends_at: 'gt.' + monday + 'T00:00:00',
  });
  const res = await databaseRequest(config, query);
  if (!res.ok) throw new Error('Room assignments unavailable');
  const rows = await res.json();
  const rooms = new Map(rows.map(row => [row.wix_event_id, row]));
  for (const hour of hours) {
    const room = rooms.get(hour.id);
    if (room?.starts_at.slice(0, 19) === hour.start.slice(0, 19) && room.ends_at.slice(0, 19) === hour.end.slice(0, 19)) {
      hour.room = room.room;
    }
  }
  return rows;
}

function roomPeriods(hours, rows, issues) {
  const groups = new Map();
  const sorted = [...hours].sort((a,b) => a.start.localeCompare(b.start) || a.scheduleId.localeCompare(b.scheduleId));
  for (const hour of sorted) {
    const dayKey = hour.scheduleId + '/' + hour.start.slice(0,10);
    const day = groups.get(dayKey) ?? [];
    const previous = day.at(-1);
    if (previous && (!hour.room || !previous.room || hour.room === previous.room)) {
      previous.room ||= hour.room;
      if (hour.end > previous.end) previous.end = hour.end;
      previous.slots.push(hour);
    } else {
      day.push({ ...hour, slots: [hour] });
    }
    groups.set(dayKey, day);
  }
  const periods = [...groups.values()].flat();
  const occupied = periods.filter(period => period.room).concat(
    rows.filter(row => row.tenant_id || row.wix_event_id.startsWith('pending-'))
      .map(row => ({ room: row.room, start: row.starts_at, end: row.ends_at })),
    issues.filter(issue => issue.type === 'unknown')
  );
  const automatic = periods.filter(period => !period.room).sort((a,b) =>
    Number(b.prefersMaxilla) - Number(a.prefersMaxilla) || a.start.localeCompare(b.start));
  for (const period of automatic) {
    const order = period.prefersMaxilla ? ['maxilla'] : ['mandibula','maxilla'];
    period.room = order.find(room => !occupied.some(other => (!other.room || other.room === room) && overlaps(other, period)));
    occupied.push(period);
  }
  return periods;
}

async function assignRoom(config, request, input) {
  if ((await signedInUser(config, request))?.role !== 'admin') return respond(403, { error: 'Kun administrator kan tildele rom.' });
  if (!config.databaseKey) return respond(503, { error: 'Lagring av rom er ikke konfigurert.' });
  if (typeof input.week !== 'string' || !['mandibula', 'maxilla'].includes(input.room) || typeof input.id !== 'string') {
    return respond(400, { error: 'Velg en gyldig arbeidstid og et rom.' });
  }
  const week = await readWeek(config, input.week);
  const hour = week?.hours.find(row => row.id === input.id && row.start === input.start && row.end === input.end);
  if (!hour) return respond(409, { error: 'Arbeidstiden i Wix er endret. Last uken på nytt.' });
  const res = await databaseRequest(config, 'on_conflict=wix_event_id', {
    wix_event_id: hour.id,
    room: input.room,
    starts_at: hour.start,
    ends_at: hour.end,
  });
  if (res.status === 409) return respond(409, { error: 'Rommet overlapper en lagret tildeling.' });
  if (!res.ok) throw new Error('Room assignment failed');
  return respond(200, {});
}

const workBlocks = [['08:00', '12:30'], ['12:45', '17:15'], ['17:30', '22:00']];
const overlaps = (a, b) => a.start < b.end && b.start < a.end;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const canManageRentals = role => ['admin', 'rental-manager'].includes(role);

async function readTenants(config) {
  const res = await databaseRequest(config, 'select=id,name&order=name', undefined, 'GET', 'room_tenants');
  if (!res.ok) throw new Error('Tenant lookup failed');
  return res.json();
}

async function manageRental(config, request, input) {
  const user = await signedInUser(config, request);
  if (!canManageRentals(user?.role)) return respond(403, { error: 'Du har ikke tilgang til romleie.' });
  if (!config.databaseKey) return respond(503, { error: 'Lagring av rom er ikke konfigurert.' });

  if (input.action === 'add-tenant') {
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 60) return respond(400, { error: 'Skriv et navn på inntil 60 tegn.' });
    const res = await databaseRequest(config, '', { name }, 'POST', 'room_tenants');
    if (res.status === 409) return respond(409, { error: 'Leietakeren finnes allerede.' });
    if (!res.ok) throw new Error('Tenant creation failed');
    return respond(200, {});
  }

  const { id, tenantId, week: monday, room, date, from, to } = input;
  if (typeof id !== 'string' || !uuid.test(id)) return respond(400, { error: 'Ugyldig reservasjon.' });
  const key = 'rental-' + id;
  const query = new URLSearchParams({ wix_event_id: 'eq.' + key, tenant_id: 'not.is.null' });
  if (input.action === 'release-rental') {
    const res = await databaseRequest(config, query, undefined, 'DELETE');
    if (!res.ok) throw new Error('Rental release failed');
    return respond(200, {});
  }

  const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof tenantId !== 'string' || !uuid.test(tenantId) || typeof monday !== 'string'
      || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !clock.test(from) || !clock.test(to) || from >= to
      || !['mandibula', 'maxilla'].includes(room) || !workBlocks.some(([a, b]) => from >= a && to <= b)) {
    return respond(400, { error: 'Velg leietaker, rom og tid innenfor én bolk.' });
  }
  const week = await readWeek(config, monday);
  if (!week) return respond(400, { error: 'Ugyldig uke.' });
  const dateOffset = (Date.parse(date + 'T00:00:00Z') - Date.parse(monday + 'T00:00:00Z')) / 86400000;
  if (!Number.isInteger(dateOffset) || dateOffset < 0 || dateOffset > 6 || date < osloNow().slice(0, 10)) {
    return respond(400, { error: 'Velg en fremtidig dato i den viste uken.' });
  }
  const period = { start: date + 'T' + from + ':00', end: date + 'T' + to + ':00' };
  if (period.start <= osloNow()) return respond(400, { error: 'Velg et fremtidig tidspunkt.' });
  const rows = await readRooms(config, monday, week.hours);
    const periods = roomPeriods(week.hours, rows, week.issues);
  if (week.issues.some(issue => issue.type === 'unknown' && overlaps(issue, period))
      || periods.some(hour => overlaps(hour, period) && (!hour.room || hour.room === room))) {
    return respond(409, { error: 'Tiden overlapper en arbeidstid i Wix. Ufordelt arbeidstid må avklares først.' });
  }
  const row = { tenant_id: tenantId, room, starts_at: period.start, ends_at: period.end };
  const updating = input.action === 'update-rental';
  const res = updating
    ? await databaseRequest(config, query, row, 'PATCH')
    : await databaseRequest(config, '', { wix_event_id: key, ...row });
  if (res.status === 409) return respond(409, { error: 'Rommet eller leietakeren er allerede reservert i perioden.' });
  if (!res.ok) throw new Error('Rental save failed');
  if (updating && (await res.json()).length !== 1) return respond(409, { error: 'Reservasjonen finnes ikke lenger.' });
  return respond(200, {});
}

function osloNow() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(' ', 'T');
}

function trial(role, week) {
  return role === 'admin' && week === '2026-12-28' && osloNow().slice(0,10) <= '2026-12-31';
}
async function reserveRoom(config, request, input) {
  const user = await signedInUser(config, request);
  if (!user || !['admin', 'therapist'].includes(user.role)) return respond(403, { error: 'Du kan bare reservere din egen arbeidstid.' });
  if (!config.databaseKey || (process.env.ENABLE_WIX_WRITES !== 'true' && !(trial(user.role,input.week) && input.date <= '2026-12-31'))) return respond(503, { error: 'Reservasjoner med Wix-synk er ikke aktivert.' });
  const { id, week: monday, room, date, from, to } = input;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
      || typeof monday !== 'string' || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
      || typeof from !== 'string' || typeof to !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(from)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(to) || from >= to || !['mandibula', 'maxilla'].includes(room)) {
    return respond(400, { error: 'Velg en gyldig dato, tid og et rom.' });
  }
  const week = await readWeek(config, monday);
  if (!week) return respond(400, { error: 'Velg en gyldig uke.' });
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(monday + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10));
  const now = osloNow();
  const period = { start: date + 'T' + from + ':00', end: date + 'T' + to + ':00' };
  if (!days.includes(date) || period.start <= now) return respond(400, { error: 'Velg en fremtidig tid i den viste uken.' });
  const staff = week.staff.filter(person => emailKey(person.email) === user.email && !person.resource?.usesDefaultWorkingHours);
  const scheduleId = staff.length === 1 ? staff[0].resource?.eventsSchedule?.id : null;
  if (!scheduleId) return respond(409, { error: 'Fant ingen entydig arbeidstidsplan for deg i Wix.' });

  const stored = await databaseRequest(config, new URLSearchParams({ request_id: 'eq.' + id }));
  if (!stored.ok) throw new Error('Reservation lookup failed');
  const [existing] = await stored.json();
  const pendingId = 'pending-' + id;
  if (existing) {
    if (existing.staff_schedule_id !== scheduleId || existing.room !== room
        || existing.starts_at.slice(0, 19) !== period.start || existing.ends_at.slice(0, 19) !== period.end) {
      return respond(409, { error: 'Denne forespørselen gjelder en annen reservasjon.' });
    }
    if (existing.wix_event_id !== pendingId) return respond(200, {});
  } else {
    const rows = await readRooms(config, monday, week.hours);
    const periods = roomPeriods(week.hours, rows, week.issues);
    if (week.issues.some(issue => issue.type === 'unknown' && overlaps(issue, period))) {
      return respond(409, { error: 'En uidentifisert arbeidstid i Wix må avklares først.' });
    }
    const own = periods.filter(hour => hour.room === room && hour.scheduleId === scheduleId && hour.start.slice(0,10) === date);
    const envelope = { start: [period.start,...own.map(x => x.start)].sort()[0], end: [period.end,...own.map(x => x.end)].sort().at(-1) };
    if (week.hours.some(hour => hour.scheduleId === scheduleId && overlaps(hour,period))
        || periods.some(hour => hour.scheduleId !== scheduleId && (!hour.room || hour.room === room) && overlaps(hour,envelope))
        || periods.some(hour => hour.scheduleId === scheduleId && hour.room !== room && overlaps(hour,envelope))
        || rows.some(row => (row.tenant_id || row.wix_event_id.startsWith('pending-')) && row.room === room && overlaps({start:row.starts_at,end:row.ends_at},envelope))
        || week.issues.some(issue => issue.type === 'unknown' && overlaps(issue,envelope))) {
      return respond(409, { error: 'Tiden overlapper en arbeidstid i Wix. Eventuelle ufordelte tider må få et rom først.' });
    }
    const withinBlock = workBlocks.some(([start, end]) => from >= start && to <= end);
    const bridge = workBlocks.slice(0, -1).some(([, end], i) => from === end && to === workBlocks[i + 1][0]
      && week.hours.some(hour => hour.scheduleId === scheduleId && hour.room === room && hour.end === period.start)
      && week.hours.some(hour => hour.scheduleId === scheduleId && hour.room === room && hour.start === period.end));
    if (!withinBlock && !bridge) return respond(400, { error: 'Velg en tid innenfor en bolk eller mellom to av dine bolker i samme rom.' });
    const hold = await databaseRequest(config, '', {
      wix_event_id: pendingId, request_id: id, staff_schedule_id: scheduleId,
      room, starts_at: period.start, ends_at: period.end,
    });
    if (hold.status === 409) return respond(409, { error: 'Rommet eller arbeidstiden er allerede reservert. Last inn uken på nytt, eller prøv samme reservasjon igjen.' });
    if (!hold.ok) throw new Error('Reservation claim failed');
  }

  const created = await wixRequest(config, '/calendar/v3/events', {
    idempotencyKey: id,
    event: {
      type: 'WORKING_HOURS', scheduleId,
      timeZone: 'Europe/Oslo', transparency: 'TRANSPARENT',
      location: { id: '6b18a2d6-70ce-4cc4-9827-7d658cef8bc1', type: 'BUSINESS' },
      start: { localDate: period.start, timeZone: 'Europe/Oslo' },
      end: { localDate: period.end, timeZone: 'Europe/Oslo' },
    },
  }).catch(error => ({ httpStatus: error.httpStatus }));
  if (created?.httpStatus) return respond(503, { error: 'Wix avviste registreringen (HTTP ' + created.httpStatus + '). Rommet er holdt av.' });
  if (!created?.event?.id) return respond(503, { error: 'Rommet er holdt av. Wix kunne ikke bekrefte arbeidstiden. Prøv samme reservasjon igjen.' });

  const verified = await readWeek(config, monday);
  if (!verified?.hours.some(hour => hour.id === created.event.id && hour.scheduleId === scheduleId
      && hour.start.slice(0,19) === period.start && hour.end.slice(0,19) === period.end)) {
    return respond(503, { error: 'Venter på bekreftelse fra Wix. Prøv samme reservasjon igjen.' });
  }
  const saved = await databaseRequest(config, new URLSearchParams({ request_id: 'eq.' + id }), { wix_event_id: created.event.id }, 'PATCH');
  if (!saved.ok || (await saved.json()).length !== 1) {
    return respond(503, { error: 'Wix mottok arbeidstiden. Prøv samme reservasjon igjen for å fullføre koblingen.' });
  }
  return respond(200, {});
}

async function manageMember(config, request, input) {
  if ((await signedInUser(config, request))?.role !== 'admin') return respond(403, { error: 'Kun administrator kan endre tilgang.' });
  const email = emailKey(input.email);
  if (email === config.adminEmail || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond(400, { error: 'Velg en gyldig e-postadresse for et medlem.' });
  }
  if (input.action === 'remove-member') {
    const res = await databaseRequest(config, new URLSearchParams({ email: 'eq.' + email }), undefined, 'DELETE', 'calendar_members');
    if (!res.ok) throw new Error('Member removal failed');
    return respond(200, {});
  }
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 60 || !['therapist', 'rental-manager'].includes(input.role)) {
    return respond(400, { error: 'Fyll inn navn og rolle.' });
  }
  const res = await databaseRequest(config, '', { email, name, role: input.role }, 'POST', 'calendar_members');
  if (res.status === 409) return respond(409, { error: 'Adressen er allerede godkjent.' });
  if (!res.ok) throw new Error('Member creation failed');
  return respond(200, {});
}

export default async function handler(request) {
  const url = new URL(request.url);
  if (!['GET', 'POST'].includes(request.method)) return respond(405, { error: 'Metoden støttes ikke.' });
  try {
    if (request.method === 'POST') {
      if (request.headers.get('Origin') !== url.origin) return respond(403, { error: 'Ugyldig forespørsel.' });
      const input = await request.json();
      const { action, email } = input;
      if (['add-member', 'remove-member'].includes(action)) return await manageMember(await settings(), request, input);
      if (['add-tenant', 'reserve-rental', 'update-rental', 'release-rental'].includes(action)) return await manageRental(await settings(), request, input);
      if (action === 'reserve-room') return await reserveRoom(await settings(), request, input);
      if (action === 'assign-room') return await assignRoom(await settings(), request, input);
      if (action === 'logout') return respond(200, {}, { 'Set-Cookie': session('', 0) });
      if (!['request-link', 'verify-link'].includes(action)) return respond(400, { error: 'Ugyldig forespørsel.' });
      const config = await settings();
      if (action === 'request-link') {
        const address = emailKey(email);
        if (roleFor(config, address)) {
          const res = await authRequest(config, 'otp', { body: { email: address, create_user: true } });
          if (!res.ok && res.status >= 500) return respond(503, { error: 'Innloggingen er midlertidig utilgjengelig.' });
        }
        return respond(200, { message: 'Hvis adressen er godkjent, får du en innloggingslenke på e-post.' });
      }
      const tokenHash = input.tokenHash;
      if (typeof tokenHash !== 'string' || !/^[\w-]{20,256}$/.test(tokenHash)) return respond(401, { error: 'Ugyldig eller utløpt lenke.' });
      const res = await authRequest(config, 'verify', { body: { token_hash: tokenHash, type: 'email' } });
      if (!res.ok) return respond(401, { error: 'Ugyldig eller utløpt lenke.' });
      const data = await res.json();
      if (!roleFor(config, data.user?.email) || !/^[\w.-]+$/.test(data.access_token ?? '')) {
        return respond(401, { error: 'Innloggingen kunne ikke bekreftes.' });
      }
      return respond(200, {}, { 'Set-Cookie': session(data.access_token, Math.min(data.expires_in || 3600, 3600)) });
    }

    if (!request.headers.get('Cookie')?.includes(sessionCookie + '=')) return respond(401, { error: 'Logg inn for å se arbeidstid.' });
    const config = await settings();
    const role = (await signedInUser(config, request))?.role;
    if (!role) return respond(401, { error: 'Logg inn for å se arbeidstid.' }, { 'Set-Cookie': session('', 0) });
    const monday = url.searchParams.get('week') ?? '';
    const week = await readWeek(config, monday);
    if (!week) return respond(400, { error: 'Velg mandag i uken du vil vise.' });
    const [temple, rooms] = await Promise.all([
      readTemple(config, monday).catch(() => null),
      readRooms(config, monday, week.hours).catch(() => false),
    ]);
    const hours = roomPeriods(week.hours, rooms || [], week.issues).map(({ scheduleId, prefersMaxilla, slots, ...hour }) => ({
      ...hour, ...(role === 'admin' ? { slots: slots.map(({ id, start, end }) => ({ id, start, end, room: hour.room })) } : {})
    }));
    for (const room of rooms || []) {
      if (room.wix_event_id.startsWith('pending-')) hours.push({ name: 'Avventer Wix', start: room.starts_at, end: room.ends_at, room: room.room });
      if (room.tenant_id) hours.push({
        name: room.room_tenants?.name ?? 'Romleie', start: room.starts_at, end: room.ends_at, room: room.room,
        rental: canManageRentals(role) ? { id: room.wix_event_id.slice('rental-'.length), tenantId: room.tenant_id } : undefined,
      });
    }
    const tenants = rooms && canManageRentals(role) ? await readTenants(config).catch(() => null) : null;
    const unassignedBlocks = week.issues.filter(issue => issue.type === 'unknown').map(({ start, end }) => ({ start, end }));
    return respond(200, { role, hours, temple, tenants, unassignedBlocks, ...(role === 'admin' ? { members: config.members } : {}), roomsEnabled: Boolean(rooms), reservationEnabled: Boolean(rooms) && (process.env.ENABLE_WIX_WRITES === 'true' || trial(role,monday)) && ['admin', 'therapist'].includes(role), issues: role === 'admin' ? week.issues : [] });
  } catch {
    return respond(503, { error: 'Kalenderen er midlertidig utilgjengelig.' });
  }
}

export const config = { path: '/api/calendar' };
