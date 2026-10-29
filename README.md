# BenchBook

Open-source resource booking for research labs. Book shared PCs, robots and other equipment from the browser, see who has what, and keep bookings to lab hours.

BenchBook is a static web app (plain HTML, CSS and JavaScript, no build step), so it can be hosted for free on **GitHub Pages**. Shared data, logins and permissions are handled by a free **Supabase** project (Postgres database + authentication).

## Features

- **Calendar of every resource.** Week view (resources down the side, Monday to Friday across) and day view (one column per resource). Each booking shows who made it; hover or click for times, purpose and contact email. Filter by type (PC, Robot, …).
- **Book a resource for a time period.** Click an empty slot or use *New booking*. Pick a resource, date, start and end time.
- **Book several days in one go.** Set a *Last day* and BenchBook books the same time on every weekday in the range, skipping weekends. The whole run is created together or not at all.
- **Clear conflict messages.** If any part of the request is taken, you see which days and times, **who** booked them (name and email) and their stated purpose. BenchBook also suggests other free resources of the same type and offers to book only the free days.
- **Lab hours only.** Bookings are limited to Monday to Friday, 08:00 to 18:00 (configurable).
- **My bookings.** Your upcoming and past bookings, grouped by day. Change the time, date, resource or purpose, or delete a single day or a whole multi-day booking.
- **Two access levels**, plus approval for new accounts:

| | Member | Admin |
|---|:---:|:---:|
| View the calendar and who booked what | ✓ | ✓ |
| Book a resource when it is free | ✓ | ✓ |
| Change and delete own bookings | ✓ | ✓ |
| Book or edit on behalf of someone else | | ✓ |
| Edit or delete anyone's booking | | ✓ |
| Override a conflict (the other booking is shortened or removed) | | ✓ |
| Add, edit and delete resources | | ✓ |
| Set resource status: Available, Unavailable, Maintenance, Broken | | ✓ |
| Approve new accounts and change access levels | | ✓ |

Resources that are not *Available* show as striped in the calendar and members cannot make new bookings on them. People who already hold a booking on a resource that becomes unavailable see a warning in *My bookings*.

## Try it in 10 seconds (demo mode)

With no Supabase details in `js/config.js`, BenchBook runs in **demo mode**: it loads example people, resources and bookings, and saves everything in your own browser only. Pick a demo account on the sign-in page (Alice is an admin, Ben, Chloe and Dev are members, Erin is waiting for approval; every password is `demo`).

To run it locally, serve the folder with any static web server, for example:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

(Opening `index.html` directly from disk does not work, because browsers block ES modules on `file://` URLs.)

## Deploy for your group

### 1. Put the code on GitHub Pages

1. Create a new repository on GitHub (public, or private on a plan that supports Pages) and upload these files to it, keeping the folder structure. Or fork this repository.
2. In the repository go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, branch **main**, folder **/ (root)**, then **Save**.
3. After a minute the app is live at `https://<your-user-or-org>.github.io/<repository>/`. At this point it is still in demo mode.

### 2. Create the shared database (Supabase, free tier)

1. Sign up at [supabase.com](https://supabase.com) and create a new project. Choose a region near you and save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste the whole of [`supabase/schema.sql`](supabase/schema.sql) and press **Run**. This creates the tables, the booking rules and the access rules.
3. Open **Authentication → URL Configuration**:
   - **Site URL**: your GitHub Pages address, for example `https://my-lab.github.io/benchbook/`
   - **Redirect URLs**: add the same address. These are used by confirmation and password-reset emails.
4. Open **Settings → API Keys** and copy the **Publishable key** (it starts with `sb_publishable_`). The legacy **anon** key works too. The **Project URL** is shown in the project's **Connect** dialog and on the project home page.

### 3. Connect the app to the database

Edit `js/config.js` in your repository:

```js
SUPABASE_URL: 'https://abcdefghijk.supabase.co',
SUPABASE_KEY: 'sb_publishable_...',
LAB_NAME: 'Robotics Lab',
```

Commit the change. GitHub Pages republishes within a minute.

The publishable key is meant to be public. Everything is protected by row-level security in the database, so a person with the key can only do what their account's access level allows.

### 4. First sign-in

1. Open the app and choose **Create an account**. **The first account ever created becomes the admin.** Everyone after that starts as *Waiting for approval*.
2. Confirm your email if Supabase asks you to (this is on by default; you can turn it off under **Authentication → Providers → Email**).
3. Under **Manage → Resources**, add your PCs and robots.
4. Ask your group to create accounts, then approve them under **Manage → People** by setting them to *Member* (or *Admin*).

If you ever lock yourself out, you can promote someone from the Supabase SQL Editor:

```sql
update public.profiles set role = 'admin' where email = 'you@example.ac.uk';
```

## Configuration

`js/config.js`:

| Setting | Default | Meaning |
|---|---|---|
| `LAB_NAME` | `Robotics Lab` | Shown in the header and on the sign-in page |
| `SUPABASE_URL`, `SUPABASE_KEY` | empty | Leave empty for demo mode |
| `DAY_START_HOUR`, `DAY_END_HOUR` | `8`, `18` | Bookable hours, Monday to Friday |
| `SLOT_MINUTES` | `30` | Step for start and end times |
| `MAX_RANGE_DAYS` | `60` | Longest date range bookable in one go |
| `ALLOW_SIGNUP` | `true` | Show *Create an account*. New accounts still need approval |

If you change the opening hours or the lab's time zone, also change them in `public.booking_rules()` at the top of `supabase/schema.sql` and run that function definition again in the SQL Editor. The database enforces its own copy of the rules, so the two must match.

**Time zone.** Times are shown in each person's browser time zone. The database checks opening hours in the lab's time zone (`Europe/London` by default). For a group in one place these are the same.

## How the rules are enforced

All rules are checked twice: in the browser, so people get instant, friendly messages, and in the database, so nobody can get around them by calling the API directly.

- **No double booking**: a Postgres exclusion constraint (`bookings_no_overlap`) makes overlapping bookings on the same resource impossible, even if two people press *Book* at the same moment. Back-to-back bookings (one ends at 10:00, the next starts at 10:00) are allowed.
- **Opening hours, weekdays, same-day bookings**: trigger `validate_booking`.
- **Members** can only book for themselves, only on *Available* resources, and not in the past: trigger `validate_booking` plus row-level security policies.
- **Roles**: only admins can change roles, and the last admin cannot be demoted: trigger `protect_profile`.
- **Waiting accounts** cannot see resources or bookings: row-level security.

## Project structure

```
index.html              App page
css/app.css             Styles (light and dark themes)
js/config.js            Your settings
js/app.js               User interface
js/logic.js             Date, rule and conflict helpers (unit tested)
js/backend/demo.js      Demo backend (browser storage)
js/backend/supabase.js  Shared backend (Supabase)
supabase/schema.sql     Database tables, rules and permissions
tests/logic.test.js     Unit tests: `npm test` (Node 18+)
```

## Ideas for later

- Email or calendar (.ics) notifications when a booking is changed by an admin
- Recurring weekly bookings (for example every Tuesday for a term)
- Per-resource booking limits (maximum hours per week)
- Real-time calendar updates using Supabase Realtime (the calendar currently refreshes every minute and when you return to the tab)

## Licence

MIT. See [LICENSE](LICENSE).
