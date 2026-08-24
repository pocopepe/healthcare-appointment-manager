import { Hono } from "hono";
import { eq, and, gte, lt, inArray, desc } from "drizzle-orm";
import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import {
  users,
  doctorProfiles,
  doctorAvailability,
  doctorLeaves,
  appointments,
  notificationOutbox,
} from "../db/schema";
import { authenticate, requireRole } from "../middleware/auth";
import { hashPassword } from "../lib/password";
import { cancelAppointmentAndNotify } from "../lib/appointment-notifications";
import { getUsageToday } from "../lib/llm";
import { runScheduledTasks } from "../lib/scheduler";

const admin = new Hono<AppEnv>();
admin.use("*", authenticate, requireRole("admin"));

type AvailabilityInput = { dayOfWeek: number; startTime: string; endTime: string };

// Lets an admin see how much of today's self-imposed LLM budget is spent,
// without digging through Cloudflare's dashboard.
admin.get("/llm-usage", async (c) => {
  const db = createDb(c.env.DB);
  const used = await getUsageToday(db);
  const limit = Number(c.env.LLM_DAILY_LIMIT) || 200;
  return c.json({
    date: new Date().toISOString().slice(0, 10),
    provider: c.env.LLM_PROVIDER ?? "workers-ai",
    used,
    limit,
    remaining: Math.max(limit - used, 0),
    exhausted: used >= limit,
  });
});

// Every notification the system has produced, newest first. Without an email
// provider configured nothing actually leaves the building, so this is how
// you confirm the notification logic — and the retry bookkeeping — is working.
admin.get("/notifications", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      id: notificationOutbox.id,
      type: notificationOutbox.type,
      subject: notificationOutbox.subject,
      body: notificationOutbox.body,
      status: notificationOutbox.status,
      attempts: notificationOutbox.attempts,
      lastError: notificationOutbox.lastError,
      scheduledFor: notificationOutbox.scheduledFor,
      sentAt: notificationOutbox.sentAt,
      recipient: users.email,
      recipientName: users.name,
    })
    .from(notificationOutbox)
    .innerJoin(users, eq(notificationOutbox.userId, users.id))
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(Number(c.req.query("limit")) || 50);

  return c.json({
    deliveryEnabled: Boolean(c.env.SENDGRID_API_KEY),
    notifications: rows,
  });
});

// Runs the same jobs the 15-minute Cron Trigger runs. Handy for demoing
// (and debugging) without waiting for the next tick — the jobs are idempotent,
// so running them early just does the work sooner.
admin.post("/run-jobs", async (c) => {
  const db = createDb(c.env.DB);
  await runScheduledTasks(c.env, db);
  return c.json({ ok: true, ranAt: new Date().toISOString() });
});

admin.get("/doctors", async (c) => {
  const db = createDb(c.env.DB);
  const rows = await db
    .select({
      id: doctorProfiles.id,
      userId: doctorProfiles.userId,
      specialisation: doctorProfiles.specialisation,
      slotDurationMinutes: doctorProfiles.slotDurationMinutes,
      bio: doctorProfiles.bio,
      name: users.name,
      email: users.email,
    })
    .from(doctorProfiles)
    .innerJoin(users, eq(doctorProfiles.userId, users.id));
  return c.json(rows);
});

