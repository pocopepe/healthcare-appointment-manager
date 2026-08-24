# Healthcare Appointment & Follow-up Manager

**Live:** https://healthcare-appointment-manager.avijusanjai.workers.dev

| Role | Email | Password |
|---|---|---|
| Patient | `patient@demo.test` | `demopatient123` |
| Doctor | `cardio@demo.test` | `demodoctor123` |

A clinic booking platform with separate patient, doctor and admin portals. Patients describe symptoms while booking; an LLM turns that into a pre-visit summary with an urgency level for the doctor. After the visit, the doctor's notes and prescription become a patient-friendly summary, medication reminders are scheduled, and both sides stay in sync over email and Google Calendar.

Hono API + React frontend deployed as a single Cloudflare Worker, backed by D1 (SQLite). Five runtime dependencies.

## How a visit flows

1. **Patient** searches doctors by specialisation and picks a slot. The slot is **held for 5 minutes** while they fill in the symptom form, so nobody else can take it mid-typing.
2. **Confirm** → the LLM produces `{ urgency, chiefComplaint, suggestedQuestions[] }`, stored on the appointment. Confirmation emails are queued and calendar events created for both parties.
3. **Doctor** opens the appointment already briefed by that summary, records clinical notes and a structured prescription.
4. **Complete** → a patient-friendly summary is generated, medication reminders are scheduled from the prescription frequency, and the summary is emailed.
5. Throughout: reschedule moves the calendar event in place, cancellation deletes it, and an admin marking the doctor on leave cancels affected bookings and notifies everyone.

A **Cron Trigger every 15 minutes** releases abandoned holds, queues medication reminders (spread 08:00–20:00 UTC) and appointment reminders (24h ahead, once), and flushes the email outbox with retries.

## Design decisions

**Double-booking is enforced by the database.** A partial unique index on `(doctor_id, slot_start)` where `status != 'cancelled'` makes two concurrent bookings of one slot atomically impossible — the loser gets a constraint violation, not a second row. But that index only catches an *identical* start time, and the endpoint receives start/end from the client: a request for 09:15–09:45 against an existing 09:00–09:30 booking has a different start and slips straight past it. So requested slots are also validated against the doctor's real schedule grid (working hours, slot duration, leave days, not in the past), plus an interval-overlap check for when an admin widens slot duration over existing bookings. Off-schedule is a `400`, already-taken is a `409`. Full reasoning in [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md).

**The LLM is not trusted with dosages.** Given only the doctor's shorthand (`Rx ibuprofen 400mg TDS 5/7`), the model expanded it to *"4 times a day, 5 days a week (Monday to Friday)"* — wrong frequency, wrong duration. The prescription is now passed as structured data with explicit rules against altering or inventing dosing, and the generated prose carries a disclaimer pointing at the structured `prescription` field as the source of truth. A paraphrase should never be what a patient doses from.

**Nothing third-party can break a booking.** LLM, email and calendar failures all resolve to a typed "unavailable" result rather than throwing. A missing key, exhausted quota, timeout or unparseable response leaves the appointment booked with the summary marked unavailable and explained in the UI.

**AI spend is capped by the app itself.** Workers AI gives 10,000 Neurons/day free (~15–25 per summary). The app counts its own calls per UTC day in `llm_usage` and refuses to call past `LLM_DAILY_LIMIT` (default 200), stopping well short rather than failing hard (free plan) or billing (paid plan). `LLM_DAILY_LIMIT=0` is a kill switch — the test suite uses it so tests never spend anything.

**Email goes through an outbox, never inline.** Every notification is a row with status, attempt count and last error; the cron delivers and retries, capped at 5 attempts. A provider outage delays mail instead of losing it. Recipients on reserved domains (`.test`, `.example`, `localhost`) are deliberately **skipped** — the demo accounts use `@demo.test` and would otherwise hard-bounce, which is what throttles a young sending account.

**Tests run against the real runtime.** 40 tests via `@cloudflare/vitest-pool-workers` execute in workerd against a real D1 instance — no mocked database or HTTP. Several encode regressions found while building: the off-grid overlap above, a leave day wiping completed visits, and reminders firing a day too long and in batches.

## Layout

```
src/server/
  db/schema.ts        Drizzle schema
  lib/                slots (availability, holds, overlap), llm, email,
                      calendar, scheduler (cron), password
  routes/             auth, patient, doctor, admin, calendar
  middleware/auth.ts  JWT verification + role guard
  index.ts            Worker entry (fetch + scheduled)
src/client/pages/     Landing, Login, Register, Settings, one dashboard per role
docs/SYSTEM_DESIGN.md Design write-up
```

## Database schema

`src/server/db/schema.ts` (Drizzle, SQLite):

| Table | Purpose |
|---|---|
| `users` | All accounts (patient/doctor/admin), unique on email |
| `doctor_profiles` | Specialisation, slot duration, bio |
| `doctor_availability` | Weekly working hours (day of week + start/end) |
| `doctor_leaves` | Unavailable dates, unique per (doctor, date) |
| `appointments` | Slot times, status (`held`/`confirmed`/`cancelled`/`completed`), symptoms, both AI summaries, prescription |
| `medication_reminders` | One row per prescribed medication, drives the reminder job |
| `notification_outbox` | Every outbound email with status/attempts/error — the retry queue |
| `calendar_connections` | Per-user Google OAuth tokens |
| `calendar_events` | Maps (appointment, user) → Google event id |
| `llm_usage` | Per-day LLM call count for the spend cap |

