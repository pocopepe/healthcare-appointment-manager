import { Hono } from "hono";
import { sign } from "hono/jwt";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import { createDb } from "../db/client";
import { users } from "../db/schema";
import { hashPassword, verifyPassword } from "../lib/password";
import { authenticate } from "../middleware/auth";

const auth = new Hono<AppEnv>();

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function issueToken(
  c: { env: { JWT_SECRET: string } },
  user: { id: string; role: string },
) {
  return sign(
    {
      sub: user.id,
      role: user.role,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
    },
    c.env.JWT_SECRET,
  );
}

// Public self-registration is patient-only. Doctor and admin accounts are
// provisioned by an admin (see routes/admin.ts) so role escalation can't
// happen through this endpoint.
auth.post("/register", async (c) => {
  const body = await c.req.json<{
    email?: string;
    password?: string;
    name?: string;
    phone?: string;
  }>();

  const email = body.email?.trim().toLowerCase();
  const { password, name, phone } = body;

  if (!email || !password || !name) {
    return c.json({ error: "email, password, and name are required" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }

  const db = createDb(c.env.DB);
  const existing = await db.query.users.findFirst({
    where: eq(users.email, email),
  });
  if (existing) {
    return c.json({ error: "An account with this email already exists" }, 409);
  }

  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email,
    passwordHash,
    name,
    phone: phone ?? null,
    role: "patient",
  });

  const token = await issueToken(c, { id, role: "patient" });
  return c.json({ token, user: { id, email, name, role: "patient" } }, 201);
});

auth.post("/login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>();
  const email = body.email?.trim().toLowerCase();
  const { password } = body;

  if (!email || !password) {
    return c.json({ error: "email and password are required" }, 400);
  }

  const db = createDb(c.env.DB);
  const user = await db.query.users.findFirst({
    where: eq(users.email, email),
  });

  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const token = await issueToken(c, user);
  return c.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

auth.get("/me", authenticate, async (c) => {
  const db = createDb(c.env.DB);
  const user = await db.query.users.findFirst({
    where: eq(users.id, c.get("userId")),
  });
  if (!user) return c.json({ error: "User not found" }, 404);
  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    phone: user.phone,
  });
});

export default auth;
