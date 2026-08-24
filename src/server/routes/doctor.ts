import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import {
  appointments,
  doctorProfiles,
  doctorLeaves,
  medicationReminders,
} from "../db/schema";
import { authenticate, requireRole } from "../middleware/auth";
import { generatePostVisitSummary, explainUnavailable } from "../lib/llm";
import { queueEmail } from "../lib/email";

const doctor = new Hono<AppEnv>();
doctor.use("*", authenticate, requireRole("doctor"));

async function getOwnDoctorProfile(db: ReturnType<typeof createDb>, userId: string) {
  return db.query.doctorProfiles.findFirst({
    where: eq(doctorProfiles.userId, userId),
  });
}

doctor.get("/appointments", async (c) => {
  const db = createDb(c.env.DB);
  const profile = await getOwnDoctorProfile(db, c.get("userId"));
  if (!profile) return c.json({ error: "No doctor profile for this account" }, 404);

  const rows = await db.query.appointments.findMany({
    where: eq(appointments.doctorId, profile.id),
    orderBy: (a, { desc }) => [desc(a.slotStart)],
  });
  return c.json(rows);
});

doctor.get("/leaves", async (c) => {
  const db = createDb(c.env.DB);
  const profile = await getOwnDoctorProfile(db, c.get("userId"));
  if (!profile) return c.json({ error: "No doctor profile for this account" }, 404);

  const rows = await db.query.doctorLeaves.findMany({
    where: eq(doctorLeaves.doctorId, profile.id),
  });
  return c.json(rows);
});

// Doctor submits post-visit notes + prescription. This generates the
// patient-friendly AI summary, schedules medication reminders, and marks
// the visit complete.
doctor.post("/appointments/:id/visit", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    notes?: string;
    prescription?: Array<{
      medication: string;
      dosage: string;
      timesPerDay: number;
      durationDays: number;
    }>;
  }>();

  if (!body.notes || body.notes.trim().length === 0) {
    return c.json({ error: "notes is required" }, 400);
  }

  const db = createDb(c.env.DB);
  const profile = await getOwnDoctorProfile(db, c.get("userId"));
  if (!profile) return c.json({ error: "No doctor profile for this account" }, 404);

  const appt = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, id), eq(appointments.doctorId, profile.id)),
  });
  if (!appt) return c.json({ error: "Appointment not found" }, 404);
  if (appt.status !== "confirmed") {
    return c.json(
      { error: `Cannot record a visit for a ${appt.status} appointment` },
      400,
    );
  }

  const prescription = body.prescription ?? [];
  const summary = await generatePostVisitSummary(c.env, db, body.notes, prescription);
  // The post-visit summary is free text shown to the patient, so an
  // unavailable one is stored as the explanation rather than left blank.
  // AI-written prose is never the authoritative source for dosing — the
  // structured `prescription` field is — so say so alongside it.
  const postVisitSummary = summary.ok
    ? `${summary.value}\n\n---\nThis summary was drafted automatically to help explain your visit. Always follow the prescription exactly as listed in your appointment record, and ask your doctor or pharmacist if anything differs or is unclear.`
    : explainUnavailable(summary.reason);

  await db
    .update(appointments)
    .set({
      status: "completed",
      postVisitNotes: body.notes,
      prescription,
      aiPostVisitSummary: postVisitSummary,
      aiStatus: summary.ok ? null : summary.reason,
    })
    .where(eq(appointments.id, id));

  const today = new Date().toISOString().slice(0, 10);
  for (const item of prescription) {
    await db.insert(medicationReminders).values({
      id: crypto.randomUUID(),
      appointmentId: id,
      medication: item.medication,
      dosage: item.dosage,
      timesPerDay: item.timesPerDay,
      startDate: today,
      durationDays: item.durationDays,
    });
  }

  await queueEmail(db, {
    userId: appt.patientId,
    appointmentId: id,
    type: "visit_summary",
    subject: "Your visit summary is ready",
    body: postVisitSummary,
  });

  return c.json({
    id,
    status: "completed",
    aiPostVisitSummary: postVisitSummary,
    aiStatus: summary.ok ? null : summary.reason,
  });
});

export default doctor;
