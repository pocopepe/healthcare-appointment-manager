import { Hono } from "hono";
import { eq, and, ne } from "drizzle-orm";
import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import { doctorProfiles, appointments, users } from "../db/schema";
import { authenticate, requireRole } from "../middleware/auth";
import { getAvailableSlots, isHoldExpired, computeHoldExpiry } from "../lib/slots";
import { generatePreVisitSummary } from "../lib/llm";
import { queueEmail } from "../lib/email";
import { upsertCalendarEvent } from "../lib/calendar";
import { cancelAppointmentAndNotify } from "../lib/appointment-notifications";

const patient = new Hono<AppEnv>();
patient.use("*", authenticate, requireRole("patient"));

patient.get("/doctors", async (c) => {
  const specialisation = c.req.query("specialisation");
  const db = createDb(c.env.DB);

  const rows = await db
    .select({
      id: doctorProfiles.id,
      specialisation: doctorProfiles.specialisation,
      bio: doctorProfiles.bio,
      slotDurationMinutes: doctorProfiles.slotDurationMinutes,
      name: users.name,
    })
    .from(doctorProfiles)
    .innerJoin(users, eq(doctorProfiles.userId, users.id));

  const filtered = specialisation
    ? rows.filter(
        (r) => r.specialisation.toLowerCase() === specialisation.toLowerCase(),
      )
    : rows;

  return c.json(filtered);
});

patient.get("/doctors/:doctorId/slots", async (c) => {
  const date = c.req.query("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date query param (YYYY-MM-DD) is required" }, 400);
  }
  const db = createDb(c.env.DB);
  const slots = await getAvailableSlots(db, c.req.param("doctorId"), date);
  return c.json(slots);
});

// Step 1: briefly hold a slot so a patient can fill in the symptom form
// without another patient grabbing it. The hold itself relies on the
// unique (doctorId, slotStart) index for concurrency safety: if two
// requests race for the same slot, the DB rejects the second insert.
patient.post("/appointments/hold", async (c) => {
  const body = await c.req.json<{ doctorId?: string; slotStart?: string; slotEnd?: string }>();
  const { doctorId, slotStart, slotEnd } = body;
  if (!doctorId || !slotStart || !slotEnd) {
    return c.json({ error: "doctorId, slotStart, and slotEnd are required" }, 400);
  }

  const db = createDb(c.env.DB);

  // Best-effort cleanup so an expired hold on this exact slot doesn't block
  // a fresh attempt (the cron job also does this periodically).
  const stale = await db.query.appointments.findFirst({
    where: and(
      eq(appointments.doctorId, doctorId),
      eq(appointments.slotStart, slotStart),
      eq(appointments.status, "held"),
    ),
  });
  if (stale && isHoldExpired(stale.holdExpiresAt)) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledReason: "hold_expired" })
      .where(eq(appointments.id, stale.id));
  }

  const id = crypto.randomUUID();
  try {
    await db.insert(appointments).values({
      id,
      patientId: c.get("userId"),
      doctorId,
      slotStart,
      slotEnd,
      status: "held",
      holdExpiresAt: computeHoldExpiry(),
    });
  } catch (err) {
    if (String(err).includes("UNIQUE constraint failed")) {
      return c.json({ error: "This slot was just taken. Please pick another." }, 409);
    }
    throw err;
  }

  return c.json({ id, holdExpiresAt: computeHoldExpiry() }, 201);
});

// Step 2: submit symptoms and confirm the held slot into a real booking.
patient.post("/appointments/:id/confirm", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ symptoms?: string }>();
  if (!body.symptoms || body.symptoms.trim().length === 0) {
    return c.json({ error: "symptoms is required" }, 400);
  }

  const db = createDb(c.env.DB);
  const held = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, id), eq(appointments.patientId, c.get("userId"))),
  });
  if (!held) return c.json({ error: "Appointment not found" }, 404);
  if (held.status !== "held") {
    return c.json({ error: "This appointment is not awaiting confirmation" }, 400);
  }
  if (isHoldExpired(held.holdExpiresAt)) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledReason: "hold_expired" })
      .where(eq(appointments.id, id));
    return c.json({ error: "Your hold on this slot expired. Please rebook." }, 410);
  }

  const preVisitSummary = await generatePreVisitSummary(c.env, body.symptoms);

  await db
    .update(appointments)
    .set({
      status: "confirmed",
      symptomsText: body.symptoms,
      aiPreVisitSummary: preVisitSummary,
      holdExpiresAt: null,
    })
    .where(eq(appointments.id, id));

  const doctor = await db.query.doctorProfiles.findFirst({
    where: eq(doctorProfiles.id, held.doctorId),
  });
  const doctorUser = doctor
    ? await db.query.users.findFirst({ where: eq(users.id, doctor.userId) })
    : null;
  const patientUser = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
  });

  const when = new Date(held.slotStart).toUTCString();
  if (patientUser) {
    await queueEmail(db, {
      userId: patientUser.id,
      appointmentId: id,
      type: "booking_confirmation",
      subject: "Your appointment is confirmed",
      body: `Your appointment with Dr. ${doctorUser?.name ?? ""} is confirmed for ${when}.`,
    });
    await upsertCalendarEvent(c.env, db, patientUser.id, id, {
      summary: `Appointment with Dr. ${doctorUser?.name ?? ""}`,
      description: "Booked via Healthcare Appointment Manager",
      startIso: held.slotStart,
      endIso: held.slotEnd,
    });
  }
  if (doctorUser) {
    await queueEmail(db, {
      userId: doctorUser.id,
      appointmentId: id,
      type: "booking_confirmation",
      subject: "New appointment booked",
      body: `New appointment with ${patientUser?.name ?? "a patient"} on ${when}.`,
    });
    await upsertCalendarEvent(c.env, db, doctorUser.id, id, {
      summary: `Appointment with ${patientUser?.name ?? "patient"}`,
      description: "Booked via Healthcare Appointment Manager",
      startIso: held.slotStart,
      endIso: held.slotEnd,
    });
  }

  return c.json({ id, status: "confirmed", aiPreVisitSummary: preVisitSummary });
});

patient.get("/appointments/mine", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db.query.appointments.findMany({
    where: and(
      eq(appointments.patientId, c.get("userId")),
      ne(appointments.status, "held"),
    ),
    orderBy: (a, { desc }) => [desc(a.slotStart)],
  });
  return c.json(rows);
});

patient.post("/appointments/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  const appt = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, id), eq(appointments.patientId, c.get("userId"))),
  });
  if (!appt) return c.json({ error: "Appointment not found" }, 404);
  if (appt.status === "cancelled" || appt.status === "completed") {
    return c.json({ error: `Cannot cancel a ${appt.status} appointment` }, 400);
  }

  await cancelAppointmentAndNotify(c.env, db, id, "cancelled_by_patient", "cancellation");

  return c.json({ id, status: "cancelled" });
});

export default patient;