admin.post("/doctors", async (c) => {
  const body = await c.req.json<{
    email?: string;
    password?: string;
    name?: string;
    specialisation?: string;
    slotDurationMinutes?: number;
    bio?: string;
    availability?: AvailabilityInput[];
  }>();

  const email = body.email?.trim().toLowerCase();
  const { password, name, specialisation } = body;
  if (!email || !password || !name || !specialisation) {
    return c.json(
      { error: "email, password, name, and specialisation are required" },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email,
    passwordHash: await hashPassword(password),
    name,
    role: "doctor",
  });

  const doctorId = crypto.randomUUID();
  await db.insert(doctorProfiles).values({
    id: doctorId,
    userId,
    specialisation,
    slotDurationMinutes: body.slotDurationMinutes ?? 30,
    bio: body.bio ?? null,
  });

  if (body.availability?.length) {
    await db.insert(doctorAvailability).values(
      body.availability.map((w) => ({
        id: crypto.randomUUID(),
        doctorId,
        dayOfWeek: w.dayOfWeek,
        startTime: w.startTime,
        endTime: w.endTime,
      })),
    );
  }

  return c.json({ id: doctorId, userId, email, name, specialisation }, 201);
});

admin.patch("/doctors/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    specialisation?: string;
    slotDurationMinutes?: number;
    bio?: string;
    availability?: AvailabilityInput[];
  }>();

  const db = createDb(c.env.DB);
  const profile = await db.query.doctorProfiles.findFirst({
    where: eq(doctorProfiles.id, id),
  });
  if (!profile) return c.json({ error: "Doctor not found" }, 404);

  await db
    .update(doctorProfiles)
    .set({
      specialisation: body.specialisation ?? profile.specialisation,
      slotDurationMinutes: body.slotDurationMinutes ?? profile.slotDurationMinutes,
      bio: body.bio ?? profile.bio,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(doctorProfiles.id, id));

  if (body.availability) {
    await db.delete(doctorAvailability).where(eq(doctorAvailability.doctorId, id));
    if (body.availability.length) {
      await db.insert(doctorAvailability).values(
        body.availability.map((w) => ({
          id: crypto.randomUUID(),
          doctorId: id,
          dayOfWeek: w.dayOfWeek,
          startTime: w.startTime,
          endTime: w.endTime,
        })),
      );
    }
  }

  return c.json({ id, status: "updated" });
});

// Marking a doctor on leave for a date must not silently orphan patients:
// every held/confirmed appointment on that date gets cancelled and both
// the patient and doctor are notified (see lib/appointment-notifications).
admin.post("/doctors/:id/leave", async (c) => {
  const doctorId = c.req.param("id");
  const body = await c.req.json<{ date?: string; reason?: string }>();
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return c.json({ error: "date (YYYY-MM-DD) is required" }, 400);
  }

  const db = createDb(c.env.DB);
  const profile = await db.query.doctorProfiles.findFirst({
    where: eq(doctorProfiles.id, doctorId),
  });
  if (!profile) return c.json({ error: "Doctor not found" }, 404);

  const existingLeave = await db.query.doctorLeaves.findFirst({
    where: and(eq(doctorLeaves.doctorId, doctorId), eq(doctorLeaves.date, body.date)),
  });
  if (existingLeave) {
    return c.json({ error: "Doctor is already on leave for this date" }, 409);
  }

  await db.insert(doctorLeaves).values({
    id: crypto.randomUUID(),
    doctorId,
    date: body.date,
    reason: body.reason ?? null,
  });

  const dayStart = `${body.date}T00:00:00.000Z`;
  const dayEnd = `${body.date}T23:59:59.999Z`;
  const affected = await db.query.appointments.findMany({
    where: and(
      eq(appointments.doctorId, doctorId),
      // Only held/confirmed bookings are disrupted by a leave day —
      // completed visits already happened and shouldn't be touched.
      inArray(appointments.status, ["held", "confirmed"]),
      gte(appointments.slotStart, dayStart),
      lt(appointments.slotStart, dayEnd),
    ),
  });

  for (const appt of affected) {
    await cancelAppointmentAndNotify(
      c.env,
      db,
      appt.id,
      "doctor_on_leave",
      "leave_conflict",
      `Your doctor is unavailable on ${body.date} and your appointment has been cancelled. Please rebook for another date — we're sorry for the inconvenience.`,
    );
  }

  return c.json({ date: body.date, cancelledAppointments: affected.length }, 201);
});

export default admin;
