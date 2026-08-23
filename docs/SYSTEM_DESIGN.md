# System Design Write-up

## Double-booking prevention

Checking for a conflict before inserting — `SELECT`, then `INSERT` if nothing comes back — is wrong under concurrency: two patients booking the same slot milliseconds apart can both pass the `SELECT` before either commits, leaving two rows for one slot.

Rather than an application-level lock, the schema pushes the guarantee into the database: `appointments` has a **partial unique index** on `(doctor_id, slot_start)` where `status != 'cancelled'`. SQLite enforces it atomically during the `INSERT`, so of two racing inserts the loser gets a constraint violation, which the route turns into `409 Conflict`. `test/routes/booking.test.ts` fires two holds at one slot with `Promise.all` and asserts `[201, 409]`, never `[201, 201]`. Excluding cancelled rows lets a cancellation free the slot while the row stays for the audit trail.

That index is necessary but **not sufficient**: it only catches an *identical* `slot_start`. Since the endpoint takes `slotStart`/`slotEnd` from the client, a request for 09:15–09:45 against an existing 09:00–09:30 booking has a different start, sails past the index, and genuinely double-books the doctor. Trusting those fields also allowed booking outside working hours, on a leave day, or in the past. So the endpoint validates rather than trusts, in two layers:

1. **`isSlotOnSchedule`** — the start/end must be a slot the doctor actually offers: inside a working-hours window, on the slot-duration grid, not a leave day, in the future. Anything else is `400`. Grid slots don't overlap by construction, so this alone kills the off-grid attack.
2. **`findOverlappingAppointment`** — a half-open interval check (`existing.start < requested.end && existing.end > requested.start`) returning `409`, covering what the grid can't: widening a doctor's slot duration shifts the grid across bookings made under the old one, yielding an on-grid slot that still overlaps a real appointment.

Separating "not a real slot" (`400`) from "already taken" (`409`) matters for the race — both racers clear the grid check, so the loser must read as a conflict. The overlap check is a best-effort read both can clear, leaving the unique index the final atomic arbiter.

## Slot hold mechanism

Booking isn't one action for the patient: they pick a slot, then write out their symptoms. If the slot were only reserved at the final "confirm" step, two patients could fill in the form for the same slot at once and the slower typist would fail after doing all the work.

So `POST /appointments/hold` reserves the slot immediately (via the same unique index) with a 5-minute `hold_expires_at`, and `confirm` then stores the symptoms, generates the AI summary, and flips `held` → `confirmed`. An abandoned hold must expire rather than lock the slot forever, handled two ways: lazily, a new hold on that slot releases an expired one before inserting; actively, the cron sweeps `held` rows past expiry every 15 minutes. The lazy path keeps the common case fast; the sweep guarantees nothing lingers if no one else contests the slot.

## Doctor leave conflict handling

Marking a doctor on leave can't just insert a `doctor_leaves` row — patients already booked that date would hold appointments nobody attends. `POST /admin/doctors/:id/leave` records the leave, then finds every `held` or `confirmed` appointment for that doctor on that date and cancels each through a shared `cancelAppointmentAndNotify`: set `cancelled`, queue a `leave_conflict` email to the patient and a heads-up to the doctor, and delete both sides' calendar events.

The status filter deliberately excludes `completed` visits — one that already happened shouldn't be retroactively cancelled because the doctor is now marked away for that past date. (An earlier filter said "not cancelled" instead of "held or confirmed" and would have wiped completed records; `test/routes/booking.test.ts` covers it.) The same helper backs patient-initiated cancellation, so the notify-and-clean-up behaviour can't drift between call sites.

## Notification failure handling

Email is a third-party dependency outside this system's control, so nothing sends synchronously inside a request. Every notification — confirmation, cancellation, leave conflict, medication reminder — is written to `notification_outbox` as `pending`. The cron job attempts delivery for due rows via SendGrid; on failure it increments `attempts`, records `last_error`, and leaves the row `pending` for the next tick, capped at 5 attempts before being marked `failed` rather than retried forever. Without a `SENDGRID_API_KEY` delivery is stubbed to a log and marked sent, so an unconfigured environment doesn't accumulate retries against a provider that was never wired up.

Reminders are queued a day at a time, skipping dose times that have already passed — otherwise a prescription written at 17:00 would dump that morning's and midday's reminders into the outbox at once, and the patient would get the lot on the next tick.

LLM calls follow the same never-block-the-request rule: `generatePreVisitSummary` and `generatePostVisitSummary` catch every failure mode (missing key, non-2xx, network error, malformed JSON) and return `null` instead of throwing. Booking and visit completion proceed regardless, with the summary stored as unavailable. Google Calendar sync behaves identically — an unconfigured or failing call is logged and skipped, never surfaced as a booking failure.
