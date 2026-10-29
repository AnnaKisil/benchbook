-- BenchBook database schema for Supabase.
-- Run this once in your project's SQL Editor (Dashboard → SQL Editor → New query).
-- It is safe to re-run: it drops and recreates the functions, triggers and policies,
-- but it never drops your tables or data.
--
-- Booking rules (keep in sync with js/config.js):
--   lab time zone ........ Europe/London
--   bookable hours ....... 08:00 – 18:00, Monday to Friday
-- To change them, edit the constants in public.booking_rules() below.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text not null default '',
  role         text not null default 'pending' check (role in ('pending', 'member', 'admin')),
  created_at   timestamptz not null default now()
);

create table if not exists public.resources (
  id          bigint generated always as identity primary key,
  code        text not null default '',
  name        text not null,
  kind        text not null default 'Computer',
  location    text not null default '',
  description text not null default '',
  status      text not null default 'available'
              check (status in ('available', 'unavailable', 'maintenance', 'broken')),
  status_note text not null default '',
  created_at  timestamptz not null default now()
);

-- Upgrades from earlier versions of BenchBook.
alter table public.resources add column if not exists code text not null default '';

create table if not exists public.bookings (
  id          bigint generated always as identity primary key,
  resource_id bigint not null references public.resources (id) on delete cascade,
  user_id     uuid   not null references public.profiles (id) on delete cascade,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  note        text not null default '',
  series_id   uuid,
  created_at  timestamptz not null default now(),
  constraint bookings_end_after_start check (end_at > start_at),
  -- The core rule: one resource can never have two overlapping bookings.
  constraint bookings_no_overlap exclude using gist (
    resource_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  )
);

create index if not exists bookings_start_idx  on public.bookings (start_at);
create index if not exists bookings_user_idx   on public.bookings (user_id);
create index if not exists bookings_series_idx on public.bookings (series_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.booking_rules(out tz text, out day_start time, out day_end time)
language sql immutable as $$
  select 'Europe/London'::text, time '08:00', time '18:00';
$$;

create or replace function public.current_role_name()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() = 'admin', false);
$$;

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(public.current_role_name() in ('member', 'admin'), false);
$$;

-- ---------------------------------------------------------------------------
-- New sign-ups get a profile. The very first account becomes admin;
-- everyone after that starts as 'pending' until an admin approves them.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles) then 'pending' else 'admin' end
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only admins may change roles or emails, and the last admin cannot be demoted.
-- (Changes made from the SQL editor, where auth.uid() is null, are allowed.)
create or replace function public.protect_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (new.role is distinct from old.role or new.email is distinct from old.email) and not public.is_admin() then
    raise exception 'Only admins can change roles.' using errcode = '42501';
  end if;
  if old.role = 'admin' and new.role <> 'admin'
     and (select count(*) from public.profiles where role = 'admin') <= 1 then
    raise exception 'The lab needs at least one admin. Make someone else an admin first.' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists profiles_protect on public.profiles;
create trigger profiles_protect
  before update on public.profiles
  for each row execute function public.protect_profile();

-- ---------------------------------------------------------------------------
-- Booking rules: weekdays only, inside opening hours, same day.
-- Members (not admins) also cannot book for others, book in the past,
-- or book a resource that is not 'available'.
-- ---------------------------------------------------------------------------

create or replace function public.validate_booking()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  r            record;
  local_s      timestamp;
  local_e      timestamp;
  res_status   text;
  res_name     text;
  slot_changed boolean;
begin
  select * into r from public.booking_rules();
  local_s := new.start_at at time zone r.tz;
  local_e := new.end_at   at time zone r.tz;

  if local_s::date <> local_e::date then
    raise exception 'A booking must start and end on the same day.' using errcode = '22023';
  end if;
  if extract(isodow from local_s) > 5 then
    raise exception 'Bookings are only possible Monday to Friday.' using errcode = '22023';
  end if;
  if local_s::time < r.day_start or local_e::time > r.day_end then
    raise exception 'Bookings must be between % and %.', to_char(r.day_start, 'HH24:MI'), to_char(r.day_end, 'HH24:MI')
      using errcode = '22023';
  end if;

  if auth.uid() is not null and not public.is_admin() then
    if new.user_id <> auth.uid() then
      raise exception 'You can only book for yourself.' using errcode = '42501';
    end if;
    slot_changed := tg_op = 'INSERT'
      or new.resource_id <> old.resource_id or new.start_at <> old.start_at or new.end_at <> old.end_at;
    if slot_changed then
      select status, name into res_status, res_name from public.resources where id = new.resource_id;
      if res_status <> 'available' then
        raise exception '% is % and cannot be booked right now.', res_name, res_status using errcode = '42501';
      end if;
    end if;
  end if;

  -- Nobody, admins included, can create a booking or move its start into the past.
  -- (Changes made from the SQL editor, where auth.uid() is null, are allowed.)
  if auth.uid() is not null
     and (tg_op = 'INSERT' or new.start_at <> old.start_at)
     and new.start_at < now() - interval '1 minute' then
    raise exception 'Bookings cannot start in the past.' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists bookings_validate on public.bookings;
create trigger bookings_validate
  before insert or update on public.bookings
  for each row execute function public.validate_booking();

-- ---------------------------------------------------------------------------
-- Table access for signed-in users (row-level security below narrows it down).
-- Signed-out visitors get nothing.
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles, public.resources, public.bookings to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public.profiles, public.resources, public.bookings from anon;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles  enable row level security;
alter table public.resources enable row level security;
alter table public.bookings  enable row level security;

drop policy if exists "profiles: read own or as member" on public.profiles;
create policy "profiles: read own or as member" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_member());

drop policy if exists "profiles: update own or as admin" on public.profiles;
create policy "profiles: update own or as admin" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists "resources: members read" on public.resources;
create policy "resources: members read" on public.resources
  for select to authenticated using (public.is_member());

drop policy if exists "resources: admins write" on public.resources;
create policy "resources: admins write" on public.resources
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "bookings: members read" on public.bookings;
create policy "bookings: members read" on public.bookings
  for select to authenticated using (public.is_member());

drop policy if exists "bookings: book for self, admins for anyone" on public.bookings;
create policy "bookings: book for self, admins for anyone" on public.bookings
  for insert to authenticated
  with check (public.is_admin() or (public.is_member() and user_id = auth.uid()));

drop policy if exists "bookings: edit own, admins edit any" on public.bookings;
create policy "bookings: edit own, admins edit any" on public.bookings
  for update to authenticated
  using (public.is_admin() or (public.is_member() and user_id = auth.uid()))
  with check (public.is_admin() or (public.is_member() and user_id = auth.uid()));

drop policy if exists "bookings: delete own, admins delete any" on public.bookings;
create policy "bookings: delete own, admins delete any" on public.bookings
  for delete to authenticated
  using (public.is_admin() or (public.is_member() and user_id = auth.uid()));

-- ---------------------------------------------------------------------------
-- To load the lab's robots and computers, run supabase/resources.sql next.
-- ---------------------------------------------------------------------------
