// Runs on Cloudflare's Cron Trigger (every 15 min, see wrangler.jsonc).
// Three jobs: release expired slot holds, queue today's medication
// reminders, and retry any email in the outbox that hasn't gone out yet.

import { eq, and, lte, gt, isNull, or, ne } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Db } from "../db/client";
import {
  appointments,
  medicationReminders,
  doctorProfiles,
  users,
} from "../db/schema";
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

// How far ahead of an appointment the "don't forget" email goes out.
const REMINDER_LEAD_HOURS = 24;

// Reminds both sides of an upcoming appointment once, a day before it starts.
// `reminder_sent_at` is what stops the 15-minute tick re-sending it.
async function queueAppointmentReminders(db: Db) {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + REMINDER_LEAD_HOURS * 3600_000);

  const upcoming = await db.query.appointments.findMany({
    where: and(
      eq(appointments.status, "confirmed"),
      isNull(appointments.reminderSentAt),
      gt(appointments.slotStart, now.toISOString()),
      lte(appointments.slotStart, windowEnd.toISOString()),
    ),
  });

  let queued = 0;
  for (const appt of upcoming) {
    const doctor = await db.query.doctorProfiles.findFirst({
      where: eq(doctorProfiles.id, appt.doctorId),
    });
    const doctorUser = doctor
      ? await db.query.users.findFirst({ where: eq(users.id, doctor.userId) })
      : null;
    const patientUser = await db.query.users.findFirst({
      where: eq(users.id, appt.patientId),
    });

    const when = new Date(appt.slotStart).toUTCString();

    if (patientUser) {
      await queueEmail(db, {
        userId: patientUser.id,
        appointmentId: appt.id,
        type: "appointment_reminder",
        subject: "Reminder: your appointment is tomorrow",
        body: `This is a reminder that your appointment with Dr. ${doctorUser?.name ?? ""} is on ${when}.`,
      });
      queued++;
    }
    if (doctorUser) {
      await queueEmail(db, {
        userId: doctorUser.id,
        appointmentId: appt.id,
        type: "appointment_reminder",
        subject: "Reminder: appointment tomorrow",
        body: `Reminder: you have an appointment with ${patientUser?.name ?? "a patient"} on ${when}.`,
      });
      queued++;
    }

    await db
      .update(appointments)
      .set({ reminderSentAt: new Date().toISOString() })
      .where(eq(appointments.id, appt.id));
  }

  return queued;
}

export async function runScheduledTasks(env: Bindings, db: Db) {
  const [releasedHolds, medsQueued, apptReminders, outboxResult] = await Promise.all([
    releaseExpiredHolds(db),
    queueMedicationReminders(db),
    queueAppointmentReminders(db),
    processOutbox(env, db),
  ]);

  console.info(
    `[scheduler] released ${releasedHolds} expired holds, queued ${medsQueued} medication reminders and ${apptReminders} appointment reminders, processed ${outboxResult.processed} outbox entries`,
  );
}
