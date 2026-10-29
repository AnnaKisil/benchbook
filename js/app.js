// BenchBook: resource booking for a research lab.
// Plain ES modules, no build step. The UI talks to a "backend" object which is
// either the shared Supabase backend or the in-browser demo backend.

import { CONFIG } from './config.js';
import * as L from './logic.js';

const RULES = L.makeRules(CONFIG);
const TIMES = L.timeOptions(RULES);
const HOURS = RULES.dayEnd - RULES.dayStart;
const DAY_MIN = HOURS * 60;
const LAB = CONFIG.LAB_NAME || 'Research lab';

const app = document.getElementById('app');
const dlg = document.getElementById('dlg');
const askDlg = document.getElementById('ask');
const toasts = document.getElementById('toasts');
document.documentElement.style.setProperty('--hours', HOURS);

const STATUS = {
  available: { label: 'Available', cls: 'ok' },
  unavailable: { label: 'Unavailable', cls: 'off' },
  maintenance: { label: 'Maintenance', cls: 'warn' },
  broken: { label: 'Broken', cls: 'bad' },
};
const ROLE = { pending: 'Waiting for approval', member: 'Member', admin: 'Admin' };

const ICON = {
  logo: '<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect x="1.5" y="1.5" width="29" height="29" rx="7" fill="none" stroke="currentColor" stroke-width="2.5"/><rect x="7" y="8.5" width="12" height="4" rx="1.5" fill="currentColor"/><rect x="12" y="14.5" width="13" height="4" rx="1.5" fill="currentColor" opacity=".55"/><rect x="7" y="20.5" width="8" height="4" rx="1.5" fill="currentColor"/></svg>',
  left: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12.5 4.5 7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 4.5 13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

// ---------- Small helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const errMsg = (e) => (e && e.message) || String(e || 'Something went wrong.');
const pref = {
  get(k, d) { try { return localStorage.getItem('benchbook-' + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('benchbook-' + k, v); } catch { /* ignore */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));

function toast(msg, kind = 'ok') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  toasts.append(t);
  setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
}

// ---------- State ----------
const state = {
  be: null,
  user: null,
  profiles: new Map(),
  resources: [],
  bookings: [],       // bookings in the visible calendar range
  mine: [],           // bookings shown in "My bookings"
  mode: pref.get('mode', 'week'),
  kind: pref.get('kind', 'all'),
  anchor: L.nextWeekday(new Date()),
  mineTab: 'upcoming',
  manageTab: 'resources',
};

const me = () => state.user?.id;
const isAdmin = () => state.user?.role === 'admin';
const person = (id) => state.profiles.get(id) || { id, display_name: 'Former member', email: '' };
const resById = (id) => state.resources.find((r) => r.id === Number(id));
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0].toUpperCase()).join('') || '?';
const firstName = (name = '') => name.split(/\s+/)[0] || name;
const kinds = () => [...new Set(state.resources.map((r) => r.kind))].sort();
const findBooking = (id) => [...state.bookings, ...state.mine].find((b) => String(b.id) === String(id));
const bookers = () => [...state.profiles.values()].filter((p) => p.role !== 'pending');
const avatar = (p) => `<span class="avatar" style="--h:${L.hueFor(p.id)}" aria-hidden="true">${esc(initials(p.display_name))}</span>`;
const statusPill = (r) => r.status === 'available' ? ''
  : `<span class="pill ${STATUS[r.status]?.cls || 'off'}" title="${esc(r.status_note || '')}">${esc(STATUS[r.status]?.label || r.status)}</span>`;

// ---------- Boot & auth ----------
async function boot() {
  try {
    const useSupabase = Boolean(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_KEY);
    const mod = useSupabase ? await import('./backend/supabase.js') : await import('./backend/demo.js');
    state.be = await mod.createBackend(CONFIG);
  } catch (e) {
    app.innerHTML = `<div class="wrap"><div class="empty error" style="margin-top:40px"><h2>BenchBook could not start</h2><p>${esc(errMsg(e))}</p><p>Check the Supabase settings in js/config.js.</p></div></div>`;
    return;
  }
  state.be.onAuthChange((event) => {
    if (event === 'PASSWORD_RECOVERY') return renderSetPassword();
    if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') refreshAuth();
  });
  window.addEventListener('hashchange', () => { if (isMemberUser()) route(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) softRefresh(); });
  setInterval(softRefresh, 60000);
  await refreshAuth();
}

const isMemberUser = () => state.user && state.user.role !== 'pending';

let authSeq = 0;
async function refreshAuth(force = false) {
  const seq = ++authSeq;
  let user = null;
  try { user = await state.be.getCurrentUser(); } catch (e) { console.error(e); }
  if (seq !== authSeq) return;
  const prev = state.user;
  if (!force && user && prev && user.id === prev.id && user.role === prev.role) return;
  state.user = user;
  if (!user) return renderLogin();
  if (user.role === 'pending') return renderPending();
  renderShell();
  await route();
}

function softRefresh() {
  if (!isMemberUser() || dlg.open || askDlg.open || document.hidden) return;
  route(true);
}

// ---------- Sign-in screens ----------
function sampleBoard() {
  // Purely illustrative timeline for the sign-in page.
  const rows = [
    ['PC-01', [[1, 4, 210], [5, 8.5, 30]]],
    ['UR5e arm', [[0.5, 3, 140], [6, 9, 300]]],
    ['Franka FR3', [[2, 6.5, 30]]],
    ['TurtleBot B', null],
  ];
  const ticks = [];
  for (let h = RULES.dayStart; h <= RULES.dayEnd; h += 2) ticks.push(`<span>${L.pad(h)}:00</span>`);
  return `<div class="board">
    <div class="board-head"><span>Example day</span><span>Mon–Fri · ${L.hm(RULES.dayStart * 60)}–${L.hm(RULES.dayEnd * 60)}</span></div>
    ${rows.map(([name, blocks]) => `<div class="board-row"><span>${name}</span>
      <div class="track ${blocks ? '' : 'is-blocked'}">${(blocks || []).map(([a, b, h]) =>
        `<span class="blk" style="left:${a / HOURS * 100}%;width:${(b - a) / HOURS * 100}%;--h:${h}"></span>`).join('')}</div></div>`).join('')}
    <div class="board-row"><span></span><div class="ticks">${ticks.join('')}</div></div>
  </div>
  <p class="board-cap">Every PC and robot on one timeline. Book a slot or a run of weekdays in one go, and see straight away who has a resource when it is taken.</p>`;
}

