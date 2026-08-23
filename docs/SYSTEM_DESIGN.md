# System Design Write-up

## Double-booking prevention

The tempting approach is to check for a conflicting appointment before inserting a new one — `SELECT ... WHERE doctor_id = ? AND slot_start = ?`, then `INSERT` if nothing comes back. That's wrong under concurrency: two patients hitting "book" on the same slot within milliseconds of each other can both pass the `SELECT` before either commits the `INSERT`, and you end up with two rows for one slot.

Rather than an application-level lock (a mutex keyed on doctor+slot, or a `SELECT ... FOR UPDATE`-style pattern SQLite doesn't really support), the schema pushes the guarantee down to the database: `appointments` has a **partial unique index** on `(doctor_id, slot_start)` where `status != 'cancelled'`. SQLite enforces this atomically as part of the `INSERT` itself — two concurrent inserts for the same slot race to write, and the loser gets a real constraint-violation error back, no window for both to succeed. The route catches that error and returns `409 Conflict`. This is verified directly in `test/routes/booking.test.ts`, which fires two holds for the identical slot with `Promise.all` and asserts the outcome is `[201, 409]`, never `[201, 201]`.

The index is partial (excluding cancelled rows) so that once someone cancels, the slot becomes bookable again without needing to delete history — cancelled appointments stay in the table for the audit trail, just outside the uniqueness check.

## Slot hold mechanism

Booking isn't a single action from the patient's point of view — they pick a slot, then have to write out their symptoms before it's a real booking. If the slot were only reserved at the final "confirm" step, two patients could both be filling out the symptom form for the same slot at once, and whoever finishes typing last would get a confusing failure after doing all that work.

Instead, `POST /appointments/hold` reserves the slot immediately (relying on the same unique index above) and stamps it with a 5-minute `hold_expires_at`. The symptom form is then filled in against an already-reserved slot; `POST /appointments/:id/confirm` fills in `symptoms_text`, generates the AI summary, and flips status from `held` to `confirmed`. An abandoned hold has to expire rather than lock the slot forever, so this is handled two ways: lazily, a new hold attempt on that exact slot first checks whether the existing hold expired and releases it before inserting; and actively, the cron job (`scheduler.ts`, every 15 minutes) sweeps all `held` appointments and cancels any past their expiry. Neither path is load-bearing alone — the lazy check keeps the common case fast, the sweep guarantees an abandoned hold never lingers even if nobody else contests that slot.

## Doctor leave conflict handling

Marking a doctor on leave can't just insert a `doctor_leaves` row and stop there — any patient already booked into that date now has an appointment nobody will show up for. `POST /admin/doctors/:id/leave` inserts the leave record, then queries every appointment for that doctor on that date whose status is `held` or `confirmed`, and cancels each one through a shared `cancelAppointmentAndNotify` helper: it sets the appointment to `cancelled`, queues a `leave_conflict` email to the patient (and a heads-up to the doctor), and removes both sides' Google Calendar events.

The status filter deliberately excludes `completed` appointments — a visit that already happened shouldn't be retroactively cancelled because the doctor is now marked unavailable for that historical date. (An early version of this filter used "not cancelled" instead of "held or confirmed" and would have wiped out completed visit records; `test/routes/booking.test.ts` now covers this as a regression case.) The same helper function backs patient-initiated cancellation, so "notify both sides and clean up the calendar" can't drift between the two call sites.

## Notification failure handling

Email is a third-party dependency outside this system's control, so nothing sends synchronously inside a request. Every notification — booking confirmation, cancellation, leave conflict, medication reminder — is written to a `notification_outbox` table with status `pending`. The cron job attempts delivery for due, non-exhausted rows via SendGrid's HTTP API, and on failure increments `attempts` and records `last_error`, leaving the row `pending` for the next tick (capped at 5 attempts, after which it's marked `failed` instead of retried forever). Without a `SENDGRID_API_KEY`, delivery is stubbed to a console log and marked sent, so an unconfigured environment doesn't spam retries against a provider that was never wired up.

LLM calls follow the same "never block the request" philosophy at a smaller scale: `generatePreVisitSummary` and `generatePostVisitSummary` catch every failure mode (missing key, non-2xx, network error, malformed JSON) and return `null` rather than throwing. Booking and visit-completion both proceed regardless — the summary is simply stored as unavailable and can be regenerated or filled in manually later. Google Calendar sync follows the identical pattern: an unconfigured or failed calendar call is logged and skipped, never surfaced to the user as a booking failure.
