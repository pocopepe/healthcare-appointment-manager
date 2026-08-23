// Runs on Cloudflare's Cron Trigger (every 15 min, see wrangler.jsonc).
// Three jobs: release expired slot holds, queue today's medication
// reminders, and retry any email in the outbox that hasn't gone out yet.

import { eq, and, lte, isNull, or, ne } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Db } from "../db/client";
import { appointments, medicationReminders } from "../db/schema";
import { isHoldExpired } from "./slots";
import { queueEmail, processOutbox } from "./email";

async function releaseExpiredHolds(db: Db) {
  const held = await db.query.appointments.findMany({
    where: eq(appointments.status, "held"),
  });
  const expired = held.filter((a) => isHoldExpired(a.holdExpiresAt));
  for (const appt of expired) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledReason: "hold_expired" })
      .where(eq(appointments.id, appt.id));
  }
  return expired.length;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function queueMedicationReminders(db: Db) {
  const today = new Date().toISOString().slice(0, 10);

  const active = await db.query.medicationReminders.findMany({
    where: and(
      lte(medicationReminders.startDate, today),
      or(
        isNull(medicationReminders.lastQueuedDate),
        ne(medicationReminders.lastQueuedDate, today),
      ),
    ),
  });

  const now = new Date();
  let queued = 0;
  for (const reminder of active) {
    // A 5-day course covers the start date plus four more, so the last day
    // is startDate + (durationDays - 1) — not + durationDays, which would
    // keep reminding the patient for one extra day.
    const endDate = addDays(reminder.startDate, Math.max(reminder.durationDays - 1, 0));
    if (today > endDate) continue;
    if (reminder.timesPerDay < 1) continue;

    const appt = await db.query.appointments.findFirst({
      where: eq(appointments.id, reminder.appointmentId),
    });
    if (!appt) continue;

    // Spread doses evenly across waking hours (08:00-20:00 UTC) rather than
    // firing them all at once.
    const windowStart = 8;
    const windowEnd = 20;
    const step = (windowEnd - windowStart) / reminder.timesPerDay;

    for (let i = 0; i < reminder.timesPerDay; i++) {
      const hour = Math.floor(windowStart + step * i);
      const scheduledFor = new Date(`${today}T${String(hour).padStart(2, "0")}:00:00.000Z`);
      // Don't queue dose times that have already passed. A prescription
      // written at 17:00 would otherwise dump that morning's and midday's
      // reminders into the patient's inbox the moment the next tick runs.
      if (scheduledFor <= now) continue;
      await queueEmail(db, {
        userId: appt.patientId,
        appointmentId: appt.id,
        type: "medication_reminder",
        subject: `Reminder: take your ${reminder.medication}`,
        body: `Time for your dose of ${reminder.medication} (${reminder.dosage}).`,
        scheduledFor,
      });
      queued++;
    }

    await db
      .update(medicationReminders)
      .set({ lastQueuedDate: today })
      .where(eq(medicationReminders.id, reminder.id));
  }

  return queued;
}

export async function runScheduledTasks(env: Bindings, db: Db) {
  const [releasedHolds, remindersQueued, outboxResult] = await Promise.all([
    releaseExpiredHolds(db),
    queueMedicationReminders(db),
    processOutbox(env, db),
  ]);

  console.info(
    `[scheduler] released ${releasedHolds} expired holds, queued ${remindersQueued} reminders, processed ${outboxResult.processed} outbox entries`,
  );
}
