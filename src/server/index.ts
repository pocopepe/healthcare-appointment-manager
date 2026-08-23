import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { AppEnv, Bindings } from "./env";
import { createDb } from "./db/client";
import { runScheduledTasks } from "./lib/scheduler";

import auth from "./routes/auth";
import patient from "./routes/patient";
import doctor from "./routes/doctor";
import admin from "./routes/admin";
import calendar from "./routes/calendar";

const app = new Hono<AppEnv>();

app.use("*", logger());
app.use("/api/*", cors());

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", auth);
app.route("/api/patient", patient);
app.route("/api/doctor", doctor);
app.route("/api/admin", admin);
app.route("/api/calendar", calendar);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: Bindings, ctx: ExecutionContext) => {
    const db = createDb(env.DB);
    ctx.waitUntil(runScheduledTasks(env, db));
  },
} satisfies ExportedHandler<Bindings>;