function renderLogin(mode = 'signin', notice = '') {
  const demo = state.be.name === 'demo';
  const allowSignup = CONFIG.ALLOW_SIGNUP !== false;
  const demoPick = demo && mode === 'signin' ? `
    <div class="demo-pick">
      <p class="eyebrow">Demo accounts · password “demo”</p>
      <div class="demo-users">${state.be.demoAccounts().map((u) => `
        <button type="button" class="demo-user" data-action="demo-login" data-email="${esc(u.email)}">
          ${avatar(u)}<span><b>${esc(u.display_name)}</b><small>${esc(ROLE[u.role])}</small></span>
        </button>`).join('')}
      </div>
    </div>
    <div class="divider">or sign in with email</div>` : '';
  const title = { signin: 'Sign in', signup: 'Create an account', reset: 'Reset your password' }[mode];
  app.innerHTML = `
  <main class="login">
    <section class="login-card">
      <div class="brand-row">${ICON.logo}<div><p class="eyebrow">${esc(LAB)}</p><h1 class="brand">BenchBook</h1></div></div>
      <p class="lede">Book the lab's PCs and robots and see who has what, Monday to Friday, ${L.hm(RULES.dayStart * 60)} to ${L.hm(RULES.dayEnd * 60)}.</p>
      ${notice ? `<p class="notice">${esc(notice)}</p>` : ''}
      ${demoPick}
      <form id="auth-form" class="stack" data-mode="${mode}" novalidate>
        ${mode === 'signup' ? '<div class="field"><label for="au-name">Your name</label><input id="au-name" autocomplete="name" required></div>' : ''}
        <div class="field"><label for="au-email">Email</label><input id="au-email" type="email" autocomplete="email" required></div>
        ${mode !== 'reset' ? `<div class="field"><label for="au-pass">Password${mode === 'signup' ? ' <em>(at least 8 characters)</em>' : ''}</label><input id="au-pass" type="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></div>` : ''}
        <div id="au-error" class="form-error" role="alert"></div>
        <button class="btn primary block" type="submit">${title}</button>
      </form>
      <div class="login-links">
        ${mode === 'signin'
          ? `${allowSignup ? '<button type="button" class="link" data-action="auth-mode" data-mode="signup">Create an account</button>' : ''}
             ${!demo ? '<button type="button" class="link" data-action="auth-mode" data-mode="reset">Forgot your password?</button>' : ''}`
          : '<button type="button" class="link" data-action="auth-mode" data-mode="signin">Back to sign in</button>'}
      </div>
    </section>
    <aside class="login-side" aria-hidden="true">${sampleBoard()}</aside>
  </main>`;
  document.getElementById('auth-form').addEventListener('submit', onAuthSubmit);
}

async function onAuthSubmit(ev) {
  ev.preventDefault();
  const f = ev.currentTarget;
  const mode = f.dataset.mode;
  const err = document.getElementById('au-error');
  const email = document.getElementById('au-email').value.trim();
  const pass = document.getElementById('au-pass')?.value || '';
  const name = document.getElementById('au-name')?.value.trim() || '';
  err.textContent = '';
  if (!email) { err.textContent = 'Enter your email address.'; return; }
  if (mode !== 'reset' && !pass) { err.textContent = 'Enter your password.'; return; }
  if (mode === 'signup' && !name) { err.textContent = 'Enter your name so others can see who booked what.'; return; }
  if (mode === 'signup' && pass.length < 8) { err.textContent = 'Use a password of at least 8 characters.'; return; }
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (mode === 'signin') {
      await state.be.signIn(email, pass);
      await refreshAuth();
    } else if (mode === 'signup') {
      const res = await state.be.signUp(email, pass, name);
      if (res.needsConfirmation) renderLogin('signin', `We sent a confirmation link to ${email}. Open it, then sign in here.`);
      else await refreshAuth();
    } else {
      await state.be.resetPassword(email);
      renderLogin('signin', 'If that email has an account, a reset link is on its way.');
    }
  } catch (e) {
    err.textContent = /invalid login/i.test(errMsg(e)) ? 'That email and password do not match an account.' : errMsg(e);
    btn.disabled = false;
  }
}

function renderPending() {
  const u = state.user;
  app.innerHTML = `
  <main class="login">
    <section class="login-card">
      <div class="brand-row">${ICON.logo}<div><p class="eyebrow">${esc(LAB)}</p><h1 class="brand">BenchBook</h1></div></div>
      <div class="stack">
        <h2 style="margin:0;font:700 22px/1.2 var(--font-display)">Waiting for approval</h2>
        <p class="lede">Your account for <b>${esc(u.email)}</b> has been created. A lab admin needs to approve it before you can see and book resources.</p>
      </div>
      <div class="login-links">
        <button type="button" class="btn primary" data-action="recheck">Check again</button>
        <button type="button" class="btn ghost" data-action="sign-out">Sign out</button>
      </div>
    </section>
    <aside class="login-side" aria-hidden="true">${sampleBoard()}</aside>
  </main>`;
}

function renderSetPassword() {
  dlg.innerHTML = `
  <form class="sheet" id="pw-form">
    <header><h2>Choose a new password</h2></header>
    <div class="sheet-body">
      <div class="field"><label for="pw-new">New password <em>(at least 8 characters)</em></label><input id="pw-new" type="password" autocomplete="new-password" required></div>
      <div id="pw-error" class="form-error" role="alert"></div>
    </div>
    <footer><span class="spacer"></span><button class="btn primary" type="submit">Save password</button></footer>
  </form>`;
  dlg.showModal();
  dlg.querySelector('#pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pw = dlg.querySelector('#pw-new').value;
    const err = dlg.querySelector('#pw-error');
    if (pw.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    try {
      await state.be.updatePassword(pw);
      dlg.close();
      toast('Password updated.');
      refreshAuth(true);
    } catch (e) { err.textContent = errMsg(e); }
  });
}

// ---------- App shell & routing ----------
function renderShell() {
  const u = state.user;
  const demo = state.be.name === 'demo';
  app.innerHTML = `
  ${demo ? `<div class="demo-bar"><div class="wrap demo-in"><span><b>Demo mode.</b> Bookings are saved in this browser only. Connect Supabase (see the README) to share them with your group.</span><button type="button" class="link" data-action="reset-demo">Reset demo data</button></div></div>` : ''}
  <header class="top">
    <div class="wrap top-in">
      <a class="brandmark" href="#calendar">${ICON.logo}<span class="bm-text"><b>BenchBook</b><small>${esc(LAB)}</small></span></a>
      <nav class="tabs" aria-label="Main">
        <a href="#calendar" data-view="calendar">Calendar</a>
        <a href="#mine" data-view="mine">My bookings</a>
        ${isAdmin() ? '<a href="#manage" data-view="manage">Manage</a>' : ''}
      </nav>
      <div class="me">
        ${avatar(u)}
        <span class="me-text"><b>${esc(u.display_name)}</b><small>${esc(ROLE[u.role])}</small></span>
        <button type="button" class="btn ghost sm" data-action="sign-out">Sign out</button>
      </div>
    </div>
  </header>
  <main id="view" class="wrap view"></main>
  <footer class="wrap foot">BenchBook · open-source lab booking · times shown in your local time zone</footer>`;
}

function currentView() {
  const v = location.hash.slice(1) || 'calendar';
  if (v === 'manage' && !isAdmin()) return 'calendar';
  return ['calendar', 'mine', 'manage'].includes(v) ? v : 'calendar';
}

async function loadBase() {
  const [profiles, resources] = await Promise.all([state.be.listProfiles(), state.be.listResources()]);
  state.profiles = new Map(profiles.map((p) => [p.id, p]));
  state.resources = resources;
  const fresh = state.profiles.get(me());
  if (fresh) state.user = { ...state.user, ...fresh };
}

async function route(silent = false) {
  const view = document.getElementById('view');
  if (!view) return;
  const v = currentView();
  app.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.view === v ? 'page' : 'false'));
  try {
    const roleBefore = state.user.role;
    await loadBase();
    if (state.user.role !== roleBefore) { refreshAuth(true); return; }
    if (v === 'calendar') await renderCalendar(view);
    else if (v === 'mine') await renderMine(view);
    else await renderManage(view);
  } catch (e) {
    if (silent) return;
    view.innerHTML = `<div class="empty error" style="margin-top:24px"><h2>Could not load data</h2><p>${esc(errMsg(e))}</p><button type="button" class="btn" data-action="retry">Try again</button></div>`;
  }
}

// ---------- Calendar ----------
function visibleResources() {
  return state.resources.filter((r) => state.kind === 'all' || r.kind === state.kind);
}

function blockHtml(b, axis) {
  const s = new Date(b.start_at), e = new Date(b.end_at);
  const from = Math.max(0, (L.minuteOfDay(s) - RULES.dayStart * 60) / DAY_MIN * 100);
  const len = Math.min(100 - from, (e - s) / 60000 / DAY_MIN * 100);
  const p = person(b.user_id);
  const mine = b.user_id === me();
  const pos = axis === 'h' ? `left:${from}%;width:${len}%` : `top:${from}%;height:${len}%`;
  const label = mine ? 'You' : (axis === 'h' ? firstName(p.display_name) : p.display_name);
  const tip = `${mine ? 'You' : p.display_name} · ${L.timeOf(s)}–${L.timeOf(e)}${b.note ? ' · ' + b.note : ''}`;
  const extra = axis === 'v'
    ? `<span class="blk-time">${L.timeOf(s)}–${L.timeOf(e)}</span>${b.note ? `<span class="blk-note">${esc(b.note)}</span>` : ''}`
    : '';
  return `<button type="button" class="blk ${mine ? 'mine' : ''}" style="${pos};--h:${L.hueFor(b.user_id)}" data-action="open-booking" data-id="${esc(b.id)}" title="${esc(tip)}" aria-label="${esc(tip)}"><span>${esc(label)}</span>${extra}</button>`;
}

function nowLine(dayKey, axis) {
  const now = new Date();
  if (L.dateKey(now) !== dayKey) return '';
  const m = L.minuteOfDay(now) - RULES.dayStart * 60;
  if (m < 0 || m > DAY_MIN) return '';
  const pct = m / DAY_MIN * 100;
  return `<span class="now-line" style="${axis === 'h' ? 'left' : 'top'}:${pct}%"></span>`;
}

function bookingsOn(resId, dayKey) {
  return state.bookings.filter((b) => b.resource_id === resId && L.dateKey(new Date(b.start_at)) === dayKey);
}

function resLabel(r) {
  return `<span class="kind-tag">${esc(r.kind)}</span>${statusPill(r)}<span class="res-name">${esc(r.name)}</span>`;
}

function weekGrid(days, res) {
  const todayKey = L.dateKey(new Date());
  const ticks = [];
  for (let h = RULES.dayStart; h <= RULES.dayEnd; h += 2) ticks.push(`<span style="left:${(h - RULES.dayStart) / HOURS * 100}%">${L.pad(h)}</span>`);
  const head = days.map((d) => `
    <div class="wk-day ${L.dateKey(d) === todayKey ? 'is-today' : ''}">
      <button type="button" class="wk-day-btn" data-action="goto-day" data-date="${L.dateKey(d)}" title="Open ${L.fmtDay(d)} in day view">${L.dayName(d)} <b>${d.getDate()}</b></button>
      <div class="ticks" aria-hidden="true">${ticks.join('')}</div>
    </div>`).join('');
  const rows = res.map((r) => {
    const blocked = r.status !== 'available';
    return `<div class="res-cell" title="${esc([r.location, r.description, r.status_note].filter(Boolean).join(' · '))}">${resLabel(r)}</div>` +
      days.map((d) => {
        const k = L.dateKey(d);
        const past = k < todayKey ? ' is-past' : '';
        return `<div class="track${blocked ? ' is-blocked' : ''}${past}" data-action="slot" data-res="${r.id}" data-date="${k}">${bookingsOn(r.id, k).map((b) => blockHtml(b, 'h')).join('')}${nowLine(k, 'h')}</div>`;
      }).join('');
  }).join('');
  return `<div class="grid-scroll"><div class="wk" style="--cols:${days.length}"><div class="wk-corner">Resource</div>${head}${rows}</div></div>`;
}

function dayGrid(day, res) {
  const k = L.dateKey(day);
  const labels = [];
  for (let h = RULES.dayStart; h <= RULES.dayEnd; h++) {
    if (h === RULES.dayEnd) continue;
    labels.push(`<span style="top:${(h - RULES.dayStart) / HOURS * 100}%">${L.pad(h)}:00</span>`);
  }
  return `<div class="grid-scroll"><div class="dv" style="--cols:${res.length}">
    <div class="dv-corner"></div>
    ${res.map((r) => `<div class="dv-head">${resLabel(r)}</div>`).join('')}
    <div class="dv-times" aria-hidden="true"><div class="dv-times-in">${labels.join('')}</div></div>
    ${res.map((r) => `<div class="dv-col${r.status !== 'available' ? ' is-blocked' : ''}${k < L.dateKey(new Date()) ? ' is-past' : ''}" data-action="slot" data-axis="v" data-res="${r.id}" data-date="${k}">${bookingsOn(r.id, k).map((b) => blockHtml(b, 'v')).join('')}${nowLine(k, 'v')}</div>`).join('')}
  </div></div>`;
}

async function renderCalendar(view) {
  const week = state.mode === 'week';
  if (!week && !L.isWeekday(state.anchor)) state.anchor = L.nextWeekday(state.anchor);
  const start = week ? L.startOfWeek(state.anchor) : L.startOfDay(state.anchor);
  const end = L.addDays(start, week ? 5 : 1);
  state.bookings = await state.be.listBookings(start.toISOString(), end.toISOString());
  if (state.kind !== 'all' && !kinds().includes(state.kind)) state.kind = 'all';
  const res = visibleResources();
  const days = week ? [0, 1, 2, 3, 4].map((i) => L.addDays(start, i)) : [start];
  const unit = week ? 'week' : 'day';

  view.innerHTML = `
  <section class="cal">
    <div class="cal-bar">
      <div class="cal-nav">
        <button type="button" class="icon-btn" data-action="cal-prev" aria-label="Previous ${unit}">${ICON.left}</button>
        <button type="button" class="btn sm" data-action="cal-today">Today</button>
        <button type="button" class="icon-btn" data-action="cal-next" aria-label="Next ${unit}">${ICON.right}</button>
        <h1 class="cal-title">${week ? L.fmtWeekRange(start) : L.fmtDayLong(start)}</h1>
      </div>
      <div class="cal-tools">
        <div class="seg" role="group" aria-label="Calendar view">
          <button type="button" data-action="cal-mode" data-mode="week" aria-pressed="${week}">Week</button>
          <button type="button" data-action="cal-mode" data-mode="day" aria-pressed="${!week}">Day</button>
        </div>
        ${kinds().length > 1 ? `<div class="seg" role="group" aria-label="Show resources">
          <button type="button" data-action="cal-kind" data-kind="all" aria-pressed="${state.kind === 'all'}">All</button>
          ${kinds().map((k) => `<button type="button" data-action="cal-kind" data-kind="${esc(k)}" aria-pressed="${state.kind === k}">${esc(k)}</button>`).join('')}
        </div>` : ''}
        <button type="button" class="btn primary" data-action="new-booking">${ICON.plus}New booking</button>
      </div>
    </div>
    ${res.length ? (week ? weekGrid(days, res) : dayGrid(start, res)) : `
      <div class="empty"><h2>No resources yet</h2>
      <p>${isAdmin() ? 'Add the lab\'s PCs and robots under Manage, then they will appear here.' : 'An admin needs to add the lab\'s PCs and robots before anything can be booked.'}</p>
      ${isAdmin() ? '<a class="btn primary" href="#manage">Add resources</a>' : ''}</div>`}
    ${res.length ? `<p class="cal-hint">Click an empty slot to book it, or a booking to see who has it. Your own bookings are highlighted. Striped rows cannot be booked right now.</p>` : ''}
  </section>`;
}

// ---------- Booking form ----------
let form = null; // context for the open booking form

function resourceOptions(selectedId, keepId) {
  return kinds().map((k) => `<optgroup label="${esc(k)}">${state.resources.filter((r) => r.kind === k).map((r) => {
    const off = r.status !== 'available';
    const disabled = off && !isAdmin() && r.id !== keepId;
    return `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${esc(r.name)}${off ? ` (${STATUS[r.status].label.toLowerCase()})` : ''}</option>`;
  }).join('')}</optgroup>`).join('');
}
// ---------- Time picker ----------
// A small custom list instead of a native <select>. Native dropdowns inside a
// modal dialog close immediately in some browsers; this one stays open until
// a time is picked, Escape is pressed or the person clicks elsewhere.
const CHEVRON = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 8 10 12.5 14.5 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function timePicker(id, value, which) {
  const list = which === 'start' ? TIMES.slice(0, -1) : TIMES.slice(1);
  return `<div class="tp" data-which="${which}">
    <button type="button" class="tp-btn" id="${id}" data-value="${value}" aria-haspopup="listbox" aria-expanded="false"><span class="mono tp-val">${value}</span>${CHEVRON}</button>
    <div class="tp-list" role="listbox" aria-labelledby="${id}" hidden>${list.map((t) =>
      `<button type="button" class="tp-opt" role="option" data-time="${t}" aria-selected="${t === value}" tabindex="-1"><span>${t}</span><small></small></button>`).join('')}</div>
  </div>`;
}

function closePickers(except) {
  document.querySelectorAll('.tp-list:not([hidden])').forEach((list) => {
    if (list === except) return;
    list.hidden = true;
    list.parentElement.querySelector('.tp-btn').setAttribute('aria-expanded', 'false');
  });
}

function openPicker(btn, focusSelected = false) {
  const list = btn.parentElement.querySelector('.tp-list');
  closePickers(list);
  const value = btn.dataset.value;
  const isEnd = btn.parentElement.dataset.which === 'end';
  const start = isEnd ? L.minutesOf(dlg.querySelector('#bk-start').dataset.value) : null;
  list.querySelectorAll('.tp-opt').forEach((o) => {
    const t = o.dataset.time;
    o.setAttribute('aria-selected', String(t === value));
    if (isEnd) {
      const len = L.minutesOf(t) - start;
      o.disabled = len <= 0;
      o.querySelector('small').textContent = len > 0 ? L.duration(len) : '';
    }
  });
  // Position against the viewport so the list is never clipped by the dialog.
  const r = btn.getBoundingClientRect();
  const below = innerHeight - r.bottom - 12, above = r.top - 12;
  const placeBelow = below >= 220 || below >= above;
  const max = Math.max(140, Math.min(280, placeBelow ? below : above));
  Object.assign(list.style, {
    left: `${r.left}px`, width: `${r.width}px`, maxHeight: `${max}px`,
    top: placeBelow ? `${r.bottom + 4}px` : 'auto',
    bottom: placeBelow ? 'auto' : `${innerHeight - r.top + 4}px`,
  });
  list.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const sel = list.querySelector('[aria-selected="true"]') || list.querySelector('.tp-opt:not(:disabled)');
  if (sel) {
    list.scrollTop = sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2;
    if (focusSelected) sel.focus();
  }
}

function setPickerValue(btn, t) {
  btn.dataset.value = t;
  btn.querySelector('.tp-val').textContent = t;
  // Moving the start keeps the same length of booking where it fits.
  if (btn.id === 'bk-start') {
    const endBtn = dlg.querySelector('#bk-end');
    const s = L.minutesOf(t), e = L.minutesOf(endBtn.dataset.value);
    if (e <= s) {
      const next = L.hm(Math.min(s + 60, RULES.dayEnd * 60));
      endBtn.dataset.value = next;
      endBtn.querySelector('.tp-val').textContent = next;
    }
  }
  btn.dispatchEvent(new Event('input', { bubbles: true }));
}

function choosePickerOption(opt) {
  const btn = opt.closest('.tp').querySelector('.tp-btn');
  closePickers();
  setPickerValue(btn, opt.dataset.time);
  btn.focus();
}

document.addEventListener('keydown', (ev) => {
  const btn = ev.target.closest?.('.tp-btn');
  const opt = ev.target.closest?.('.tp-opt');
  if (btn && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(ev.key)) {
    ev.preventDefault();
    openPicker(btn, true);
  } else if (opt) {
    const opts = [...opt.parentElement.querySelectorAll('.tp-opt:not(:disabled)')];
    const i = opts.indexOf(opt);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      opts[Math.max(0, Math.min(opts.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation(); // close the list, not the whole dialog
      closePickers();
      opt.closest('.tp').querySelector('.tp-btn').focus();
    } else if (ev.key === 'Tab') {
      closePickers();
    }
  } else if (ev.key === 'Escape' && document.querySelector('.tp-list:not([hidden])')) {
    ev.preventDefault();
    closePickers();
  }
}, true);
document.addEventListener('scroll', (ev) => {
  if (!ev.target.classList?.contains('tp-list')) closePickers();
}, true);
window.addEventListener('resize', () => closePickers());

function defaultSlot(dayKey) {
  const now = new Date();
  let start = 9 * 60;
  if (dayKey === L.dateKey(now)) start = Math.ceil(L.minuteOfDay(now) / RULES.step) * RULES.step;
  start = Math.min(Math.max(start, RULES.dayStart * 60), RULES.dayEnd * 60 - RULES.step);
  return { startTime: L.hm(start), endTime: L.hm(Math.min(start + 60, RULES.dayEnd * 60)) };
}

function defaultDayKey() {
  if (state.mode === 'day' && currentView() === 'calendar') return L.dateKey(state.anchor);
  let d = new Date();
  if (L.minuteOfDay(d) >= RULES.dayEnd * 60 - RULES.step) d = L.addDays(d, 1);
  return L.dateKey(L.nextWeekday(d));
}

async function openBookingForm(opts = {}) {
  if (!state.resources.length) { toast('There are no resources to book yet.', 'err'); return; }
  const b = opts.booking || null;
  let series = [];
  if (b?.series_id) { try { series = await state.be.listSeries(b.series_id); } catch { series = []; } }
  const now = new Date();
  const seriesFuture = series.filter((x) => new Date(x.end_at) > now);

  const fallbackRes = visibleResources().find((r) => r.status === 'available') || state.resources.find((r) => r.status === 'available') || state.resources[0];
  const resId = b ? b.resource_id : Number(opts.resourceId ?? fallbackRes.id);
  const dayKey = b ? L.dateKey(new Date(b.start_at)) : (opts.dateKey || defaultDayKey());
  const times = b ? { startTime: L.timeOf(new Date(b.start_at)), endTime: L.timeOf(new Date(b.end_at)) }
    : (opts.startTime ? { startTime: opts.startTime, endTime: opts.endTime } : defaultSlot(dayKey));
  const owner = b ? b.user_id : me();
  const minDate = isAdmin() ? '' : `min="${L.dateKey(now)}"`;
  const showSeries = b && seriesFuture.length > 1 && seriesFuture.some((x) => x.id === b.id);
  form = { booking: b, seriesFuture };

  const ownerField = isAdmin() ? `
    <div class="field"><label for="bk-user">${b ? 'Booked for' : 'Book for'}</label>
      <select id="bk-user">${bookers().map((p) => `<option value="${esc(p.id)}" ${p.id === owner ? 'selected' : ''}>${esc(p.display_name)}${p.id === me() ? ' (you)' : ''}</option>`).join('')}</select>
    </div>` : '';

  dlg.innerHTML = `
  <form class="sheet" id="bk-form" novalidate>
    <header><h2>${b ? 'Edit booking' : 'New booking'}</h2><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="sheet-body">
      ${b && b.user_id !== me() ? `<p class="notice">You are editing ${esc(person(b.user_id).display_name)}'s booking as an admin.</p>` : ''}
      <div class="field"><label for="bk-res">Resource</label><select id="bk-res">${resourceOptions(resId, b?.resource_id)}</select></div>
      <div class="row2">
        <div class="field"><label for="bk-from">${b ? 'Date' : 'First day'}</label><input type="date" id="bk-from" value="${dayKey}" ${minDate} required></div>
        ${b ? '' : `<div class="field"><label for="bk-to">Last day <em>(optional, for several days)</em></label><input type="date" id="bk-to" ${minDate}></div>`}
      </div>
      <div class="row2">
        <div class="field"><label for="bk-start">From</label>${timePicker('bk-start', times.startTime, 'start')}</div>
        <div class="field"><label for="bk-end">Until</label>${timePicker('bk-end', times.endTime, 'end')}</div>
      </div>
      ${ownerField}
      <div class="field"><label for="bk-note">Purpose <em>(optional)</em></label><input id="bk-note" maxlength="200" value="${esc(b?.note || '')}" placeholder="e.g. grasping trials, thesis simulations"></div>
      ${showSeries ? `<label class="check"><input type="checkbox" id="bk-series"><span>Apply the new times, resource and purpose to all ${seriesFuture.length} upcoming days of this multi-day booking</span></label>` : ''}
      <p class="summary" id="bk-summary"></p>
      <div class="feedback" id="bk-feedback" aria-live="polite"></div>
    </div>
    <footer>
      ${b ? '<button type="button" class="btn danger-ghost" data-action="bk-delete">Delete…</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="btn ghost" data-close>Cancel</button>
      <button type="submit" class="btn primary" id="bk-submit">${b ? 'Save changes' : 'Book'}</button>
    </footer>
  </form>`;
  dlg.showModal();
  const f = dlg.querySelector('#bk-form');
  f.addEventListener('input', onFormInput);
  f.addEventListener('change', onFormInput);
  f.addEventListener('submit', (ev) => { ev.preventDefault(); submitBooking(); });
  updateSummary();
}

function onFormInput(ev) {
  const from = dlg.querySelector('#bk-from');
  const to = dlg.querySelector('#bk-to');
  if (ev.target === from && to) to.min = from.value;
  const series = dlg.querySelector('#bk-series');
  if (series) from.disabled = series.checked;
  dlg.querySelector('#bk-feedback').innerHTML = '';
  updateSummary();
}

function readForm() {
  const q = (id) => dlg.querySelector('#' + id);
  return {
    resourceId: Number(q('bk-res').value),
    startKey: q('bk-from').value,
    endKey: q('bk-to')?.value || '',
    startTime: q('bk-start').dataset.value,
    endTime: q('bk-end').dataset.value,
    note: q('bk-note').value.trim(),
    userId: q('bk-user')?.value || form.booking?.user_id || me(),
    applySeries: Boolean(q('bk-series')?.checked),
  };
}

function computeSlots(v) {
  if (form.booking && v.applySeries) {
    const errors = [];
    const slots = form.seriesFuture.map((x) => {
      const k = L.dateKey(new Date(x.start_at));
      return { dateKey: k, start: L.at(k, v.startTime), end: L.at(k, v.endTime), target: x };
    });
    const msg = slots.length ? L.checkSlot(slots[0].start, slots[0].end, RULES) : null;
    if (msg) errors.push(msg);
    return { slots, skipped: 0, errors };
  }
  const res = L.expandRequest({ ...v, endKey: form.booking ? '' : v.endKey }, RULES);
  if (form.booking) res.slots.forEach((s) => { s.target = form.booking; });
  return res;
}

function updateSummary() {
  const out = dlg.querySelector('#bk-summary');
  if (!out) return;
  const v = readForm();
  const { slots, skipped, errors } = computeSlots(v);
  if (errors.length || !slots.length) { out.textContent = ''; return; }
  const len = L.duration(L.minutesOf(v.endTime) - L.minutesOf(v.startTime));
  const r = resById(v.resourceId);
  if (slots.length === 1) {
    out.innerHTML = `<b>${esc(r?.name)}</b> · ${L.fmtDayLong(slots[0].start)} · <span class="mono">${v.startTime}–${v.endTime}</span> (${len})`;
  } else {
    out.innerHTML = `<b>${esc(r?.name)}</b> · ${slots.length} days, ${L.fmtDay(slots[0].start)} to ${L.fmtDay(slots[slots.length - 1].start)} · <span class="mono">${v.startTime}–${v.endTime}</span> each day${skipped ? ` · weekend skipped` : ''}`;
  }
}

function showFeedback(html) {
  const fb = dlg.querySelector('#bk-feedback');
  fb.innerHTML = html;
  fb.scrollIntoView({ block: 'nearest' });
}
const errorBox = (msgs) => `<div class="alert" role="alert">${msgs.map((m) => `<p class="alert-title">${esc(m)}</p>`).join('')}</div>`;

function setBusy(busy) {
  const btn = dlg.querySelector('#bk-submit');
  if (btn) btn.disabled = busy;
  dlg.querySelectorAll('[data-action="override"],[data-action="book-free"]').forEach((b) => { b.disabled = busy; });
}

async function submitBooking({ override = false, onlyFree = false } = {}) {
  const v = readForm();
  let { slots, errors } = computeSlots(v);
  if (errors.length) return showFeedback(errorBox(errors));
  const r = resById(v.resourceId);
  if (!r) return showFeedback(errorBox(['Choose a resource.']));

  if (!isAdmin()) {
    const target = form.booking;
    const slotChanged = (s) => !s.target || s.target.resource_id !== v.resourceId ||
      +new Date(s.target.start_at) !== +s.start || +new Date(s.target.end_at) !== +s.end;
    if (r.status !== 'available' && slots.some(slotChanged)) {
      return showFeedback(errorBox([`${r.name} is ${STATUS[r.status].label.toLowerCase()} and cannot be booked right now.${r.status_note ? ` (${r.status_note})` : ''}`]));
    }
    const now = new Date();
    const started = slots.filter((s) => s.start < now && !(s.target && +new Date(s.target.start_at) === +s.start));
    if (started.length) {
      return showFeedback(errorBox([started.length === slots.length || target
        ? 'That time has already started. Pick a later time.'
        : `${started.length} of these days are in the past. Move the first day forward.`]));
    }
  }

  setBusy(true);
  try {
    const fresh = await state.be.listBookings(slots[0].start.toISOString(), slots[slots.length - 1].end.toISOString());
    const ignore = new Set(slots.map((s) => s.target?.id).filter((x) => x != null));
    let conflicts = L.findConflicts(slots, fresh, v.resourceId, ignore);
    if (conflicts.length && onlyFree) {
      const taken = new Set(conflicts.map((c) => c.slot.dateKey));
      slots = slots.filter((s) => !taken.has(s.dateKey));
      conflicts = [];
    }
    if (conflicts.length && !override) { showConflicts(conflicts, slots, fresh, r); return; }
    if (conflicts.length && override) await applyOverride(conflicts);

    if (form.booking) {
      for (const s of slots) {
        await state.be.updateBooking(s.target.id, {
          resource_id: v.resourceId, user_id: v.userId, note: v.note,
          start_at: s.start.toISOString(), end_at: s.end.toISOString(),
        });
      }
      toast(slots.length > 1 ? `Updated ${slots.length} bookings.` : 'Booking updated.');
    } else {
      const seriesId = slots.length > 1 ? uuid() : null;
      await state.be.createBookings(slots.map((s) => ({
        resource_id: v.resourceId, user_id: v.userId, note: v.note, series_id: seriesId,
        start_at: s.start.toISOString(), end_at: s.end.toISOString(),
      })));
      toast(slots.length > 1 ? `Booked ${r.name} for ${slots.length} days.` : `Booked ${r.name}.`);
    }
    dlg.close();
    await route(true);
  } catch (e) {
    showFeedback(errorBox([e.code === 'conflict'
      ? 'Someone booked part of this time a moment ago. Press the button again to see who.'
      : errMsg(e)]));
  } finally {
    setBusy(false);
  }
}

function showConflicts(conflicts, slots, fresh, r) {
  const taken = new Set(conflicts.map((c) => c.slot.dateKey));
  const freeDays = slots.filter((s) => !taken.has(s.dateKey)).length;
  const alts = L.freeAlternatives(slots, fresh, state.resources, r).slice(0, 5);
  const items = conflicts.map(({ slot, booking: b }) => {
    const p = person(b.user_id);
    const s = new Date(b.start_at), e = new Date(b.end_at);
    const own = b.user_id === me();
    let effect = '';
    if (isAdmin() && !own) {
      const pieces = L.carve(b, slot);
      effect = pieces.length
        ? `If you override: their booking becomes ${pieces.map(([a, z]) => `${L.timeOf(a)}–${L.timeOf(z)}`).join(' and ')}.`
        : 'If you override: their booking is removed.';
    }
    return `<li>
      <span class="c-when">${L.fmtDay(s)} · ${L.timeOf(s)}–${L.timeOf(e)}</span>
      <span>Booked by <b>${own ? 'you' : esc(p.display_name)}</b>${!own && p.email ? ` <span class="muted">(${esc(p.email)})</span>` : ''}</span>
      ${b.note ? `<span class="c-note">${esc(b.note)}</span>` : ''}
      ${effect ? `<span class="c-override">${esc(effect)}</span>` : ''}
    </li>`;
  }).join('');
  const what = slots.length > 1 ? `on ${taken.size} of the ${slots.length} days` : 'at that time';
  showFeedback(`
  <div class="alert" role="alert">
    <p class="alert-title">${esc(r.name)} is not available ${what}.</p>
    <ul>${items}</ul>
    ${alts.length ? `<p class="alert-sub">Free for the same ${slots.length > 1 ? 'days and times' : 'time'}:</p>
      <div class="alert-actions">${alts.map((a) => `<button type="button" class="chip-btn" data-action="switch-res" data-res="${a.id}">${esc(a.name)}</button>`).join('')}</div>` : ''}
    ${(!form.booking && freeDays > 0) || isAdmin() ? `<div class="alert-actions">
      ${!form.booking && freeDays > 0 ? `<button type="button" class="btn sm" data-action="book-free">Book only the ${freeDays} free day${freeDays > 1 ? 's' : ''}</button>` : ''}
      ${isAdmin() ? '<button type="button" class="btn sm warn" data-action="override">Override as admin</button>' : ''}
    </div>` : ''}
  </div>`);
}

async function applyOverride(conflicts) {
  for (const { slot, booking: b } of conflicts) {
    const pieces = L.carve(b, slot);
    if (!pieces.length) {
      await state.be.deleteBookings([b.id]);
      continue;
    }
    await state.be.updateBooking(b.id, { start_at: pieces[0][0].toISOString(), end_at: pieces[0][1].toISOString() });
    if (pieces[1]) {
      await state.be.createBookings([{
        resource_id: b.resource_id, user_id: b.user_id, note: b.note, series_id: b.series_id,
        start_at: pieces[1][0].toISOString(), end_at: pieces[1][1].toISOString(),
      }]);
    }
  }
}

function openBookingInfo(b) {
  const p = person(b.user_id);
  const r = resById(b.resource_id);
  const s = new Date(b.start_at), e = new Date(b.end_at);
  dlg.innerHTML = `
  <div class="sheet">
    <header><h2>${esc(r?.name || 'Booking')}</h2><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="sheet-body">
      <dl class="info">
        <dt>Booked by</dt><dd>${esc(p.display_name)}${p.email ? `<br><span class="muted">${esc(p.email)}</span>` : ''}</dd>
        <dt>When</dt><dd>${L.fmtDayLong(s)}<br><span class="mono">${L.timeOf(s)}–${L.timeOf(e)}</span> (${L.duration((e - s) / 60000)})</dd>
        ${b.note ? `<dt>Purpose</dt><dd>${esc(b.note)}</dd>` : ''}
      </dl>
      <p class="muted small">Only ${esc(firstName(p.display_name))} or a lab admin can change this booking. Contact them if you need this slot.</p>
    </div>
    <footer><span class="spacer"></span><button type="button" class="btn" data-close>Close</button></footer>
  </div>`;
  dlg.showModal();
}

// ---------- Confirmation dialog (window.confirm is not used) ----------
function ask({ title, body, actions }) {
  return new Promise((resolve) => {
    askDlg.innerHTML = `
    <div class="sheet">
      <header><h2>${esc(title)}</h2></header>
      <div class="sheet-body"><p>${esc(body)}</p></div>
      <footer><span class="spacer"></span>${actions.map((a, i) => `<button type="button" class="btn ${a.kind || ''}" data-ask="${i}">${esc(a.label)}</button>`).join('')}</footer>
    </div>`;
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      askDlg.removeEventListener('click', onClick);
      askDlg.removeEventListener('close', onClose);
      if (askDlg.open) askDlg.close();
      resolve(val);
    };
    const onClick = (ev) => {
      const btn = ev.target.closest('[data-ask]');
      if (btn) finish(actions[Number(btn.dataset.ask)].value);
      else if (ev.target === askDlg) finish(null);
    };
    const onClose = () => finish(null);
    askDlg.addEventListener('click', onClick);
    askDlg.addEventListener('close', onClose);
    askDlg.showModal();
  });
}

async function deleteFlow(b) {
  let series = [];
  if (b.series_id) {
    try { series = (await state.be.listSeries(b.series_id)).filter((x) => new Date(x.end_at) > new Date() || x.id === b.id); } catch { series = []; }
  }
  const r = resById(b.resource_id);
  const s = new Date(b.start_at), e = new Date(b.end_at);
  const who = b.user_id === me() ? '' : ` Booked by ${person(b.user_id).display_name}.`;
  const actions = [{ label: 'Keep it', value: null, kind: 'ghost' }];
  if (series.length > 1) actions.push({ label: `Delete all ${series.length} days`, value: 'series', kind: 'danger-ghost' });
  actions.push({ label: series.length > 1 ? 'Delete this day' : 'Delete booking', value: 'one', kind: 'danger' });
  const choice = await ask({
    title: 'Delete this booking?',
    body: `${r?.name || 'Resource'}, ${L.fmtDayLong(s)}, ${L.timeOf(s)}–${L.timeOf(e)}.${who}${series.length > 1 ? ` It is part of a ${series.length}-day booking.` : ''}`,
    actions,
  });
  if (!choice) return false;
  const ids = choice === 'series' ? series.map((x) => x.id) : [b.id];
  try {
    await state.be.deleteBookings(ids);
    toast(ids.length > 1 ? `Deleted ${ids.length} bookings.` : 'Booking deleted.');
    return true;
  } catch (e) {
    toast(errMsg(e), 'err');
    return false;
  }
}

// ---------- My bookings ----------
async function renderMine(view) {
  const now = new Date();
  const upcoming = state.mineTab === 'upcoming';
  const from = upcoming ? L.startOfDay(now) : L.addDays(now, -365);
  const to = upcoming ? L.addDays(now, 730) : now;
  let list = await state.be.listBookings(from.toISOString(), to.toISOString(), { userId: me() });
  list = upcoming ? list.filter((b) => new Date(b.end_at) > now) : list.filter((b) => new Date(b.end_at) <= now).reverse();
  state.mine = list;

  const seriesIndex = new Map();
  for (const b of list) if (b.series_id) seriesIndex.set(b.series_id, [...(seriesIndex.get(b.series_id) || []), b]);
  const groups = new Map();
  for (const b of list) {
    const k = L.dateKey(new Date(b.start_at));
    groups.set(k, [...(groups.get(k) || []), b]);
  }
  const resCount = new Set(list.map((b) => b.resource_id)).size;
  const todayKey = L.dateKey(now);

  const row = (b) => {
    const r = resById(b.resource_id);
    const s = new Date(b.start_at), e = new Date(b.end_at);
    const live = s <= now && e > now;
    const sib = b.series_id ? [...(seriesIndex.get(b.series_id) || [])].sort((a, z) => new Date(a.start_at) - new Date(z.start_at)) : [];
    const seriesNote = sib.length > 1 ? `<p class="mb-series">Day ${sib.findIndex((x) => x.id === b.id) + 1} of ${sib.length} in a multi-day booking</p>` : '';
    return `<article class="mb-row">
      <div class="mb-time">${L.timeOf(s)}–${L.timeOf(e)}<small>${L.duration((e - s) / 60000)}</small></div>
      <div class="mb-main">
        <div class="mb-title">${r ? `<span class="kind-tag">${esc(r.kind)}</span>` : ''}<b>${esc(r?.name || 'Deleted resource')}</b>${live ? '<span class="pill accent">In progress</span>' : ''}</div>
        ${b.note ? `<p class="mb-note">${esc(b.note)}</p>` : ''}
        ${seriesNote}
        ${upcoming && r && r.status !== 'available' ? `<p class="mb-warn">${esc(r.name)} is currently marked as ${esc(STATUS[r.status].label.toLowerCase())}${r.status_note ? `: ${esc(r.status_note)}` : ''}.</p>` : ''}
      </div>
      <div class="mb-actions">
        ${upcoming ? `<button type="button" class="btn ghost sm" data-action="edit-booking" data-id="${esc(b.id)}">Edit</button>` : ''}
        <button type="button" class="btn ghost sm danger-text" data-action="delete-booking" data-id="${esc(b.id)}">Delete</button>
      </div>
    </article>`;
  };

  const sub = list.length
    ? `${list.length} ${upcoming ? 'upcoming' : 'past'} booking${list.length > 1 ? 's' : ''} on ${resCount} resource${resCount > 1 ? 's' : ''}${upcoming ? '' : ' in the last 12 months'}.`
    : '';

  view.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">My bookings</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div>
    <div class="page-tools">
      <div class="seg" role="group" aria-label="Which bookings">
        <button type="button" data-action="mine-tab" data-tab="upcoming" aria-pressed="${upcoming}">Upcoming</button>
        <button type="button" data-action="mine-tab" data-tab="past" aria-pressed="${!upcoming}">Past</button>
      </div>
      <button type="button" class="btn primary" data-action="new-booking">${ICON.plus}New booking</button>
    </div>
  </div>
  ${list.length ? [...groups].map(([k, items]) => `
    <section class="day-group">
      <h2 class="day-label">${L.fmtDayLong(L.parseKey(k))}${k === todayKey ? ' <span class="pill accent">Today</span>' : ''}</h2>
      <div class="rows">${items.map(row).join('')}</div>
    </section>`).join('') : `
    <div class="empty">
      <h2>${upcoming ? 'No upcoming bookings' : 'No past bookings'}</h2>
      <p>${upcoming ? 'Book a PC or robot from the calendar, or start a new booking here.' : 'Bookings you have finished in the last 12 months appear here.'}</p>
      ${upcoming ? `<button type="button" class="btn primary" data-action="new-booking">${ICON.plus}New booking</button>` : ''}
    </div>`}`;
}

// ---------- Manage (admins) ----------
async function renderManage(view) {
  const pending = [...state.profiles.values()].filter((p) => p.role === 'pending').length;
  const tab = state.manageTab;
  let body = '';
  if (tab === 'resources') {
    body = state.resources.length ? `
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Resource</th><th>Type</th><th>Status</th><th class="actions"><span hidden>Actions</span></th></tr></thead>
      <tbody>${state.resources.map((r) => `<tr>
        <td><b>${esc(r.name)}</b>${r.location ? ` <span class="muted">· ${esc(r.location)}</span>` : ''}${r.description ? `<span class="cell-sub">${esc(r.description)}</span>` : ''}</td>
        <td><span class="kind-tag">${esc(r.kind)}</span></td>
        <td>
          <select class="status-select st-${esc(r.status)}" data-change="set-status" data-id="${r.id}" aria-label="Status of ${esc(r.name)}">
            ${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${s.label}</option>`).join('')}
          </select>
          ${r.status_note ? `<span class="cell-sub">${esc(r.status_note)}</span>` : ''}
        </td>
        <td class="actions">
          <button type="button" class="btn ghost sm" data-action="edit-resource" data-id="${r.id}">Edit</button>
          <button type="button" class="btn ghost sm danger-text" data-action="delete-resource" data-id="${r.id}">Delete</button>
        </td>
      </tr>`).join('')}</tbody>
    </table></div>`
      : `<div class="empty"><h2>No resources yet</h2><p>Add each PC and robot your group books. Give them names people recognise, such as the label on the machine.</p><button type="button" class="btn primary" data-action="new-resource">${ICON.plus}Add resource</button></div>`;
  } else {
    const people = [...state.profiles.values()].sort((a, z) => (a.role === 'pending' ? -1 : 0) - (z.role === 'pending' ? -1 : 0) || a.display_name.localeCompare(z.display_name));
    body = `
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Person</th><th>Email</th><th>Access</th><th>Joined</th></tr></thead>
      <tbody>${people.map((p) => `<tr>
        <td><div style="display:flex;gap:10px;align-items:center">${avatar(p)}<b>${esc(p.display_name)}</b>${p.id === me() ? ' <span class="muted">(you)</span>' : ''}</div></td>
        <td class="mono small">${esc(p.email || '')}</td>
        <td><select data-change="set-role" data-id="${esc(p.id)}" aria-label="Access level for ${esc(p.display_name)}">
          <option value="pending" ${p.role === 'pending' ? 'selected' : ''}>Waiting for approval</option>
          <option value="member" ${p.role === 'member' ? 'selected' : ''}>Member: books for themselves</option>
          <option value="admin" ${p.role === 'admin' ? 'selected' : ''}>Admin: manages everything</option>
        </select></td>
        <td class="muted small">${p.created_at ? L.fmtDay(new Date(p.created_at)) + ' ' + new Date(p.created_at).getFullYear() : ''}</td>
      </tr>`).join('')}</tbody>
    </table></div>
    <p class="cal-hint">Members can book when a resource is free and manage their own bookings. Admins can also add resources, change their status, edit anyone's booking and override conflicts. New accounts wait for approval.</p>`;
  }

  view.innerHTML = `
  <div class="page-head">
    <div><h1 class="page-title">Manage</h1><p class="page-sub">${tab === 'resources' ? 'PCs, robots and their status.' : 'Who can sign in and what they can do.'}</p></div>
    <div class="page-tools">
      <div class="seg" role="group" aria-label="Manage section">
        <button type="button" data-action="manage-tab" data-tab="resources" aria-pressed="${tab === 'resources'}">Resources</button>
        <button type="button" data-action="manage-tab" data-tab="people" aria-pressed="${tab === 'people'}">People${pending ? `<span class="count">${pending}</span>` : ''}</button>
      </div>
      ${tab === 'resources' ? `<button type="button" class="btn primary" data-action="new-resource">${ICON.plus}Add resource</button>` : ''}
    </div>
  </div>
  ${body}`;
}

