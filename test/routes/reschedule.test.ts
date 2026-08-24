import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { api, db, testEnv } from "../helpers";
import { users, appointments, notificationOutbox } from "../../src/server/db/schema";
import { hashPassword } from "../../src/server/lib/password";
import { runScheduledTasks } from "../../src/server/lib/scheduler";

async function seedAdmin() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  await db.insert(users).values({
    id: crypto.randomUUID(),
    email,
    passwordHash: await hashPassword("admin-password"),
    role: "admin",
    name: "Admin",
  });
  const r = await api("/api/auth/login", {
    method: "POST",
    body: { email, password: "admin-password" },
  });
  return r.body.token as string;
}

async function registerPatient() {
  const r = await api("/api/auth/register", {
    method: "POST",
    body: {
      email: `p-${crypto.randomUUID()}@example.com`,
      password: "password123",
      name: "Test Patient",
    },
  });
  return r.body.token as string;
}

const DATE = "2099-06-15"; // Monday
const DOW = new Date(`${DATE}T00:00:00.000Z`).getUTCDay();

async function createDoctor(adminToken: string) {
  const r = await api("/api/admin/doctors", {
    method: "POST",
    token: adminToken,
    body: {
      email: `d-${crypto.randomUUID()}@example.com`,
      password: "password123",
      name: "Test Doc",
      specialisation: "General",
      slotDurationMinutes: 30,
      availability: [{ dayOfWeek: DOW, startTime: "09:00", endTime: "12:00" }],
    },
  });
  return r.body.id as string;
}

async function bookConfirmed(patientToken: string, doctorId: string, hour: string) {
  const hold = await api("/api/patient/appointments/hold", {
    method: "POST",
    token: patientToken,
    body: {
      doctorId,
      slotStart: `${DATE}T${hour}:00:00.000Z`,
      slotEnd: `${DATE}T${hour}:30:00.000Z`,
    },
  });
  expect(hold.status).toBe(201);
  await api(`/api/patient/appointments/${hold.body.id}/confirm`, {
    method: "POST",
    token: patientToken,
    body: { symptoms: "Test symptoms" },
  });
  return hold.body.id as string;
}

describe("reschedule", () => {
  let adminToken: string;
  beforeAll(async () => {
    adminToken = await seedAdmin();
  });

  it("moves a confirmed appointment to a new slot and notifies both sides", async () => {
    const doctorId = await createDoctor(adminToken);
    const patientToken = await registerPatient();
    const id = await bookConfirmed(patientToken, doctorId, "09");

    const res = await api(`/api/patient/appointments/${id}/reschedule`, {
      method: "POST",
      token: patientToken,
      body: { slotStart: `${DATE}T11:00:00.000Z`, slotEnd: `${DATE}T11:30:00.000Z` },
    });
    expect(res.status).toBe(200);
    expect(res.body.slotStart).toBe(`${DATE}T11:00:00.000Z`);

    const row = await db.query.appointments.findFirst({
      where: eq(appointments.id, id),
    });
    expect(row?.slotStart).toBe(`${DATE}T11:00:00.000Z`);
    expect(row?.status).toBe("confirmed");

    const notes = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, id));
    // Both the patient and the doctor must hear about the move.
    expect(notes.filter((n) => n.type === "reschedule")).toHaveLength(2);
  });

  it("frees the old slot so someone else can book it", async () => {
    const doctorId = await createDoctor(adminToken);
    const patientA = await registerPatient();
    const id = await bookConfirmed(patientA, doctorId, "09");

    await api(`/api/patient/appointments/${id}/reschedule`, {
      method: "POST",
      token: patientA,
      body: { slotStart: `${DATE}T10:00:00.000Z`, slotEnd: `${DATE}T10:30:00.000Z` },
    });

    const patientB = await registerPatient();
    const retake = await api("/api/patient/appointments/hold", {
      method: "POST",
      token: patientB,
      body: {
        doctorId,
        slotStart: `${DATE}T09:00:00.000Z`,
        slotEnd: `${DATE}T09:30:00.000Z`,
      },
    });
    expect(retake.status).toBe(201);
  });

  it("refuses to move onto a slot another patient already holds", async () => {
    const doctorId = await createDoctor(adminToken);
    const patientA = await registerPatient();
    const patientB = await registerPatient();
    const idA = await bookConfirmed(patientA, doctorId, "09");
    await bookConfirmed(patientB, doctorId, "10");

    const res = await api(`/api/patient/appointments/${idA}/reschedule`, {
      method: "POST",
      token: patientA,
      body: { slotStart: `${DATE}T10:00:00.000Z`, slotEnd: `${DATE}T10:30:00.000Z` },
    });
    expect(res.status).toBe(409);
  });

  it("refuses a slot that is not on the doctor's schedule", async () => {
    const doctorId = await createDoctor(adminToken);
    const patientToken = await registerPatient();
    const id = await bookConfirmed(patientToken, doctorId, "09");

    const res = await api(`/api/patient/appointments/${id}/reschedule`, {
      method: "POST",
      token: patientToken,
      body: { slotStart: `${DATE}T03:00:00.000Z`, slotEnd: `${DATE}T03:30:00.000Z` },
    });
    expect(res.status).toBe(400);
  });

  it("does not let another patient reschedule someone else's appointment", async () => {
    const doctorId = await createDoctor(adminToken);
    const owner = await registerPatient();
    const stranger = await registerPatient();
    const id = await bookConfirmed(owner, doctorId, "09");

    const res = await api(`/api/patient/appointments/${id}/reschedule`, {
      method: "POST",
      token: stranger,
      body: { slotStart: `${DATE}T11:00:00.000Z`, slotEnd: `${DATE}T11:30:00.000Z` },
    });
    expect(res.status).toBe(404);
  });
});

describe("appointment reminders", () => {
  it("reminds both sides once for an appointment inside the lead window", async () => {
    const adminToken = await seedAdmin();
    const doctorId = await createDoctor(adminToken);
    const patientToken = await registerPatient();
    const id = await bookConfirmed(patientToken, doctorId, "09");

    // Move it to just under 24h away so the reminder job picks it up.
    const soon = new Date(Date.now() + 6 * 3600_000).toISOString();
    await db
      .update(appointments)
      .set({ slotStart: soon, slotEnd: soon, reminderSentAt: null })
      .where(eq(appointments.id, id));

    await runScheduledTasks(testEnv, db);

    const after = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, id));
    const reminders = after.filter((n) => n.type === "appointment_reminder");
    expect(reminders).toHaveLength(2); // patient + doctor

    // Running again must not send duplicates.
    await runScheduledTasks(testEnv, db);
    const second = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, id));
    expect(second.filter((n) => n.type === "appointment_reminder")).toHaveLength(2);
  });

  it("does not remind about an appointment further out than the lead window", async () => {
    const adminToken = await seedAdmin();
    const doctorId = await createDoctor(adminToken);
    const patientToken = await registerPatient();
    const id = await bookConfirmed(patientToken, doctorId, "09");

    const farOff = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
    await db
      .update(appointments)
      .set({ slotStart: farOff, slotEnd: farOff, reminderSentAt: null })
      .where(eq(appointments.id, id));

    await runScheduledTasks(testEnv, db);

    const rows = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.appointmentId, id));
    expect(rows.filter((n) => n.type === "appointment_reminder")).toHaveLength(0);
  });
});
