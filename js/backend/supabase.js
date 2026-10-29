// Shared backend: Supabase (Postgres + Auth). Rules are enforced in the
// database (supabase/schema.sql), so the browser cannot bypass them.

const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm';

function mapError(error) {
  const e = new Error(error?.message || 'Something went wrong. Please try again.');
  e.code = error?.code;
  if (error?.code === '23P01') {
    e.code = 'conflict';
    e.message = 'That time overlaps an existing booking.';
  } else if (error?.code === 'PGRST116' || /row-level security/i.test(error?.message || '')) {
    e.code = 'permission';
    e.message = "You don't have permission to do that.";
  } else if (error?.code === '42501') {
    e.code = 'permission';
  }
  return e;
}

const here = () => location.origin + location.pathname;

export async function createBackend(cfg) {
  const { createClient } = await import(SUPABASE_ESM);
  const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const check = ({ data, error }) => {
    if (error) throw mapError(error);
    return data;
  };

  return {
    name: 'supabase',

    onAuthChange(cb) {
      sb.auth.onAuthStateChange((event) => cb(event));
    },

    async getCurrentUser() {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return null;
      const profile = check(await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
      return profile || { id: session.user.id, email: session.user.email, display_name: session.user.email, role: 'pending' };
    },
    async signIn(email, password) {
      check(await sb.auth.signInWithPassword({ email, password }));
    },
    async signUp(email, password, displayName) {
      const data = check(await sb.auth.signUp({
        email, password,
        options: { data: { display_name: displayName }, emailRedirectTo: here() },
      }));
      return { needsConfirmation: !data.session };
    },
    async resetPassword(email) {
      check(await sb.auth.resetPasswordForEmail(email, { redirectTo: here() }));
    },
    async updatePassword(password) {
      check(await sb.auth.updateUser({ password }));
    },
    async signOut() {
      await sb.auth.signOut();
    },

    async listProfiles() {
      return check(await sb.from('profiles').select('*').order('display_name'));
    },
    async updateProfile(id, patch) {
      return check(await sb.from('profiles').update(patch).eq('id', id).select().single());
    },

    async listResources() {
      return check(await sb.from('resources').select('*').order('kind').order('name'));
    },
    async saveResource(resource) {
      const { id, created_at, ...rest } = resource;
      const q = id ? sb.from('resources').update(rest).eq('id', id) : sb.from('resources').insert(rest);
      return check(await q.select().single());
    },
    async deleteResource(id) {
      check(await sb.from('resources').delete().eq('id', id));
    },

    /** Bookings that overlap [fromIso, toIso). */
    async listBookings(fromIso, toIso, opts = {}) {
      let q = sb.from('bookings').select('*').lt('start_at', toIso).gt('end_at', fromIso).order('start_at');
      if (opts.userId) q = q.eq('user_id', opts.userId);
      if (opts.resourceId) q = q.eq('resource_id', opts.resourceId);
      return check(await q);
    },
    async listSeries(seriesId) {
      return check(await sb.from('bookings').select('*').eq('series_id', seriesId).order('start_at'));
    },
    /** Inserts all rows in one statement: either every booking is created or none is. */
    async createBookings(rows) {
      return check(await sb.from('bookings').insert(rows).select());
    },
    async updateBooking(id, patch) {
      return check(await sb.from('bookings').update(patch).eq('id', id).select().single());
    },
    async deleteBookings(ids) {
      check(await sb.from('bookings').delete().in('id', ids));
    },
  };
}
