# Healthcare Appointment & Follow-up Manager

A clinic appointment platform with separate patient, doctor, and admin portals. Patients book slots and describe symptoms up front; an LLM turns that into a pre-visit summary with an urgency level for the doctor. After the visit, the doctor's notes and prescription get turned into a patient-friendly summary, medication reminders get scheduled, and both sides are kept in sync over email and Google Calendar.

Built on Cloudflare Workers: a [Hono](https://hono.dev) API and a React (Vite) frontend deployed as a single Worker, backed by D1 (Cloudflare's SQLite).

## Stack

- **API:** Hono, running on Cloudflare Workers
- **Frontend:** React + React Router, built with Vite (`@cloudflare/vite-plugin` bundles both into one deployable Worker)
- **Database:** Cloudflare D1 (SQLite), schema managed with Drizzle ORM
- **Auth:** JWT (via `hono/jwt`) + PBKDF2 password hashing (Web Crypto — no bcrypt dependency, since native bindings don't run on Workers)
- **LLM:** provider-swappable (Anthropic or OpenAI), called directly over `fetch` — no SDK
- **Email:** SendGrid HTTP API, called over `fetch`
- **Calendar:** Google Calendar API v3 + OAuth 2.0, called over `fetch`
- **Background jobs:** Cloudflare Cron Triggers (every 15 minutes)
- **Tests:** Vitest + `@cloudflare/vitest-pool-workers` (runs against real Workers runtime + D1, not mocks)

Everything above talks to Cloudflare's APIs directly with `fetch`, so the dependency list stays small on purpose.

## Project layout

```
src/server/         Hono API (Worker)
  db/schema.ts       Drizzle schema — see "Database schema" below
  lib/                slots.ts (availability + hold logic), llm.ts, email.ts,
                       calendar.ts, scheduler.ts (cron job), password.ts
  routes/             auth.ts, patient.ts, doctor.ts, admin.ts, calendar.ts
  middleware/auth.ts  JWT auth + role guard
  index.ts            Worker entry (fetch + scheduled handlers)
src/client/          React frontend (patient/doctor/admin dashboards)
migrations/          Drizzle-generated D1 migrations
scripts/seed-admin.mjs  Bootstraps the first admin account
test/                Vitest suite (unit + integration, against real D1)
docs/SYSTEM_DESIGN.md  Design write-up (double-booking, leave conflicts, etc.)
```

## Local setup

Requires Node 20+ and a Cloudflare account (free tier is enough).

```bash
npm install

# Local secrets — wrangler reads .dev.vars, not .env
cp .env.example .dev.vars
# fill in JWT_SECRET at minimum (any random string). LLM/email/calendar
# keys can stay blank — those integrations degrade gracefully without them.

# Create the D1 database and wire its ID into wrangler.jsonc (one-time)
npx wrangler d1 create healthcare-appointment-manager-db
# copy the printed database_id into wrangler.jsonc -> d1_databases[0].database_id

# Apply the schema to your local D1
npm run db:migrate:local

# Bootstrap the first admin account (public registration only creates patients)
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme123 ADMIN_NAME=Admin npm run db:seed-admin:local

npm run dev
# App + API at http://localhost:5173
```

Log in as the seeded admin to create doctor profiles (specialisation, working hours, slot duration). Patients self-register from `/register`.

### Tests

```bash
npm test
```

Runs against a real (isolated, in-memory) D1 instance via `@cloudflare/vitest-pool-workers` — no mocking of the database or HTTP layer. Covers password hashing, slot generation, auth, the double-booking race, and the full hold → confirm → visit → leave-conflict flow.

### Deploying

```bash
npx wrangler d1 create healthcare-appointment-manager-db   # if not already done
npm run db:migrate:remote

# Secrets are set per-environment, not committed:
npx wrangler secret put JWT_SECRET
npx wrangler secret put SENDGRID_API_KEY        # optional
npx wrangler secret put ANTHROPIC_API_KEY       # optional
npx wrangler secret put GOOGLE_CLIENT_ID        # optional
npx wrangler secret put GOOGLE_CLIENT_SECRET    # optional

ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run db:seed-admin:remote

npm run deploy
```

`wrangler deploy` prints the `*.workers.dev` URL. Cron Triggers (for reminders/retries) are enabled automatically on deploy per `wrangler.jsonc`.

## .env.example

See [`.env.example`](.env.example) — copy it to `.dev.vars` for local dev. Every third-party integration (LLM, email, calendar) is optional: leaving its keys blank doesn't break the app, it just runs with that feature disabled (see "LLM/email/calendar failure handling" in `docs/SYSTEM_DESIGN.md`).

## Google Calendar setup

Calendar sync is optional and off by default. To enable it:

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API**.
2. Configure an OAuth consent screen (External is fine for testing; add your test Google account as a test user).
3. Create an **OAuth 2.0 Client ID** (type: Web application). Add an authorized redirect URI matching `GOOGLE_REDIRECT_URI` — for local dev that's `http://localhost:5173/api/calendar/oauth/callback`.
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `.dev.vars` (or as Worker secrets in production).
5. From a logged-in patient or doctor session, call `GET /api/calendar/oauth/start` — it returns a Google consent URL to redirect the browser to. On approval, Google redirects to the callback route, which stores the refresh token and starts syncing that user's bookings.

Until this is configured, `GET /api/calendar/status` reports `configured: false` and calendar sync silently no-ops (see `src/server/lib/calendar.ts`).

## LLM prompts

Exactly as specified in the assignment brief, with the pre-visit prompt additionally asking for strict JSON so it can be parsed and stored:

**Pre-visit summary** (`src/server/lib/llm.ts` → `generatePreVisitSummary`):
> Analyse these symptoms and return ONLY a JSON object with keys "urgency" (one of "Low", "Medium", "High"), "chiefComplaint" (short string), and "suggestedQuestions" (an array of exactly three strings, questions the doctor should ask). Do not include any text outside the JSON object.
>
> Symptoms: `<symptoms>`

**Post-visit summary** (`generatePostVisitSummary`):
> Convert these clinical notes into a patient-friendly summary with a medication schedule and follow-up steps. Write in plain, reassuring language a patient with no medical background can follow. Clinical notes: `<notes>`

Both calls go through a provider-agnostic `callLLM()` — set `LLM_PROVIDER` to `anthropic` or `openai`. A missing key, non-2xx response, network error, or unparseable JSON all resolve to `null` rather than throwing; the appointment is still booked/completed with the summary marked unavailable (see `docs/SYSTEM_DESIGN.md`).

## Database schema

Defined in `src/server/db/schema.ts` (Drizzle, SQLite dialect). Summary:

| Table | Purpose |
|---|---|
| `users` | All accounts (patient/doctor/admin), unique on email |
| `doctor_profiles` | One row per doctor: specialisation, slot duration, bio |
| `doctor_availability` | Weekly recurring working hours per doctor (day of week + start/end time) |
| `doctor_leaves` | Dates a doctor is unavailable, unique per (doctor, date) |
| `appointments` | Bookings: patient, doctor, slot times, status (`held`/`confirmed`/`cancelled`/`completed`), symptoms + AI pre-visit summary, post-visit notes + prescription + AI post-visit summary |
| `medication_reminders` | One row per prescribed medication, driving the reminder cron job |
| `notification_outbox` | Every outbound email, with status/attempts/last error — the retry queue |
| `calendar_connections` | Per-user Google OAuth tokens |
| `calendar_events` | Maps an (appointment, user) pair to its Google Calendar event id |

The load-bearing constraint: `appointments` has a **partial unique index** on `(doctor_id, slot_start)` where `status != 'cancelled'`. See `docs/SYSTEM_DESIGN.md` for why this — not application-level locking — is what actually prevents double-booking.

## API docs

All routes are prefixed `/api`. Authenticated routes take `Authorization: Bearer <jwt>`.

### Auth (`/api/auth`)
| Method & path | Description |
|---|---|
| `POST /register` | Patient self-registration: `{ email, password, name, phone? }` → `{ token, user }` |
| `POST /login` | `{ email, password }` → `{ token, user }` |
| `GET /me` | Current user, from the JWT |

### Patient (`/api/patient`, role: patient)
| Method & path | Description |
|---|---|
| `GET /doctors?specialisation=` | List doctors, optionally filtered |
| `GET /doctors/:id/slots?date=YYYY-MM-DD` | Available slots for that date |
| `POST /appointments/hold` | `{ doctorId, slotStart, slotEnd }` → holds a slot for 5 min, `409` if already taken |
| `POST /appointments/:id/confirm` | `{ symptoms }` → generates the AI pre-visit summary, confirms the booking, queues confirmation emails, syncs calendars |
| `GET /appointments/mine` | The patient's booking history |
| `POST /appointments/:id/cancel` | Cancels a confirmed booking, notifies the doctor, removes calendar events |

### Doctor (`/api/doctor`, role: doctor)
| Method & path | Description |
|---|---|
| `GET /appointments` | The doctor's bookings, including the AI pre-visit summary |
| `GET /leaves` | The doctor's recorded leave days |
| `POST /appointments/:id/visit` | `{ notes, prescription: [{ medication, dosage, timesPerDay, durationDays }] }` → generates the AI post-visit summary, schedules medication reminders, marks the visit complete |

### Admin (`/api/admin`, role: admin)
| Method & path | Description |
|---|---|
| `GET /doctors` | List all doctors |
| `POST /doctors` | Create a doctor account + profile + weekly availability |
| `PATCH /doctors/:id` | Update specialisation/slot duration/bio/availability |
| `POST /doctors/:id/leave` | `{ date, reason? }` → records leave, cancels affected held/confirmed bookings, notifies patients and the doctor |

### Calendar (`/api/calendar`)
| Method & path | Description |
|---|---|
| `GET /status` | Whether Google Calendar integration is configured |
| `GET /oauth/start` | Returns the Google consent URL for the current user |
| `GET /oauth/callback` | OAuth redirect target; stores tokens, redirects back to the app |

## Known limitations

- Reschedule isn't a separate endpoint — a patient cancels and rebooks. The brief's "updated ... on reschedule" calendar behavior is covered for cancellation, not a dedicated reschedule flow.
- The OAuth `state` parameter is the raw user id, not a signed/short-lived token — fine for this assignment's scope, but would need hardening (CSRF protection) before production use.
- There's no password-reset flow; the admin seed script prints a temporary password to change after first login.
