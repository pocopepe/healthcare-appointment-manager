import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
};

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["patient", "doctor", "admin"] }).notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    ...timestamps,
  },
  (table) => ({
    emailIdx: uniqueIndex("users_email_idx").on(table.email),
  }),
);

// One row per doctor, extending a `users` row with role = 'doctor'.
export const doctorProfiles = sqliteTable("doctor_profiles", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id)
    .unique(),
  specialisation: text("specialisation").notNull(),
  slotDurationMinutes: integer("slot_duration_minutes").notNull().default(30),
  bio: text("bio"),
  ...timestamps,
});

// Weekly recurring working hours, e.g. Monday 09:00-17:00. dayOfWeek: 0=Sunday..6=Saturday.
export const doctorAvailability = sqliteTable(
  "doctor_availability",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id")
      .notNull()
      .references(() => doctorProfiles.id),
    dayOfWeek: integer("day_of_week").notNull(),
    startTime: text("start_time").notNull(), // "09:00"
    endTime: text("end_time").notNull(), // "17:00"
  },
  (table) => ({
    doctorIdx: index("doctor_availability_doctor_idx").on(table.doctorId),
  }),
);

export const doctorLeaves = sqliteTable(
  "doctor_leaves",
  {
    id: text("id").primaryKey(),
    doctorId: text("doctor_id")
      .notNull()
      .references(() => doctorProfiles.id),
    date: text("date").notNull(), // "YYYY-MM-DD"
    reason: text("reason"),
    ...timestamps,
  },
  (table) => ({
    doctorDateIdx: uniqueIndex("doctor_leaves_doctor_date_idx").on(
      table.doctorId,
      table.date,
    ),
  }),
);

export const appointments = sqliteTable(
  "appointments",
  {
    id: text("id").primaryKey(),
    patientId: text("patient_id")
      .notNull()
      .references(() => users.id),
    doctorId: text("doctor_id")
      .notNull()
      .references(() => doctorProfiles.id),
    slotStart: text("slot_start").notNull(), // ISO 8601 UTC
    slotEnd: text("slot_end").notNull(),
    status: text("status", {
      enum: ["held", "confirmed", "cancelled", "completed"],
    })
      .notNull()
      .default("held"),
    // A held (not-yet-confirmed) slot expires if the patient never finishes booking.
    holdExpiresAt: text("hold_expires_at"),

    symptomsText: text("symptoms_text"),
    aiPreVisitSummary: text("ai_pre_visit_summary", { mode: "json" }).$type<{
      urgency: "Low" | "Medium" | "High";
      chiefComplaint: string;
      suggestedQuestions: string[];
    } | null>(),

    postVisitNotes: text("post_visit_notes"),
    prescription: text("prescription", { mode: "json" }).$type<
      Array<{
        medication: string;
        dosage: string;
        timesPerDay: number;
        durationDays: number;
      }>
    >(),
    aiPostVisitSummary: text("ai_post_visit_summary"),
    // Why an AI summary is missing, so the UI can explain itself instead of
    // showing an unexplained blank: "daily_limit", "not_configured", "error".
    aiStatus: text("ai_status"),

    cancelledReason: text("cancelled_reason"),
    // Set when the pre-appointment reminder has gone out, so the cron job
    // doesn't re-send it every 15 minutes. Cleared on reschedule so the
    // patient gets a fresh reminder for the new time.
    reminderSentAt: text("reminder_sent_at"),
    ...timestamps,
  },
  (table) => ({
    // A doctor can't hold/confirm two appointments for the same slot at once.
    // Cancelled appointments free the slot up again, so they're excluded.
    doctorSlotActiveIdx: uniqueIndex("appointments_doctor_slot_active_idx")
      .on(table.doctorId, table.slotStart)
      .where(sql`${table.status} != 'cancelled'`),
    patientIdx: index("appointments_patient_idx").on(table.patientId),
    doctorIdx: index("appointments_doctor_idx").on(table.doctorId),
  }),
);

export const medicationReminders = sqliteTable(
  "medication_reminders",
  {
    id: text("id").primaryKey(),
    appointmentId: text("appointment_id")
      .notNull()
      .references(() => appointments.id),
    medication: text("medication").notNull(),
    dosage: text("dosage").notNull(),
    timesPerDay: integer("times_per_day").notNull(),
    startDate: text("start_date").notNull(), // "YYYY-MM-DD"
    durationDays: integer("duration_days").notNull(),
    // Last calendar date this reminder was queued for, so the cron tick
    // (every 15 min) doesn't queue duplicate reminders for the same day.
    lastQueuedDate: text("last_queued_date"),
    ...timestamps,
  },
  (table) => ({
    appointmentIdx: index("medication_reminders_appointment_idx").on(
      table.appointmentId,
    ),
  }),
);

// Every outbound email and reminder goes through this outbox so delivery is
// retried on failure instead of being lost (see src/server/lib/email.ts).
export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    appointmentId: text("appointment_id").references(() => appointments.id),
    type: text("type", {
      enum: [
        "booking_confirmation",
        "appointment_reminder",
        "cancellation",
        "reschedule",
        "leave_conflict",
        "medication_reminder",
        "visit_summary",
      ],
    }).notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    status: text("status", {
      enum: ["pending", "sent", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    scheduledFor: text("scheduled_for")
      .notNull()
      .default(sql`(CURRENT_TIMESTAMP)`),
    sentAt: text("sent_at"),
    ...timestamps,
  },
  (table) => ({
    statusIdx: index("notification_outbox_status_idx").on(
      table.status,
      table.scheduledFor,
    ),
  }),
);

// One row per UTC day, counting LLM calls so the app can stop itself well
// before Cloudflare's free Workers AI allocation (10,000 Neurons/day) runs
// out. Without this the app would either start failing with raw errors on
// the free plan, or quietly accrue charges on the paid one.
export const llmUsage = sqliteTable("llm_usage", {
  date: text("date").primaryKey(), // "YYYY-MM-DD" (UTC)
  requests: integer("requests").notNull().default(0),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(CURRENT_TIMESTAMP)`),
});

export const calendarConnections = sqliteTable(
  "calendar_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id)
      .unique(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    expiresAt: text("expires_at").notNull(),
    ...timestamps,
  },
);

export const calendarEvents = sqliteTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    appointmentId: text("appointment_id")
      .notNull()
      .references(() => appointments.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    googleEventId: text("google_event_id").notNull(),
    ...timestamps,
  },
  (table) => ({
    appointmentUserIdx: uniqueIndex("calendar_events_appointment_user_idx").on(
      table.appointmentId,
      table.userId,
    ),
  }),
);