function openResourceForm(r = null) {
  const kindList = [...new Set(['PC', 'Robot', ...kinds()])];
  dlg.innerHTML = `
  <form class="sheet" id="res-form" novalidate>
    <header><h2>${r ? 'Edit resource' : 'Add resource'}</h2><button type="button" class="x" data-close aria-label="Close">×</button></header>
    <div class="sheet-body">
      <div class="field"><label for="rs-name">Name</label><input id="rs-name" required maxlength="80" value="${esc(r?.name || '')}" placeholder="e.g. PC-04 GPU workstation"></div>
      <div class="row2">
        <div class="field"><label for="rs-kind">Type</label><input id="rs-kind" list="rs-kinds" maxlength="30" value="${esc(r?.kind || 'PC')}"><datalist id="rs-kinds">${kindList.map((k) => `<option value="${esc(k)}">`).join('')}</datalist></div>
        <div class="field"><label for="rs-loc">Location <em>(optional)</em></label><input id="rs-loc" maxlength="60" value="${esc(r?.location || '')}" placeholder="e.g. Bay A"></div>
      </div>
      <div class="field"><label for="rs-desc">Description <em>(optional)</em></label><input id="rs-desc" maxlength="200" value="${esc(r?.description || '')}" placeholder="Specs, attachments, anything people should know"></div>
      <div class="row2">
        <div class="field"><label for="rs-status">Status</label><select id="rs-status">${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${k === (r?.status || 'available') ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>
        <div class="field"><label for="rs-note">Status note <em>(optional)</em></label><input id="rs-note" maxlength="120" value="${esc(r?.status_note || '')}" placeholder="e.g. Waiting for replacement part"></div>
      </div>
      <p class="muted small">Members cannot make new bookings on a resource unless its status is Available. Existing bookings stay, and their owners see a warning.</p>
      <div id="rs-error" class="form-error" role="alert"></div>
    </div>
    <footer><span class="spacer"></span><button type="button" class="btn ghost" data-close>Cancel</button><button type="submit" class="btn primary">${r ? 'Save changes' : 'Add resource'}</button></footer>
  </form>`;
  dlg.showModal();
  dlg.querySelector('#res-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const q = (id) => dlg.querySelector('#' + id).value.trim();
    const err = dlg.querySelector('#rs-error');
    if (!q('rs-name')) { err.textContent = 'Give the resource a name.'; return; }
    const data = { name: q('rs-name'), kind: q('rs-kind') || 'Other', location: q('rs-loc'), description: q('rs-desc'), status: q('rs-status'), status_note: q('rs-note') };
    try {
      await state.be.saveResource(r ? { id: r.id, ...data } : data);
      dlg.close();
      toast(r ? `Saved ${data.name}.` : `Added ${data.name}.`);
      route(true);
    } catch (e) { err.textContent = errMsg(e); }
  });
}

