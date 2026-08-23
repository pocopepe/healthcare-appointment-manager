import { eq, and, gte, lt, ne, sql } from "drizzle-orm";
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

// Minutes-from-midnight on `date` as a canonical UTC timestamp. Goes through
// Date so that a window ending at 24:00 normalises to 00:00 the next day
// instead of producing "...T24:00:00.000Z", which would break the string
// comparisons used for overlap detection.
function isoAtMinutes(date: string, total: number): string {
  return new Date(
    new Date(`${date}T00:00:00.000Z`).getTime() + total * 60_000,
  ).toISOString();
}

// day boundaries in UTC for a given "YYYY-MM-DD" calendar date
function dayBoundsUtc(date: string) {
  return {
    start: `${date}T00:00:00.000Z`,
    end: `${date}T23:59:59.999Z`,
  };
}

// The doctor's schedule for a date, independent of what's already booked:
// working-hours windows expanded onto the slot-duration grid, minus leave
// days and past times. Occupancy is layered on separately so callers can
// tell "this isn't a real slot" apart from "this slot is taken".
export async function getScheduleSlots(
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

  const slots: { start: string; end: string }[] = [];
  const duration = doctor.slotDurationMinutes;
  if (duration <= 0) return [];

  const now = new Date();
  for (const window of availability) {
    const startMin = timeToMinutes(window.startTime);
    const endMin = timeToMinutes(window.endTime);
    for (let m = startMin; m + duration <= endMin; m += duration) {
      const startIso = isoAtMinutes(date, m);
      const endIso = isoAtMinutes(date, m + duration);
      if (new Date(startIso) > now) {
        slots.push({ start: startIso, end: endIso });
      }
    }
  }

  return slots;
}

export async function getAvailableSlots(
  db: Db,
  doctorId: string,
  date: string,
): Promise<{ start: string; end: string }[]> {
  const slots = await getScheduleSlots(db, doctorId, date);
  if (slots.length === 0) return [];

  const { start: dayStart, end: dayEnd } = dayBoundsUtc(date);
  const taken = await db.query.appointments.findMany({
    where: and(
      eq(appointments.doctorId, doctorId),
      ne(appointments.status, "cancelled"),
      gte(appointments.slotStart, dayStart),
      lt(appointments.slotStart, dayEnd),
    ),
  });
  const active = taken.filter(
    (a) => a.status !== "held" || !isHoldExpired(a.holdExpiresAt),
  );

  // Compare by interval, not just start time: a booking made under a
  // previous slot duration can sit across a slot on the current grid.
  return slots.filter(
    (s) => !active.some((a) => a.slotStart < s.end && a.slotEnd > s.start),
  );
}

// The unique (doctor_id, slot_start) index only catches an *identical* start
// time. A request for an off-grid slot (09:15-09:45 against an existing
// 09:00-09:30) has a different start, so it would slip past the index and
// double-book the doctor. This catches any active appointment whose interval
// overlaps [slotStart, slotEnd) — half-open, so back-to-back slots that merely
// touch at the boundary are not treated as a conflict.
export async function findOverlappingAppointment(
  db: Db,
  doctorId: string,
  slotStart: string,
  slotEnd: string,
) {
  const active = await db.query.appointments.findMany({
    where: and(
      eq(appointments.doctorId, doctorId),
      ne(appointments.status, "cancelled"),
      sql`${appointments.slotStart} < ${slotEnd}`,
      sql`${appointments.slotEnd} > ${slotStart}`,
    ),
  });
  // An expired hold isn't a real conflict — it's about to be swept away.
  return active.find((a) => a.status !== "held" || !isHoldExpired(a.holdExpiresAt));
}

// Confirms the requested slot exists on the doctor's schedule: inside working
// hours, on the canonical slot grid, not a leave day, and in the future.
// Deliberately ignores whether it's already booked — that's a conflict (409),
// not a malformed request (400) — so callers can report the two distinctly.
export async function isSlotOnSchedule(
  db: Db,
  doctorId: string,
  slotStart: string,
  slotEnd: string,
): Promise<boolean> {
  const date = slotStart.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;

  const slots = await getScheduleSlots(db, doctorId, date);
  return slots.some((s) => s.start === slotStart && s.end === slotEnd);
}

export function isHoldExpired(holdExpiresAt: string | null): boolean {
  if (!holdExpiresAt) return true;
  return new Date(holdExpiresAt).getTime() < Date.now();
}

export function computeHoldExpiry(): string {
  return new Date(Date.now() + HOLD_DURATION_MS).toISOString();
}
