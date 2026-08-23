import { describe, it, expect, beforeAll } from "vitest";
import { api, db } from "../helpers";
import { users } from "../../src/server/db/schema";
import { hashPassword } from "../../src/server/lib/password";

// The hold endpoint takes slotStart/slotEnd straight from the client. These
// tests pin down that it validates them against what the doctor actually
// offers — an earlier version trusted the client outright, which allowed
// booking outside working hours, on leave days, in the past, and (worst)
// overlapping an existing appointment by using an off-grid start time.

async function seedAdmin() {
  const email = `admin-${crypto.randomUUID()}@example.com`;
  const password = "admin-password";
  await db.insert(users).values({
    id: crypto.randomUUID(),
    email,
    passwordHash: await hashPassword(password),
    role: "admin",
    name: "Test Admin",
  });
  const login = await api("/api/auth/login", { method: "POST", body: { email, password } });
  return login.body.token as string;
}

async function registerPatient() {
  const res = await api("/api/auth/register", {
    method: "POST",
    body: {
      email: `patient-${crypto.randomUUID()}@example.com`,
      password: "password123",
      name: "Test Patient",
    },
  });
  return res.body.token as string;
}

const DATE = "2099-06-15"; // a Monday
const DOW = new Date(`${DATE}T00:00:00.000Z`).getUTCDay();

async function createDoctor(adminToken: string, slotDurationMinutes = 30) {
  const res = await api("/api/admin/doctors", {
    method: "POST",
    token: adminToken,
    body: {
      email: `doctor-${crypto.randomUUID()}@example.com`,
      password: "password123",
      name: "Slot Test Doc",
      specialisation: "General",
      slotDurationMinutes,
      availability: [{ dayOfWeek: DOW, startTime: "09:00", endTime: "10:00" }],
    },
  });
  return res.body.id as string;
}

function hold(token: string, doctorId: string, slotStart: string, slotEnd: string) {
  return api("/api/patient/appointments/hold", {
    method: "POST",
    token,
    body: { doctorId, slotStart, slotEnd },
  });
}

describe("hold slot validation", () => {
  let adminToken: string;
  beforeAll(async () => {
    adminToken = await seedAdmin();
  });

  it("accepts a slot the doctor actually offers", async () => {
    const doctorId = await createDoctor(adminToken);
    const res = await hold(
      await registerPatient(),
      doctorId,
      `${DATE}T09:00:00.000Z`,
      `${DATE}T09:30:00.000Z`,
    );
    expect(res.status).toBe(201);
  });

  it("rejects a slot outside the doctor's working hours", async () => {
    const doctorId = await createDoctor(adminToken);
    const res = await hold(
      await registerPatient(),
      doctorId,
      `${DATE}T03:00:00.000Z`,
      `${DATE}T03:30:00.000Z`,
    );
    expect(res.status).toBe(400);
  });

  it("rejects a slot in the past", async () => {
    const doctorId = await createDoctor(adminToken);
    const res = await hold(
      await registerPatient(),
      doctorId,
      "2020-01-06T09:00:00.000Z",
      "2020-01-06T09:30:00.000Z",
    );
    expect(res.status).toBe(400);
  });

  it("rejects a booking on a day the doctor is on leave", async () => {
    const doctorId = await createDoctor(adminToken);
    await api(`/api/admin/doctors/${doctorId}/leave`, {
      method: "POST",
      token: adminToken,
      body: { date: DATE, reason: "Away" },
    });
    const res = await hold(
      await registerPatient(),
      doctorId,
      `${DATE}T09:00:00.000Z`,
      `${DATE}T09:30:00.000Z`,
    );
    expect(res.status).toBe(400);
  });

  it("rejects an off-grid start time that would overlap a booked slot", async () => {
    const doctorId = await createDoctor(adminToken);
    const first = await hold(
      await registerPatient(),
      doctorId,
      `${DATE}T09:00:00.000Z`,
      `${DATE}T09:30:00.000Z`,
    );
    expect(first.status).toBe(201);

    // 09:15-09:45 has a different slot_start, so the unique index would let
    // it through — it must be rejected as not-an-offered-slot instead.
    const overlapping = await hold(
      await registerPatient(),
      doctorId,
      `${DATE}T09:15:00.000Z`,
      `${DATE}T09:45:00.000Z`,
    );
    expect(overlapping.status).toBe(400);
  });

  it("rejects an on-grid slot that overlaps a booking made under the old slot duration", async () => {
    // This is the case the grid check alone cannot catch: the appointment is
    // booked on the 30-minute grid, then the admin widens the doctor's slots
    // to 60 minutes. 09:00-10:00 is legitimately on the *new* grid and has a
    // start time no existing row uses, so only an interval-overlap check
    // stops it from double-booking the 09:30 appointment.
    const doctorId = await createDoctor(adminToken, 30);
    const booked = await hold(
      await registerPatient(),
      doctorId,
      `${DATE}T09:30:00.000Z`,
      `${DATE}T10:00:00.000Z`,
    );
    expect(booked.status).toBe(201);

    await api(`/api/admin/doctors/${doctorId}`, {
      method: "PATCH",
      token: adminToken,
      body: { slotDurationMinutes: 60 },
    });

    const overlapping = await hold(
      await registerPatient(),
      doctorId,
      `${DATE}T09:00:00.000Z`,
      `${DATE}T10:00:00.000Z`,
    );
    expect(overlapping.status).toBe(409);
  });
});