## API

All routes under `/api`; authenticated routes take `Authorization: Bearer <jwt>`.

**Auth** — `POST /auth/register` (patients only; doctor/admin are provisioned, so the endpoint can't escalate role) · `POST /auth/login` · `GET /auth/me`

**Patient** (role: patient)
| Route | Purpose |
|---|---|
| `GET /patient/doctors?specialisation=` | List/filter doctors |
| `GET /patient/doctors/:id/slots?date=` | Available slots that day |
| `POST /patient/appointments/hold` | Hold a slot for 5 min; `400` off-schedule, `409` taken |
| `POST /patient/appointments/:id/confirm` | `{ symptoms }` → AI summary, confirm, notify, sync calendar |
| `GET /patient/appointments/mine` | Booking history |
| `POST /patient/appointments/:id/reschedule` | Move it; calendar event updated in place |
| `POST /patient/appointments/:id/cancel` | Cancel, notify, remove calendar event |

**Doctor** (role: doctor) — `GET /doctor/appointments` (with pre-visit summaries) · `GET /doctor/leaves` · `POST /doctor/appointments/:id/visit` `{ notes, prescription[] }` → post-visit summary + medication reminders

**Admin** (role: admin) — `GET|POST /admin/doctors` · `PATCH /admin/doctors/:id` · `POST /admin/doctors/:id/leave` (cancels affected bookings, notifies) · `GET /admin/llm-usage` · `GET /admin/notifications` (the outbox) · `POST /admin/run-jobs` (run cron work on demand)

**Calendar** — `GET /calendar/status` (`configured` + `connected`) · `GET /calendar/oauth/start` · `GET /calendar/oauth/callback` · `DELETE /calendar/connection`

## LLM prompts

From the brief, with the pre-visit one constrained to strict JSON so it can be parsed and stored (`src/server/lib/llm.ts`):

> **Pre-visit:** Analyse these symptoms and return ONLY a JSON object with keys "urgency" (one of "Low", "Medium", "High"), "chiefComplaint" (short string), and "suggestedQuestions" (an array of exactly three strings, questions the doctor should ask). Do not include any text outside the JSON object. Symptoms: `<symptoms>`

> **Post-visit:** Convert these clinical notes into a patient-friendly summary with a medication schedule and follow-up steps. Write in plain, reassuring language a patient with no medical background can follow.
> Rules you must follow exactly: reproduce the medication schedule below word for word in meaning; do not change any dose, frequency, or number of days; do not invent medicines, doses, schedules, tests, or advice not stated below; do not describe the course in weeks or weekdays — it runs for consecutive days; if something is unclear, tell the patient to ask their doctor.
> Medication schedule (authoritative): `<expanded from the structured prescription>` — Clinical notes: `<notes>`

Default provider is **Cloudflare Workers AI** (`@cf/meta/llama-3.1-8b-instruct-fp8`), which needs no API key. Set `LLM_PROVIDER` to `anthropic` or `openai` to swap.

## Running it

```bash
npm install
cp .env.example .dev.vars          # JWT_SECRET is the only one required
npx wrangler d1 create healthcare-appointment-manager-db   # put the id in wrangler.jsonc
npm run db:migrate:local
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme123 npm run db:seed-admin:local
npm run dev                        # http://localhost:5173
npm test                           # 40 tests, real workerd + D1
```

`npm run db:seed-demo` adds three doctors and a demo patient. Deploy with `npm run db:migrate:remote && npm run deploy`; secrets go in via `wrangler secret put <NAME>`, never the repo.

Every integration is optional — see [`.env.example`](.env.example). Without keys the app runs with that feature disabled rather than breaking: no LLM key means summaries are marked unavailable, no `SENDGRID_API_KEY` means notifications are queued and logged instead of delivered (visible in admin → Notifications).

## Google Calendar setup

1. In Google Cloud Console, create a project and enable the **Google Calendar API**.
2. Configure an OAuth consent screen (External); while it's in Testing, only accounts listed as **test users** can authorise.
3. Create an **OAuth 2.0 Client ID** (Web application) with redirect URI `<app-url>/api/calendar/oauth/callback` — it must match `GOOGLE_REDIRECT_URI` character for character or Google returns `redirect_uri_mismatch`.
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as secrets, `GOOGLE_REDIRECT_URI` as a var in `wrangler.jsonc`.
5. Log in → **Settings → Connect Google Calendar**.

Unconfigured, `/api/calendar/status` reports `configured: false` and sync silently no-ops.

## Known limitations

- The OAuth `state` parameter is the raw user id rather than a signed, short-lived token — it would need CSRF hardening before production.
- No password-reset flow; the admin seed script prints a temporary password to change after first login.
- Times are handled in UTC throughout, including what the UI displays. A real clinic would need per-user timezones.
