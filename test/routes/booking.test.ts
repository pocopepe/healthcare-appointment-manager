import { describe, it, expect, beforeAll } from "vitest";
import { api, db } from "../helpers";
import { users } from "../../src/server/db/schema";
import { hashPassword } from "../../src/server/lib/password";

// Public registration only ever creates patients (see routes/auth.ts), so
// tests that need an admin insert one directly, the same way
// scripts/seed-admin.mjs bootstraps the real first admin.
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

const FUTURE_DATE = "2099-06-15"; // a Monday
const FUTURE_DOW = new Date(`${FUTURE_DATE}T00:00:00.000Z`).getUTCDay();

async function createDoctor(adminToken: string) {
  const res = await api("/api/admin/doctors", {
    method: "POST",
    token: adminToken,
    body: {
      email: `doctor-${crypto.randomUUID()}@example.com`,
      password: "password123",
      name: "Alice Test",
      specialisation: "Cardiology",
      slotDurationMinutes: 30,
      availability: [{ dayOfWeek: FUTURE_DOW, startTime: "09:00", endTime: "10:00" }],
    },
  });
  expect(res.status).toBe(201);
  return { doctorId: res.body.id as string, doctorEmail: res.body.email as string };
}

describe("booking flow", () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await seedAdmin();
  });

  it("prevents double-booking the same slot under a race", async () => {
    const { doctorId } = await createDoctor(adminToken);
    const patientAToken = await registerPatient();
    const patientBToken = await registerPatient();

    const slotStart = `${FUTURE_DATE}T09:00:00.000Z`;
    const slotEnd = `${FUTURE_DATE}T09:30:00.000Z`;

    const [holdA, holdB] = await Promise.all([
      api("/api/patient/appointments/hold", {
        method: "POST",
        token: patientAToken,
        body: { doctorId, slotStart, slotEnd },
      }),
      api("/api/patient/appointments/hold", {
        method: "POST",
        token: patientBToken,
        body: { doctorId, slotStart, slotEnd },
      }),
    ]);

    const statuses = [holdA.status, holdB.status].sort();
    // Exactly one of the two concurrent holds must win; the other must be
    // rejected by the unique (doctorId, slotStart) index, not silently
    // double-booked.
    expect(statuses).toEqual([201, 409]);
  });

  it("takes a full booking through hold -> confirm -> visit, and leaving the doctor on leave afterwards no longer touches it", async () => {
    const { doctorId, doctorEmail } = await createDoctor(adminToken);
    const patientToken = await registerPatient();

    const slotStart = `${FUTURE_DATE}T09:00:00.000Z`;
    const slotEnd = `${FUTURE_DATE}T09:30:00.000Z`;

    const hold = await api("/api/patient/appointments/hold", {
      method: "POST",
      token: patientToken,
      body: { doctorId, slotStart, slotEnd },
    });
    expect(hold.status).toBe(201);

    const confirm = await api(`/api/patient/appointments/${hold.body.id}/confirm`, {
      method: "POST",
      token: patientToken,
      body: { symptoms: "Chest tightness for two days" },
    });
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("confirmed");

    const doctorLogin = await api("/api/auth/login", {
      method: "POST",
      body: { email: doctorEmail, password: "password123" },
    });
    const doctorToken = doctorLogin.body.token as string;

    const visit = await api(`/api/doctor/appointments/${hold.body.id}/visit`, {
      method: "POST",
      token: doctorToken,
      body: {
        notes: "Likely benign, follow up in a week.",
        prescription: [{ medication: "Ibuprofen", dosage: "200mg", timesPerDay: 2, durationDays: 5 }],
      },
    });
    expect(visit.status).toBe(200);
    expect(visit.body.status).toBe("completed");

    // Regression test: marking the doctor on leave for this date must not
    // cancel a visit that already happened (see routes/admin.ts leave
    // handler — it must filter to held/confirmed, not merely non-cancelled).
    const leave = await api(`/api/admin/doctors/${doctorId}/leave`, {
      method: "POST",
      token: adminToken,
      body: { date: FUTURE_DATE, reason: "Conference" },
    });
    expect(leave.status).toBe(201);
    expect(leave.body.cancelledAppointments).toBe(0);

    const mine = await api("/api/patient/appointments/mine", { token: patientToken });
    const appt = mine.body.find((a: any) => a.id === hold.body.id);
    expect(appt.status).toBe("completed");
  });

  it("cancels held/confirmed appointments and notifies when a doctor is marked on leave", async () => {
    const laterDate = "2099-06-22"; // next Monday, same day-of-week
    const { doctorId } = await createDoctor(adminToken);
    // createDoctor only configures FUTURE_DATE's weekday availability, which
    // is the same weekday as laterDate, so slots exist there too.
    const patientToken = await registerPatient();

    const slotStart = `${laterDate}T09:00:00.000Z`;
    const slotEnd = `${laterDate}T09:30:00.000Z`;

    const hold = await api("/api/patient/appointments/hold", {
      method: "POST",
      token: patientToken,
      body: { doctorId, slotStart, slotEnd },
    });
    await api(`/api/patient/appointments/${hold.body.id}/confirm`, {
      method: "POST",
      token: patientToken,
      body: { symptoms: "Routine checkup" },
    });

    const leave = await api(`/api/admin/doctors/${doctorId}/leave`, {
      method: "POST",
      token: adminToken,
      body: { date: laterDate, reason: "Sick day" },
    });
    expect(leave.status).toBe(201);
    expect(leave.body.cancelledAppointments).toBe(1);

    const mine = await api("/api/patient/appointments/mine", { token: patientToken });
    const appt = mine.body.find((a: any) => a.id === hold.body.id);
    expect(appt.status).toBe("cancelled");
    expect(appt.cancelledReason).toBe("doctor_on_leave");
  });
});
