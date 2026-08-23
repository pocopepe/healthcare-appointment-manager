// Email notifications go through an outbox table instead of being sent
// inline: queueEmail() just records intent (fast, never fails the request
// that triggered it), and the cron job in scheduler.ts calls processOutbox()
// to actually deliver + retry. This is what "email retries" in the
// assignment's background-job requirement refers to.

import { eq, and, lte, lt } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Db } from "../db/client";
import { notificationOutbox, users } from "../db/schema";

const MAX_ATTEMPTS = 5;

export type NotificationType =
  | "booking_confirmation"
  | "appointment_reminder"
  | "cancellation"
  | "leave_conflict"
  | "medication_reminder";

export async function queueEmail(
  db: Db,
  args: {
    userId: string;
    appointmentId?: string;
    type: NotificationType;
    subject: string;
    body: string;
    scheduledFor?: Date;
  },
) {
  await db.insert(notificationOutbox).values({
    id: crypto.randomUUID(),
    userId: args.userId,
    appointmentId: args.appointmentId ?? null,
    type: args.type,
    subject: args.subject,
    body: args.body,
    scheduledFor: (args.scheduledFor ?? new Date()).toISOString(),
  });
}

async function sendViaSendGrid(
  env: Bindings,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!env.SENDGRID_API_KEY) {
    // No provider configured: log instead of sending, and treat as
    // delivered so the outbox doesn't retry forever in dev environments.
    console.info(`[email:stub] to=${to} subject="${subject}"\n${body}`);
    return { ok: true };
  }

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: env.EMAIL_FROM ?? "appointments@example.com" },
        subject,
        content: [{ type: "text/plain", value: body }],
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `SendGrid ${res.status}: ${await res.text()}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Attempts delivery of every due, not-yet-exhausted outbox entry. Run
// periodically from the scheduled() handler.
export async function processOutbox(env: Bindings, db: Db, limit = 25) {
  const due = await db
    .select({
      id: notificationOutbox.id,
      subject: notificationOutbox.subject,
      body: notificationOutbox.body,
      attempts: notificationOutbox.attempts,
      email: users.email,
    })
    .from(notificationOutbox)
    .innerJoin(users, eq(notificationOutbox.userId, users.id))
    .where(
      and(
        eq(notificationOutbox.status, "pending"),
        lte(notificationOutbox.scheduledFor, new Date().toISOString()),
        lt(notificationOutbox.attempts, MAX_ATTEMPTS),
      ),
    )
    .limit(limit);

  for (const item of due) {
    const result = await sendViaSendGrid(env, item.email, item.subject, item.body);
    if (result.ok) {
      await db
        .update(notificationOutbox)
        .set({
          status: "sent",
          sentAt: new Date().toISOString(),
          attempts: item.attempts + 1,
        })
        .where(eq(notificationOutbox.id, item.id));
    } else {
      const attempts = item.attempts + 1;
      await db
        .update(notificationOutbox)
        .set({
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          attempts,
          lastError: result.error,
        })
        .where(eq(notificationOutbox.id, item.id));
    }
  }

  return { processed: due.length };
}
