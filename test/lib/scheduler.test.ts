import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, testEnv } from "../helpers";
import {
  users,
  doctorProfiles,
  appointments,
  medicationReminders,
  notificationOutbox,
} from "../../src/server/db/schema";
import { runScheduledTasks } from "../../src/server/lib/scheduler";

async function makeCompletedAppointment() {
  const patientId = crypto.randomUUID();
  await db.insert(users).values({
    id: patientId,
    email: `p-${patientId}@example.com`,
    passwordHash: "unused",
    role: "patient",
    name: "P",
  });
  const doctorUserId = crypto.randomUUID();
  await db.insert(users).values({
    id: doctorUserId,
    email: `d-${doctorUserId}@example.com`,
    passwordHash: "unused",
    role: "doctor",
    name: "D",
  });
  const doctorId = crypto.randomUUID();
  await db.insert(doctorProfiles).values({
    id: doctorId,
    userId: doctorUserId,
    specialisation: "General",
  });
  const apptId = crypto.randomUUID();
  await db.insert(appointments).values({
    id: apptId,
    patientId,
    doctorId,
    slotStart: "2020-01-06T09:00:00.000Z",
    slotEnd: "2020-01-06T09:30:00.000Z",
    status: "completed",
  });
  return { apptId, patientId };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function remindersQueuedFor(patientId: string) {
  const rows = await db
    .select()
    .from(notificationOutbox)
    .where(eq(notificationOutbox.userId, patientId));
  return rows.filter((r) => r.type === "medication_reminder");
}

describe("medication reminder scheduling", () => {
  it("never queues a dose whose time has already passed today", async () => {
    const { apptId, patientId } = await makeCompletedAppointment();
    await db.insert(medicationReminders).values({
      id: crypto.randomUUID(),
      appointmentId: apptId,
      medication: "Ibuprofen",
      dosage: "200mg",
      timesPerDay: 3, // doses at 08:00, 12:00, 16:00 UTC
      startDate: today(),
      durationDays: 5,
    });

    await runScheduledTasks(testEnv, db);

    const queued = await remindersQueuedFor(patientId);
    const now = new Date();
    for (const row of queued) {
      // Every queued reminder must be for a future dose time; otherwise the
      // outbox delivers a backlog of the day's doses all at once.
      expect(new Date(row.scheduledFor).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("stops reminding after the course length has elapsed", async () => {
    const { apptId, patientId } = await makeCompletedAppointment();
    // A 5-day course that started 5 days ago covered days 0-4 and is over.
    await db.insert(medicationReminders).values({
      id: crypto.randomUUID(),
      appointmentId: apptId,
      medication: "Amoxicillin",
      dosage: "500mg",
      timesPerDay: 2,
      startDate: daysAgo(5),
      durationDays: 5,
    });

    await runScheduledTasks(testEnv, db);

    expect(await remindersQueuedFor(patientId)).toHaveLength(0);
  });

  it("still reminds on the final day of the course", async () => {
    const { apptId, patientId } = await makeCompletedAppointment();
    // Started 4 days ago, 5-day course -> today is day 5, the last one.
    await db.insert(medicationReminders).values({
      id: crypto.randomUUID(),
      appointmentId: apptId,
      medication: "Paracetamol",
      dosage: "500mg",
      timesPerDay: 12, // every hour 08:00-20:00, so some dose is always ahead
      startDate: daysAgo(4),
      durationDays: 5,
    });

    await runScheduledTasks(testEnv, db);

    // Only meaningful while there's still a future dose slot left today.
    if (new Date().getUTCHours() < 19) {
      expect((await remindersQueuedFor(patientId)).length).toBeGreaterThan(0);
    }
  });
});
