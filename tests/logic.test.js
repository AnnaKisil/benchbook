import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/logic.js';

const R = L.makeRules({ DAY_START_HOUR: 8, DAY_END_HOUR: 18, SLOT_MINUTES: 30, MAX_RANGE_DAYS: 60 });

test('multi-day request skips weekends', () => {
  // Thu 29 Oct 2026 to Tue 3 Nov 2026 → Thu, Fri, Mon, Tue
  const { slots, skipped, errors } = L.expandRequest({ startKey: '2026-10-29', endKey: '2026-11-03', startTime: '09:00', endTime: '12:00' }, R);
  assert.deepEqual(errors, []);
  assert.equal(skipped, 2);
  assert.deepEqual(slots.map((s) => s.dateKey), ['2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03']);
  assert.equal(L.timeOf(slots[0].start), '09:00');
  assert.equal(L.timeOf(slots[3].end), '12:00');
});

test('weekend-only request is rejected', () => {
  const { errors } = L.expandRequest({ startKey: '2026-10-31', endKey: '2026-11-01', startTime: '09:00', endTime: '10:00' }, R);
  assert.match(errors[0], /Monday to Friday/);
});

test('times outside opening hours are rejected', () => {
  assert.match(L.expandRequest({ startKey: '2026-10-29', startTime: '07:30', endTime: '09:00' }, R).errors[0], /between 08:00 and 18:00/);
  assert.match(L.expandRequest({ startKey: '2026-10-29', startTime: '17:00', endTime: '18:30' }, R).errors[0], /between/);
  assert.deepEqual(L.expandRequest({ startKey: '2026-10-29', startTime: '08:00', endTime: '18:00' }, R).errors, []);
});

test('end before start and reversed date range are rejected', () => {
  assert.match(L.expandRequest({ startKey: '2026-10-29', startTime: '12:00', endTime: '11:00' }, R).errors[0], /after the start/);
  assert.match(L.expandRequest({ startKey: '2026-10-29', endKey: '2026-10-28', startTime: '09:00', endTime: '10:00' }, R).errors[0], /on or after/);
});

test('range limit', () => {
  assert.match(L.expandRequest({ startKey: '2026-01-01', endKey: '2026-12-31', startTime: '09:00', endTime: '10:00' }, R).errors[0], /at most 60/);
});

const bk = (id, res, key, s, e, user = 'u1') => ({ id, resource_id: res, user_id: user, start_at: L.at(key, s).toISOString(), end_at: L.at(key, e).toISOString() });

test('conflicts are found per resource and touching bookings are allowed', () => {
  const existing = [bk(1, 4, '2026-11-03', '09:00', '12:00'), bk(2, 5, '2026-11-03', '09:00', '12:00'), bk(3, 4, '2026-11-04', '12:00', '13:00')];
  const { slots } = L.expandRequest({ startKey: '2026-11-02', endKey: '2026-11-04', startTime: '11:00', endTime: '12:00' }, R);
  const c = L.findConflicts(slots, existing, 4);
  assert.equal(c.length, 1);
  assert.equal(c[0].booking.id, 1);
  assert.equal(c[0].slot.dateKey, '2026-11-03');
  assert.equal(L.findConflicts(slots, existing, 4, new Set([1])).length, 0);
});

test('free alternatives: same type, available, no clash', () => {
  const resources = [
    { id: 4, kind: 'Robot', status: 'available' }, { id: 5, kind: 'Robot', status: 'available' },
    { id: 6, kind: 'Robot', status: 'broken' }, { id: 7, kind: 'Robot', status: 'available' }, { id: 1, kind: 'PC', status: 'available' },
  ];
  const existing = [bk(1, 4, '2026-11-03', '09:00', '12:00'), bk(2, 5, '2026-11-03', '10:00', '11:00')];
  const { slots } = L.expandRequest({ startKey: '2026-11-03', startTime: '10:00', endTime: '11:00' }, R);
  assert.deepEqual(L.freeAlternatives(slots, existing, resources, resources[0]).map((r) => r.id), [7]);
});

test('carve for admin override', () => {
  const b = bk(1, 4, '2026-11-03', '09:00', '17:00');
  const slot = (s, e) => ({ start: L.at('2026-11-03', s), end: L.at('2026-11-03', e) });
  const t = (pieces) => pieces.map(([a, z]) => `${L.timeOf(a)}-${L.timeOf(z)}`);
  assert.deepEqual(t(L.carve(b, slot('10:00', '11:00'))), ['09:00-10:00', '11:00-17:00']);
  assert.deepEqual(t(L.carve(b, slot('08:00', '12:00'))), ['12:00-17:00']);
  assert.deepEqual(t(L.carve(b, slot('15:00', '18:00'))), ['09:00-15:00']);
  assert.deepEqual(L.carve(b, slot('08:00', '18:00')), []);
});

test('checkSlot', () => {
  assert.equal(L.checkSlot(L.at('2026-11-03', '09:00'), L.at('2026-11-03', '10:00'), R), null);
  assert.match(L.checkSlot(L.at('2026-10-31', '09:00'), L.at('2026-10-31', '10:00'), R), /Monday to Friday/);
  assert.match(L.checkSlot(L.at('2026-11-03', '09:00'), L.at('2026-11-04', '10:00'), R), /same day/);
});

test('week helpers', () => {
  assert.equal(L.dateKey(L.startOfWeek(L.parseKey('2026-11-01'))), '2026-10-26');
  assert.equal(L.dateKey(L.nextWeekday(L.parseKey('2026-10-31'))), '2026-11-02');
  assert.equal(L.dateKey(L.shiftWeekday(L.parseKey('2026-10-30'), 1)), '2026-11-02');
  assert.equal(L.dateKey(L.shiftWeekday(L.parseKey('2026-11-02'), -1)), '2026-10-30');
  assert.equal(L.fmtWeekRange(L.parseKey('2026-10-26')), '26–30 Oct 2026');
  assert.equal(L.fmtWeekRange(L.parseKey('2026-11-30')), '30 Nov – 4 Dec 2026');
});
