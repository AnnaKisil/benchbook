// Pure helpers: dates, booking rules and conflict detection.
// No DOM and no network here, so this file can be unit-tested with `node --test`.

export function makeRules(cfg = {}) {
  return {
    dayStart: cfg.DAY_START_HOUR ?? 8,
    dayEnd: cfg.DAY_END_HOUR ?? 18,
    step: cfg.SLOT_MINUTES ?? 30,
    maxDays: cfg.MAX_RANGE_DAYS ?? 60,
  };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pad = (n) => String(n).padStart(2, '0');

// ---- Dates (all in the browser's local time) ----
export function dateKey(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
export function startOfWeek(d) {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7)); // Monday
}
export function isWeekday(d) {
  const g = d.getDay();
  return g >= 1 && g <= 5;
}
/** The given day if it is a weekday, otherwise the next (dir=1) or previous (dir=-1) weekday. */
export function nextWeekday(d, dir = 1) {
  let x = startOfDay(d);
  while (!isWeekday(x)) x = addDays(x, dir);
  return x;
}
/** Move one weekday forwards or backwards, skipping weekends. */
export function shiftWeekday(d, dir) {
  let x = addDays(startOfDay(d), dir);
  while (!isWeekday(x)) x = addDays(x, dir);
  return x;
}

// ---- Times ----
export function minutesOf(t) {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
}
export function hm(mins) {
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}
export function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}
export function timeOf(date) {
  return hm(minuteOfDay(date));
}
export function at(key, t) {
  const d = parseKey(key);
  const m = minutesOf(t);
  d.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return d;
}
export function timeOptions(rules) {
  const out = [];
  for (let m = rules.dayStart * 60; m <= rules.dayEnd * 60; m += rules.step) out.push(hm(m));
  return out;
}
export function duration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---- Formatting ----
export const dayName = (d) => DAYS[d.getDay()];
export function fmtDay(d) {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fmtDayLong(d) {
  return `${DAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function fmtWeekRange(monday) {
  const fri = addDays(monday, 4);
  if (monday.getMonth() === fri.getMonth()) {
    return `${monday.getDate()}–${fri.getDate()} ${MONTHS[fri.getMonth()]} ${fri.getFullYear()}`;
  }
  const y = monday.getFullYear() === fri.getFullYear() ? '' : ` ${monday.getFullYear()}`;
  return `${monday.getDate()} ${MONTHS[monday.getMonth()]}${y} – ${fri.getDate()} ${MONTHS[fri.getMonth()]} ${fri.getFullYear()}`;
}

// ---- Booking rules ----
export function overlaps(a0, a1, b0, b1) {
  return a0 < b1 && b0 < a1;
}

/** Returns an error message if a single booking breaks the opening-hours rules, else null. */
export function checkSlot(start, end, rules) {
  if (!(end > start)) return 'The end time must be after the start time.';
  if (dateKey(start) !== dateKey(end)) return 'A booking must start and end on the same day.';
  if (!isWeekday(start)) return 'Bookings are only possible Monday to Friday.';
  const s = minuteOfDay(start), e = minuteOfDay(end);
  if (s < rules.dayStart * 60 || e > rules.dayEnd * 60) {
    return `Bookings must be between ${hm(rules.dayStart * 60)} and ${hm(rules.dayEnd * 60)}.`;
  }
  return null;
}

/**
 * Turn a request ("first day, optional last day, from, until") into one slot per weekday.
 * Weekend days in the range are skipped and counted.
 */
export function expandRequest({ startKey, endKey, startTime, endTime }, rules) {
  const errors = [];
  if (!startKey) errors.push('Choose a date.');
  if (!startTime || !endTime) errors.push('Choose a start and end time.');
  if (errors.length) return { slots: [], skipped: 0, errors };

  const s = minutesOf(startTime), e = minutesOf(endTime);
  if (!(e > s)) errors.push('The end time must be after the start time.');
  if (s < rules.dayStart * 60 || e > rules.dayEnd * 60) {
    errors.push(`Bookings must be between ${hm(rules.dayStart * 60)} and ${hm(rules.dayEnd * 60)}.`);
  }
  const first = parseKey(startKey);
  const last = endKey ? parseKey(endKey) : first;
  if (last < first) errors.push('The last day must be on or after the first day.');
  if (errors.length) return { slots: [], skipped: 0, errors };

  const span = Math.round((last - first) / 86400000) + 1;
  if (span > rules.maxDays) {
    return { slots: [], skipped: 0, errors: [`You can book at most ${rules.maxDays} days in one go.`] };
  }
  const slots = [];
  let skipped = 0;
  for (let d = new Date(first); d <= last; d = addDays(d, 1)) {
    if (!isWeekday(d)) { skipped++; continue; }
    const k = dateKey(d);
    slots.push({ dateKey: k, start: at(k, startTime), end: at(k, endTime) });
  }
  if (!slots.length) errors.push('Bookings are only possible Monday to Friday. Pick a weekday.');
  return { slots, skipped, errors };
}

/** Every (slot, existing booking) pair that overlaps on the same resource. */
export function findConflicts(slots, bookings, resourceId, ignoreIds = new Set()) {
  const out = [];
  for (const slot of slots) {
    for (const b of bookings) {
      if (Number(b.resource_id) !== Number(resourceId) || ignoreIds.has(b.id)) continue;
      if (overlaps(slot.start, slot.end, new Date(b.start_at), new Date(b.end_at))) out.push({ slot, booking: b });
    }
  }
  return out;
}

/** Other resources of the same type that are free for all the slots. */
export function freeAlternatives(slots, bookings, resources, current) {
  return resources.filter((r) =>
    r.id !== current.id && r.kind === current.kind && r.status === 'available' &&
    findConflicts(slots, bookings, r.id).length === 0);
}

/**
 * For an admin override: what is left of an existing booking once `slot` is cut out of it.
 * Returns 0, 1 or 2 [start, end] pieces. 0 pieces means the booking is removed.
 */
export function carve(booking, slot) {
  const b0 = new Date(booking.start_at), b1 = new Date(booking.end_at);
  const pieces = [];
  if (b0 < slot.start) pieces.push([b0, new Date(Math.min(b1, slot.start))]);
  if (b1 > slot.end) pieces.push([new Date(Math.max(b0, slot.end)), b1]);
  return pieces;
}

/** Stable hue (0–359) for a user id, used to colour their bookings. */
export function hueFor(id = '') {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 360;
}
