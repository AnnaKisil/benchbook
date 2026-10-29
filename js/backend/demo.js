// Demo backend: stores everything in this browser's localStorage.
// It mirrors the permission and conflict rules of the Supabase schema so the
// demo behaves like the real thing. Not secure, and not shared between people.

import * as L from '../logic.js';

const DB_KEY = 'benchbook-demo-v2';
const SESSION_KEY = 'benchbook-demo-session';
const memory = {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return memory[k] ?? null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { memory[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } delete memory[k]; },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
function fail(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

function seed() {
  const now = new Date().toISOString();
  const users = [
    { id: 'u-alice', email: 'alice@lab.example', display_name: 'Alice Moreno', role: 'admin' },
    { id: 'u-ben', email: 'ben@lab.example', display_name: 'Ben Okafor', role: 'member' },
    { id: 'u-chloe', email: 'chloe@lab.example', display_name: 'Chloe Lindqvist', role: 'member' },
    { id: 'u-dev', email: 'dev@lab.example', display_name: 'Dev Raman', role: 'member' },
    { id: 'u-erin', email: 'erin@lab.example', display_name: 'Erin Walsh', role: 'pending' },
  ].map((u) => ({ ...u, password: 'demo', created_at: now }));

  const lab = 'ACL-DIF';
  const resources = [
    { code: 'R01', name: 'FR3 - Aurora', kind: 'Robot', description: 'Franka-Research 3: For maintenance' },
    { code: 'R02', name: 'FR3 - Flora', kind: 'Robot', description: 'Franka-Research 3: Mostly for scooping - Robotiq 85 parallel mounted' },
    { code: 'R03', name: 'FP3', kind: 'Robot', description: 'Franka Production 3: Grey FR3 - Franka Hand' },
    { code: 'R04', name: 'UR7e', kind: 'Robot', description: 'Universal Robotics 7 - F/T sensor, Robotiq 85 gripper' },
    { code: 'R05', name: 'FER', kind: 'Robot', description: 'Franka Emika Panda - Franka Hand' },
    { code: 'C01', name: 'Hadrian', kind: 'Computer', description: 'i7/4090/64' },
    { code: 'C02', name: 'Tiberius', kind: 'Computer', description: 'i7/5090/128' },
    { code: 'C03', name: 'Augustus', kind: 'Computer', description: 'Tx 9970 x/509/128' },
    { code: 'C04', name: 'Sim2real', kind: 'Computer', description: 'i7/4090/64' },
    { code: 'C05', name: '3080', kind: 'Computer', description: 'i7/3080/64' },
  ].map((r, i) => ({ id: i + 1, location: lab, status: 'available', status_note: '', created_at: now, ...r }));
  const R = Object.fromEntries(resources.map((r) => [r.code, r.id]));

  // Example bookings around the current week, so the calendar is never empty.
  const monday = L.startOfWeek(L.nextWeekday(new Date()));
  let id = 1;
  const bookings = [];
  const add = (day, code, user, s, e, note = '', series = null) => {
    const k = L.dateKey(L.addDays(monday, day));
    bookings.push({ id: id++, resource_id: R[code], user_id: user, start_at: L.at(k, s).toISOString(), end_at: L.at(k, e).toISOString(), note, series_id: series, created_at: now });
  };
  for (const d of [0, 1, 2]) add(d, 'R04', 'u-ben', '09:00', '12:00', 'Grasping trials', 'demo-series-1');
  add(0, 'R02', 'u-dev', '13:00', '17:30', 'Scooping experiments');
  add(1, 'C02', 'u-chloe', '10:00', '16:00', 'Training the segmentation model');
  add(2, 'C03', 'u-alice', '08:00', '18:00', 'Benchmark run');
  add(3, 'R03', 'u-chloe', '09:30', '12:00', 'Demo for visitors');
  add(3, 'C04', 'u-dev', '14:00', '16:00', 'Sim-to-real transfer tests');
  add(3, 'C01', 'u-ben', '08:30', '11:00');
  add(4, 'C01', 'u-ben', '09:00', '11:00', 'Paper figures');
  add(4, 'R05', 'u-alice', '14:00', '17:00', 'Gripper calibration');
  for (const d of [7, 8]) add(d, 'C03', 'u-dev', '08:00', '18:00', 'Thesis simulations', 'demo-series-2');
  add(10, 'R04', 'u-ben', '13:00', '15:00', 'Grasping trials');
  add(9, 'R02', 'u-chloe', '10:00', '12:30');

  return { users, resources, bookings, nextResourceId: resources.length + 1, nextBookingId: id };
}

export async function createBackend(cfg) {
  const rules = L.makeRules(cfg);
  let db;
  try { db = JSON.parse(store.get(DB_KEY)); } catch { db = null; }
  if (!db || !Array.isArray(db.users)) { db = seed(); }
  const save = () => store.set(DB_KEY, JSON.stringify(db));
  save();

  const listeners = [];
  const emit = (event) => listeners.forEach((cb) => cb(event));
  const sessionUser = () => db.users.find((u) => u.id === store.get(SESSION_KEY)) || null;
  const publicUser = (u) => { const { password, ...rest } = u; return clone(rest); };

  const requireMember = () => {
    const u = sessionUser();
    if (!u) throw fail('Please sign in again.', 'auth');
    if (u.role === 'pending') throw fail('Your account is waiting for approval.', 'permission');
    return u;
  };
  const requireAdmin = () => {
    const u = requireMember();
    if (u.role !== 'admin') throw fail("You don't have permission to do that.", 'permission');
    return u;
  };

  // Same checks as the validate_booking trigger in schema.sql.
  const validate = (row, u, before) => {
    const s = new Date(row.start_at), e = new Date(row.end_at);
    const msg = L.checkSlot(s, e, rules);
    if (msg) throw fail(msg);
    const res = db.resources.find((r) => r.id === Number(row.resource_id));
    if (!res) throw fail('That resource no longer exists.');
    if (u.role !== 'admin') {
      if (row.user_id !== u.id) throw fail('You can only book for yourself.', 'permission');
      const slotChanged = !before || before.start_at !== row.start_at || before.end_at !== row.end_at || before.resource_id !== row.resource_id;
      if (slotChanged && res.status !== 'available') throw fail(`${res.name} is ${res.status} and cannot be booked right now.`);
    }
    const startChanged = !before || before.start_at !== row.start_at;
    if (startChanged && s < new Date(Date.now() - 60000)) throw fail('Bookings cannot start in the past.');
  };
  // Same as the bookings_no_overlap exclusion constraint.
  const assertFree = (rows, ignore = new Set()) => {
    const all = db.bookings.filter((b) => !ignore.has(b.id));
    rows.forEach((row, i) => {
      const s = new Date(row.start_at), e = new Date(row.end_at);
      const clash = all.concat(rows.slice(0, i)).some((b) =>
        Number(b.resource_id) === Number(row.resource_id) && L.overlaps(s, e, new Date(b.start_at), new Date(b.end_at)));
      if (clash) throw fail('That time overlaps an existing booking.', 'conflict');
    });
  };

  return {
    name: 'demo',
    demoAccounts: () => db.users.map(publicUser),
    reset() { db = seed(); save(); store.del(SESSION_KEY); emit('SIGNED_OUT'); },

    onAuthChange(cb) { listeners.push(cb); },
    async getCurrentUser() { const u = sessionUser(); return u ? publicUser(u) : null; },
    async signIn(email, password) {
      const u = db.users.find((x) => x.email.toLowerCase() === String(email).trim().toLowerCase());
      if (!u || u.password !== password) throw fail('Invalid login credentials');
      store.set(SESSION_KEY, u.id);
      emit('SIGNED_IN');
    },
    async signUp(email, password, displayName) {
      email = String(email).trim().toLowerCase();
      if (db.users.some((x) => x.email === email)) throw fail('An account with this email already exists.');
      const u = { id: 'u-' + Math.random().toString(36).slice(2, 10), email, display_name: displayName || email.split('@')[0], role: 'pending', password, created_at: new Date().toISOString() };
      db.users.push(u); save();
      store.set(SESSION_KEY, u.id);
      emit('SIGNED_IN');
      return { needsConfirmation: false };
    },
    async resetPassword() { throw fail('Password reset is not available in demo mode. Every demo password is "demo".'); },
    async updatePassword() { throw fail('Not available in demo mode.'); },
    async signOut() { store.del(SESSION_KEY); emit('SIGNED_OUT'); },

    async listProfiles() {
      requireMember();
      return db.users.map(publicUser).sort((a, b) => a.display_name.localeCompare(b.display_name));
    },
    async updateProfile(id, patch) {
      const u = requireMember();
      const target = db.users.find((x) => x.id === id);
      if (!target) throw fail('User not found.');
      if (u.role !== 'admin' && (id !== u.id || 'role' in patch)) throw fail("You don't have permission to do that.", 'permission');
      if ('role' in patch && target.role === 'admin' && patch.role !== 'admin' &&
          db.users.filter((x) => x.role === 'admin').length <= 1) {
        throw fail('The lab needs at least one admin. Make someone else an admin first.');
      }
      Object.assign(target, patch); save();
      return publicUser(target);
    },

    async listResources() {
      requireMember();
      return clone(db.resources).sort((a, b) => a.kind.localeCompare(b.kind) || (a.code || '').localeCompare(b.code || '') || a.name.localeCompare(b.name));
    },
    async saveResource(resource) {
      requireAdmin();
      if (resource.id) {
        const r = db.resources.find((x) => x.id === resource.id);
        if (!r) throw fail('Resource not found.');
        Object.assign(r, resource); save();
        return clone(r);
      }
      const r = { code: '', status: 'available', status_note: '', description: '', location: '', ...resource, id: db.nextResourceId++, created_at: new Date().toISOString() };
      db.resources.push(r); save();
      return clone(r);
    },
    async deleteResource(id) {
      requireAdmin();
      db.resources = db.resources.filter((r) => r.id !== id);
      db.bookings = db.bookings.filter((b) => b.resource_id !== id);
      save();
    },

    async listBookings(fromIso, toIso, opts = {}) {
      requireMember();
      const from = new Date(fromIso), to = new Date(toIso);
      return clone(db.bookings
        .filter((b) => new Date(b.start_at) < to && new Date(b.end_at) > from)
        .filter((b) => !opts.userId || b.user_id === opts.userId)
        .filter((b) => !opts.resourceId || b.resource_id === opts.resourceId)
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at)));
    },
    async listSeries(seriesId) {
      requireMember();
      return clone(db.bookings.filter((b) => b.series_id === seriesId).sort((a, b) => new Date(a.start_at) - new Date(b.start_at)));
    },
    async createBookings(rows) {
      const u = requireMember();
      const clean = rows.map((r) => ({ note: '', series_id: null, ...r, resource_id: Number(r.resource_id) }));
      clean.forEach((r) => validate(r, u, null));
      assertFree(clean);
      const created = clean.map((r) => ({ ...r, id: db.nextBookingId++, created_at: new Date().toISOString() }));
      db.bookings.push(...created); save();
      return clone(created);
    },
    async updateBooking(id, patch) {
      const u = requireMember();
      const b = db.bookings.find((x) => x.id === id);
      if (!b) throw fail('That booking no longer exists.');
      if (u.role !== 'admin' && b.user_id !== u.id) throw fail("You don't have permission to do that.", 'permission');
      const next = { ...b, ...patch, resource_id: Number(patch.resource_id ?? b.resource_id) };
      validate(next, u, b);
      assertFree([next], new Set([id]));
      Object.assign(b, next); save();
      return clone(b);
    },
    async deleteBookings(ids) {
      const u = requireMember();
      const set = new Set(ids);
      const targets = db.bookings.filter((b) => set.has(b.id));
      if (u.role !== 'admin' && targets.some((b) => b.user_id !== u.id)) throw fail("You don't have permission to do that.", 'permission');
      db.bookings = db.bookings.filter((b) => !set.has(b.id));
      save();
    },
  };
}
