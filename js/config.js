// BenchBook configuration. Edit this file after you fork the repository.
//
// Leave SUPABASE_URL and SUPABASE_KEY empty to run in DEMO MODE:
// everything works, but data is stored only in your own browser.
// Fill them in (see README.md) to share bookings with your whole group.

export const CONFIG = {
  // Shown in the header and on the sign-in page.
  LAB_NAME: 'Robotics Lab',

  // Supabase project details (Dashboard → Settings → API Keys).
  // Use the publishable key (starts with sb_publishable_) or the legacy anon key.
  // This key is designed to be public: access is protected by the
  // row-level security rules in supabase/schema.sql.
  SUPABASE_URL: '',
  SUPABASE_KEY: '',

  // Bookable hours, Monday to Friday. Keep these in sync with the
  // values at the top of supabase/schema.sql.
  DAY_START_HOUR: 8,
  DAY_END_HOUR: 18,

  // Granularity of start and end times, in minutes.
  SLOT_MINUTES: 30,

  // Longest date range that can be booked in one go (calendar days).
  MAX_RANGE_DAYS: 60,

  // Show "Create an account" on the sign-in page. New accounts wait for
  // an admin to approve them before they can book.
  ALLOW_SIGNUP: true,
};
