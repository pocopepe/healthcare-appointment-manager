import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import { calendarConnections, calendarEvents } from "../db/schema";
import { authenticate } from "../middleware/auth";
import { getAuthUrl, exchangeCodeForTokens, isCalendarConfigured } from "../lib/calendar";

const calendar = new Hono<AppEnv>();

// `configured` is about the deployment (are Google credentials present),
// `connected` is about this particular user (have they granted access).
calendar.get("/status", authenticate, async (c) => {
  const db = createDb(c.env.DB);
  const connection = await db.query.calendarConnections.findFirst({
    where: eq(calendarConnections.userId, c.get("userId")),
  });
  return c.json({
    configured: isCalendarConfigured(c.env),
    connected: Boolean(connection),
  });
});

calendar.delete("/connection", authenticate, async (c) => {
  const db = createDb(c.env.DB);
  const userId = c.get("userId");
  // Drop the event mappings too: without the token they can't be updated or
  // deleted in Google any more, so keeping them would strand stale rows.
  await db.delete(calendarEvents).where(eq(calendarEvents.userId, userId));
  await db.delete(calendarConnections).where(eq(calendarConnections.userId, userId));
  return c.json({ connected: false });
});

// Returns the Google consent URL for the logged-in user. The frontend
// redirects the browser to it; state carries the user id across the
// redirect since Google's callback can't include our Authorization header.
// (For production hardening this state should be signed/short-lived to
// prevent tampering — noted in the README as a known simplification.)
calendar.get("/oauth/start", authenticate, async (c) => {
  const url = getAuthUrl(c.env, c.get("userId"));
  if (!url) return c.json({ error: "Google Calendar is not configured" }, 501);
  return c.json({ url });
});

calendar.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state) {
    return c.text("Missing code or state", 400);
  }

  const db = createDb(c.env.DB);
  const ok = await exchangeCodeForTokens(c.env, db, state, code);

  const redirectTo = ok
    ? `${c.env.APP_BASE_URL}/settings?calendar=connected`
    : `${c.env.APP_BASE_URL}/settings?calendar=error`;
  return c.redirect(redirectTo, 302);
});

export default calendar;
