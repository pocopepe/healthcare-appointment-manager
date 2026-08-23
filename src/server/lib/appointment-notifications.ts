// Shared cancellation flow: used both when a patient cancels directly and
// when an admin marks a doctor on leave and has to cancel every booking
// that falls on that date. Keeps the "notify both sides + clean up
// calendar events" behaviour in one place.

import { eq } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Db } from "../db/client";
import { appointments, doctorProfiles, users } from "../db/schema";
import { queueEmail, type NotificationType } from "./email";
import { deleteCalendarEvent } from "./calendar";

export async function cancelAppointmentAndNotify(
  env: Bindings,
  db: Db,
  appointmentId: string,
  reason: string,
  notificationType: Extract<NotificationType, "cancellation" | "leave_conflict">,
  extraMessage?: string,
) {
  const appt = await db.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
  });
  if (!appt) return;

  await db
    .update(appointments)
    .set({ status: "cancelled", cancelledReason: reason })
    .where(eq(appointments.id, appointmentId));

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
  const message =
    extraMessage ?? `Your appointment on ${when} has been cancelled.`;

  if (patientUser) {
    await queueEmail(db, {
      userId: patientUser.id,
      appointmentId,
      type: notificationType,
      subject: "Appointment cancelled",
      body: message,
    });
    await deleteCalendarEvent(env, db, patientUser.id, appointmentId);
  }
  if (doctorUser) {
    await queueEmail(db, {
      userId: doctorUser.id,
      appointmentId,
      type: notificationType,
      subject: "Appointment cancelled",
      body: `The appointment with ${patientUser?.name ?? "a patient"} on ${when} has been cancelled.`,
    });
    await deleteCalendarEvent(env, db, doctorUser.id, appointmentId);
  }
}
