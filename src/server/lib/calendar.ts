// Google Calendar sync via OAuth 2.0. Implemented against the plain HTTP
// APIs (fetch) rather than googleapis, since that package is large and this
// only needs three endpoints.
//
// Every function here degrades gracefully: if Google credentials aren't
// configured, or a given user never connected their calendar, calls are a
// no-op and return null. Calendar sync is a nice-to-have on top of a
// booking — it should never be able to break booking itself.

import { eq, and } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Db } from "../db/client";
import { calendarConnections, calendarEvents } from "../db/schema";

const SCOPE = "https://www.googleapis.com/auth/calendar.events";

export function isCalendarConfigured(env: Bindings): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function getAuthUrl(env: Bindings, state: string): string | null {
  if (!isCalendarConfigured(env)) return null;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: env.GOOGLE_REDIRECT_URI!,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: SCOPE,
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(
  env: Bindings,
  db: Db,
  userId: string,
  code: string,
): Promise<boolean> {
  if (!isCalendarConfigured(env)) return false;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: env.GOOGLE_REDIRECT_URI!,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    console.error("Google token exchange failed", await res.text());
    return false;
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  const existing = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.userId, userId),
  });
  if (existing) {
    await db
      .update(calendarConnections)
      .set({
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? existing.refreshToken,
        expiresAt,
      })
      .where(eq(calendarConnections.userId, userId));
  } else {
    await db.insert(calendarConnections).values({
      id: crypto.randomUUID(),
      userId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    });
  }
  return true;
}

async function getValidAccessToken(
  env: Bindings,
  db: Db,
  userId: string,
): Promise<string | null> {
  if (!isCalendarConfigured(env)) return null;

  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.userId, userId),
  });
  if (!connection) return null;

  if (new Date(connection.expiresAt).getTime() > Date.now() + 60_000) {
    return connection.accessToken;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: connection.refreshToken,
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    console.error("Google token refresh failed", await res.text());
    return null;
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await db
    .update(calendarConnections)
    .set({ accessToken: data.access_token, expiresAt })
    .where(eq(calendarConnections.userId, userId));

  return data.access_token;
}

type EventDetails = {
  summary: string;
  description: string;
  startIso: string;
  endIso: string;
};

export async function upsertCalendarEvent(
  env: Bindings,
  db: Db,
  userId: string,
  appointmentId: string,
  details: EventDetails,
): Promise<void> {
  const accessToken = await getValidAccessToken(env, db, userId);
  if (!accessToken) return; // user hasn't connected calendar; skip silently

  const existing = await db.query.calendarEvents.findFirst({
    where: and(
      eq(calendarEvents.appointmentId, appointmentId),
      eq(calendarEvents.userId, userId),
    ),
  });

  const eventBody = {
    summary: details.summary,
    description: details.description,
    start: { dateTime: details.startIso },
    end: { dateTime: details.endIso },
  };

  try {
    if (existing) {
      await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${existing.googleEventId}`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(eventBody),
        },
      );
      return;
    }

    const res = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(eventBody),
      },
    );
    if (!res.ok) {
      console.error("Google Calendar event create failed", await res.text());
      return;
    }
    const created = (await res.json()) as { id: string };
    await db.insert(calendarEvents).values({
      id: crypto.randomUUID(),
      appointmentId,
      userId,
      googleEventId: created.id,
    });
  } catch (err) {
    console.error("Calendar sync failed", err);
  }
}

export async function deleteCalendarEvent(
  env: Bindings,
  db: Db,
  userId: string,
  appointmentId: string,
): Promise<void> {
  const accessToken = await getValidAccessToken(env, db, userId);
  if (!accessToken) return;

  const existing = await db.query.calendarEvents.findFirst({
    where: and(
      eq(calendarEvents.appointmentId, appointmentId),
      eq(calendarEvents.userId, userId),
    ),
  });
  if (!existing) return;

  try {
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${existing.googleEventId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } },
    );
  } catch (err) {
    console.error("Calendar event delete failed", err);
  } finally {
    await db.delete(calendarEvents).where(eq(calendarEvents.id, existing.id));
  }
}
