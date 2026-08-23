import { Hono } from "hono";
import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import { authenticate } from "../middleware/auth";
import { getAuthUrl, exchangeCodeForTokens, isCalendarConfigured } from "../lib/calendar";

const calendar = new Hono<AppEnv>();

calendar.get("/status", authenticate, async (c) => {
  return c.json({ configured: isCalendarConfigured(c.env) });
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