async function upcomingCount(resId) {
  const now = new Date();
  const list = await state.be.listBookings(now.toISOString(), L.addDays(now, 730).toISOString(), { resourceId: resId });
  return list.length;
}

// ---------- Events ----------
document.addEventListener('click', async (ev) => {
  // Time pickers: open, choose, or close when clicking anywhere else.
  const tpBtn = ev.target.closest('.tp-btn');
  const tpOpt = ev.target.closest('.tp-opt');
  if (tpOpt) { if (!tpOpt.disabled) choosePickerOption(tpOpt); return; }
  if (tpBtn) {
    const list = tpBtn.parentElement.querySelector('.tp-list');
    if (list.hidden) openPicker(tpBtn); else closePickers();
    return;
  }
  if (!ev.target.closest('.tp-list')) closePickers();

  // Close dialogs from × / Cancel buttons and by clicking the backdrop.
  if (ev.target === dlg) { dlg.close(); return; }
  if (ev.target.closest('[data-close]')) { ev.target.closest('dialog')?.close(); return; }

  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const view = document.getElementById('view');

  switch (a) {
    case 'auth-mode': renderLogin(el.dataset.mode); break;
    case 'demo-login':
      try { await state.be.signIn(el.dataset.email, 'demo'); await refreshAuth(); } catch (e) { toast(errMsg(e), 'err'); }
      break;
    case 'sign-out':
      await state.be.signOut();
      state.user = null;
      renderLogin();
      break;
    case 'recheck': state.user = null; refreshAuth(); break;
    case 'reset-demo': {
      const ok = await ask({ title: 'Reset demo data?', body: 'This restores the example people, resources and bookings and signs you out.', actions: [{ label: 'Cancel', value: false, kind: 'ghost' }, { label: 'Reset', value: true, kind: 'danger' }] });
      if (ok) { state.be.reset(); state.user = null; renderLogin(); }
      break;
    }
    case 'retry': route(); break;

    // calendar
    case 'cal-prev':
    case 'cal-next': {
      const dir = a === 'cal-next' ? 1 : -1;
      state.anchor = state.mode === 'week' ? L.addDays(L.startOfWeek(state.anchor), 7 * dir) : L.shiftWeekday(state.anchor, dir);
      renderCalendar(view).catch((e) => toast(errMsg(e), 'err'));
      break;
    }
    case 'cal-today': state.anchor = L.nextWeekday(new Date()); renderCalendar(view).catch((e) => toast(errMsg(e), 'err')); break;
    case 'cal-mode': {
      const mode = el.dataset.mode;
      if (mode === state.mode) break;
      if (mode === 'day') {
        const monday = L.startOfWeek(state.anchor);
        const today = new Date();
        state.anchor = L.startOfWeek(today).getTime() === monday.getTime() ? L.nextWeekday(today) : monday;
      }
      state.mode = mode; pref.set('mode', mode);
      renderCalendar(view).catch((e) => toast(errMsg(e), 'err'));
      break;
    }
    case 'cal-kind': state.kind = el.dataset.kind; pref.set('kind', state.kind); renderCalendar(view).catch((e) => toast(errMsg(e), 'err')); break;
    case 'goto-day': state.mode = 'day'; pref.set('mode', 'day'); state.anchor = L.parseKey(el.dataset.date); renderCalendar(view).catch((e) => toast(errMsg(e), 'err')); break;
    case 'slot': {
      const r = resById(el.dataset.res);
      if (!r) break;
      if (r.status !== 'available' && !isAdmin()) {
        toast(`${r.name} is ${STATUS[r.status].label.toLowerCase()}${r.status_note ? `: ${r.status_note}` : ''}.`, 'err');
        break;
      }
      const rect = el.getBoundingClientRect();
      const frac = el.dataset.axis === 'v' ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      let start = RULES.dayStart * 60 + Math.floor(Math.max(0, Math.min(0.999, frac)) * DAY_MIN / RULES.step) * RULES.step;
      start = Math.min(start, RULES.dayEnd * 60 - RULES.step);
      const end = Math.min(start + 60, RULES.dayEnd * 60);
      openBookingForm({ resourceId: r.id, dateKey: el.dataset.date, startTime: L.hm(start), endTime: L.hm(end) });
      break;
    }
    case 'open-booking': {
      const b = findBooking(el.dataset.id);
      if (!b) break;
      if (b.user_id === me() || isAdmin()) openBookingForm({ booking: b });
      else openBookingInfo(b);
      break;
    }
    case 'new-booking': openBookingForm(); break;

    // booking form
    case 'switch-res': {
      dlg.querySelector('#bk-res').value = el.dataset.res;
      dlg.querySelector('#bk-feedback').innerHTML = '';
      updateSummary();
      dlg.querySelector('#bk-submit').focus();
      break;
    }
    case 'book-free': submitBooking({ onlyFree: true }); break;
    case 'override': submitBooking({ override: true }); break;
    case 'bk-delete': {
      const b = form?.booking;
      if (b && await deleteFlow(b)) { dlg.close(); route(true); }
      break;
    }

    // my bookings
    case 'mine-tab': state.mineTab = el.dataset.tab; renderMine(view).catch((e) => toast(errMsg(e), 'err')); break;
    case 'edit-booking': { const b = findBooking(el.dataset.id); if (b) openBookingForm({ booking: b }); break; }
    case 'delete-booking': { const b = findBooking(el.dataset.id); if (b && await deleteFlow(b)) route(true); break; }

    // manage
    case 'manage-tab': state.manageTab = el.dataset.tab; renderManage(view); break;
    case 'new-resource': openResourceForm(); break;
    case 'edit-resource': openResourceForm(resById(el.dataset.id)); break;
    case 'delete-resource': {
      const r = resById(el.dataset.id);
      if (!r) break;
      let n = 0;
      try { n = await upcomingCount(r.id); } catch { /* ignore */ }
      const ok = await ask({
        title: `Delete ${r.name}?`,
        body: `This removes the resource and all of its bookings${n ? `, including ${n} upcoming` : ''}. This cannot be undone. To take it out of use temporarily, set its status to Unavailable instead.`,
        actions: [{ label: 'Cancel', value: false, kind: 'ghost' }, { label: 'Delete resource', value: true, kind: 'danger' }],
      });
      if (!ok) break;
      try { await state.be.deleteResource(r.id); toast(`Deleted ${r.name}.`); route(true); } catch (e) { toast(errMsg(e), 'err'); }
      break;
    }
    default: break;
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target.closest('[data-change]');
  if (!el) return;
  if (el.dataset.change === 'set-status') {
    const r = resById(el.dataset.id);
    if (!r) return;
    try {
      await state.be.saveResource({ id: r.id, status: el.value });
      let n = 0;
      if (el.value !== 'available') { try { n = await upcomingCount(r.id); } catch { /* ignore */ } }
      toast(`${r.name} is now ${STATUS[el.value].label.toLowerCase()}.${n ? ` ${n} upcoming booking${n > 1 ? 's are' : ' is'} affected; their owners see a warning.` : ''}`);
      route(true);
    } catch (e) { toast(errMsg(e), 'err'); el.value = r.status; }
  }
  if (el.dataset.change === 'set-role') {
    const p = state.profiles.get(el.dataset.id);
    if (!p) return;
    if (p.id === me() && el.value !== 'admin') {
      const ok = await ask({ title: 'Remove your own admin access?', body: 'You will no longer be able to manage resources or other people\'s bookings.', actions: [{ label: 'Cancel', value: false, kind: 'ghost' }, { label: 'Change my access', value: true, kind: 'danger' }] });
      if (!ok) { el.value = p.role; return; }
    }
    try {
      await state.be.updateProfile(p.id, { role: el.value });
      toast(`${p.display_name} is now ${ROLE[el.value].toLowerCase()}.`);
      if (p.id === me()) refreshAuth(true); else route(true);
    } catch (e) { toast(errMsg(e), 'err'); el.value = p.role; }
  }
});

boot();
