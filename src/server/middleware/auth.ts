import { createMiddleware } from "hono/factory";
import { verify } from "hono/jwt";
import type { AppEnv, Variables } from "../env";

export const authenticate = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  try {
    const payload = await verify(token, c.env.JWT_SECRET, "HS256");
    c.set("userId", payload.sub as string);
    c.set("userRole", payload.role as Variables["userRole"]);
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  await next();
});

export function requireRole(...roles: Variables["userRole"][]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const role = c.get("userRole");
    if (!roles.includes(role)) {
      return c.json({ error: "Forbidden for this role" }, 403);
    }
    await next();
  });
}
