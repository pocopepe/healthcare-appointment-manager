import { eq, and, gte, lt, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  doctorAvailability,
  doctorLeaves,
  doctorProfiles,
  appointments,
} from "../db/schema";

const HOLD_DURATION_MS = 5 * 60 * 1000;

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// day boundaries in UTC for a given "YYYY-MM-DD" calendar date
function dayBoundsUtc(date: string) {
  return {
    start: `${date}T00:00:00.000Z`,
    end: `${date}T23:59:59.999Z`,
  };
}

export async function getAvailableSlots(
  db: Db,
  doctorId: string,
  date: string,
): Promise<{ start: string; end: string }[]> {
  const doctor = await db.query.doctorProfiles.findFirst({
    where: eq(doctorProfiles.id, doctorId),
  });
  if (!doctor) return [];

  const leave = await db.query.doctorLeaves.findFirst({
    where: and(eq(doctorLeaves.doctorId, doctorId), eq(doctorLeaves.date, date)),
  });
  if (leave) return [];

  const dayOfWeek = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  const availability = await db.query.doctorAvailability.findMany({
    where: and(
      eq(doctorAvailability.doctorId, doctorId),
      eq(doctorAvailability.dayOfWeek, dayOfWeek),
    ),
  });
  if (availability.length === 0) return [];

  const { start: dayStart, end: dayEnd } = dayBoundsUtc(date);
  const taken = await db.query.appointments.findMany({
    where: and(
      eq(appointments.doctorId, doctorId),
      ne(appointments.status, "cancelled"),
      gte(appointments.slotStart, dayStart),
      lt(appointments.slotStart, dayEnd),
    ),
  });
  const takenStarts = new Set(
    taken
      .filter((a) => a.status !== "held" || !isHoldExpired(a.holdExpiresAt))
      .map((a) => a.slotStart),
  );

  const slots: { start: string; end: string }[] = [];
  const duration = doctor.slotDurationMinutes;

  for (const window of availability) {
    const startMin = timeToMinutes(window.startTime);
    const endMin = timeToMinutes(window.endTime);
    for (let m = startMin; m + duration <= endMin; m += duration) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      const startIso = `${date}T${hh}:${mm}:00.000Z`;
      const endMinutes = m + duration;
      const eh = String(Math.floor(endMinutes / 60)).padStart(2, "0");
      const em = String(endMinutes % 60).padStart(2, "0");
      const endIso = `${date}T${eh}:${em}:00.000Z`;

      if (!takenStarts.has(startIso) && new Date(startIso) > new Date()) {
        slots.push({ start: startIso, end: endIso });
      }
    }
  }

  return slots;
}

export function isHoldExpired(holdExpiresAt: string | null): boolean {
  if (!holdExpiresAt) return true;
  return new Date(holdExpiresAt).getTime() < Date.now();
}

export function computeHoldExpiry(): string {
  return new Date(Date.now() + HOLD_DURATION_MS).toISOString();
}
