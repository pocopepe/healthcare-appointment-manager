import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, testEnv } from "../helpers";
import { users, notificationOutbox } from "../../src/server/db/schema";
import { queueEmail, processOutbox, isUndeliverableAddress } from "../../src/server/lib/email";

async function makeUser(email: string) {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email,
    passwordHash: "unused",
    role: "patient",
    name: "Test",
  });
  return id;
}

describe("undeliverable address detection", () => {
  it("flags reserved test/example domains", () => {
    for (const address of [
      "patient@demo.test",
      "someone@my.example",
      "a@b.invalid",
      "root@localhost",
      "hello@example.com",
    ]) {
      expect(isUndeliverableAddress(address), address).toBe(true);
    }
  });

  it("does not flag real addresses", () => {
    for (const address of [
      "someone@gmail.com",
      "dr.smith@clinic.co.uk",
      "a@example.company.com", // not the reserved example.com
    ]) {
      expect(isUndeliverableAddress(address), address).toBe(false);
    }
  });
});

describe("outbox delivery", () => {
  it("skips reserved addresses instead of bouncing them off the provider", async () => {
    const userId = await makeUser(`patient-${crypto.randomUUID()}@demo.test`);
    await queueEmail(db, {
      userId,
      type: "booking_confirmation",
      subject: "Test",
      body: "Test body",
    });

    await processOutbox(testEnv, db);

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, userId));
    // Skipped, not failed: nothing went wrong, we chose not to send.
    expect(row.status).toBe("skipped");
    expect(row.attempts).toBe(0);
  });

  it("marks a real address as sent when no provider is configured (stubbed)", async () => {
    const userId = await makeUser(`person-${crypto.randomUUID()}@realdomain.com`);
    await queueEmail(db, {
      userId,
      type: "booking_confirmation",
      subject: "Test",
      body: "Test body",
    });

    // The test env has no SENDGRID_API_KEY, so delivery is stubbed to a log.
    await processOutbox(testEnv, db);

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, userId));
    expect(row.status).toBe("sent");
  });

  it("does not deliver a notification before its scheduled time", async () => {
    const userId = await makeUser(`later-${crypto.randomUUID()}@realdomain.com`);
    await queueEmail(db, {
      userId,
      type: "medication_reminder",
      subject: "Later",
      body: "Not yet",
      scheduledFor: new Date(Date.now() + 3600_000),
    });

    await processOutbox(testEnv, db);

    const [row] = await db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, userId));
    expect(row.status).toBe("pending");
  });
});
