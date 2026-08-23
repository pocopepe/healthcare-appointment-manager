import { describe, it, expect } from "vitest";
import { db } from "../helpers";
import { doctorProfiles, doctorAvailability, doctorLeaves, users, appointments } from "../../src/server/db/schema";
import { getAvailableSlots } from "../../src/server/lib/slots";

// A fixed date far enough in the future that "slot must be in the future"
// filtering never makes the test flaky.
const FUTURE_DATE = "2099-06-15"; // a Monday
const FUTURE_DOW = new Date(`${FUTURE_DATE}T00:00:00.000Z`).getUTCDay();

async function makeDoctor(slotDurationMinutes = 30) {
  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `doc-${userId}@example.com`,
    passwordHash: "unused",
    role: "doctor",
    name: "Dr. Test",
  });
  const doctorId = crypto.randomUUID();
  await db.insert(doctorProfiles).values({
    id: doctorId,
    userId,
    specialisation: "General",
    slotDurationMinutes,
  });
  return doctorId;
}

describe("getAvailableSlots", () => {
  it("returns evenly spaced slots within working hours", async () => {
    const doctorId = await makeDoctor(30);
    await db.insert(doctorAvailability).values({
      id: crypto.randomUUID(),
      doctorId,
      dayOfWeek: FUTURE_DOW,
      startTime: "09:00",
      endTime: "10:00",
    });

    const slots = await getAvailableSlots(db, doctorId, FUTURE_DATE);

    expect(slots).toEqual([
      { start: `${FUTURE_DATE}T09:00:00.000Z`, end: `${FUTURE_DATE}T09:30:00.000Z` },
      { start: `${FUTURE_DATE}T09:30:00.000Z`, end: `${FUTURE_DATE}T10:00:00.000Z` },
    ]);
  });

  it("returns nothing on a day with no configured availability", async () => {
    const doctorId = await makeDoctor();
    const slots = await getAvailableSlots(db, doctorId, FUTURE_DATE);
    expect(slots).toEqual([]);
  });

  it("returns nothing when the doctor is on leave that day", async () => {
    const doctorId = await makeDoctor();
    await db.insert(doctorAvailability).values({
      id: crypto.randomUUID(),
      doctorId,
      dayOfWeek: FUTURE_DOW,
      startTime: "09:00",
      endTime: "17:00",
    });
    await db.insert(doctorLeaves).values({
      id: crypto.randomUUID(),
      doctorId,
      date: FUTURE_DATE,
    });

    const slots = await getAvailableSlots(db, doctorId, FUTURE_DATE);
    expect(slots).toEqual([]);
  });

  it("excludes a slot already held or confirmed by another patient", async () => {
    const doctorId = await makeDoctor(30);
    await db.insert(doctorAvailability).values({
      id: crypto.randomUUID(),
      doctorId,
      dayOfWeek: FUTURE_DOW,
      startTime: "09:00",
      endTime: "10:00",
    });

    const patientId = crypto.randomUUID();
    await db.insert(users).values({
      id: patientId,
      email: `patient-${patientId}@example.com`,
      passwordHash: "unused",
      role: "patient",
      name: "Test Patient",
    });
    await db.insert(appointments).values({
      id: crypto.randomUUID(),
      patientId,
      doctorId,
      slotStart: `${FUTURE_DATE}T09:00:00.000Z`,
      slotEnd: `${FUTURE_DATE}T09:30:00.000Z`,
      status: "confirmed",
    });

    const slots = await getAvailableSlots(db, doctorId, FUTURE_DATE);
    expect(slots).toEqual([{ start: `${FUTURE_DATE}T09:30:00.000Z`, end: `${FUTURE_DATE}T10:00:00.000Z` }]);
  });
});
