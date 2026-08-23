import { describe, it, expect } from "vitest";
import { api } from "../helpers";

function uniqueEmail() {
  return `patient-${crypto.randomUUID()}@example.com`;
}

describe("auth", () => {
  it("registers a patient and returns a usable token", async () => {
    const email = uniqueEmail();
    const res = await api("/api/auth/register", {
      method: "POST",
      body: { email, password: "password123", name: "Test Patient" },
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe("patient");

    const me = await api("/api/auth/me", { token: res.body.token });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it("rejects registering the same email twice", async () => {
    const email = uniqueEmail();
    const first = await api("/api/auth/register", {
      method: "POST",
      body: { email, password: "password123", name: "First" },
    });
    expect(first.status).toBe(201);

    const second = await api("/api/auth/register", {
      method: "POST",
      body: { email, password: "password123", name: "Second" },
    });
    expect(second.status).toBe(409);
  });

  it("rejects a password shorter than 8 characters", async () => {
    const res = await api("/api/auth/register", {
      method: "POST",
      body: { email: uniqueEmail(), password: "short", name: "Test" },
    });
    expect(res.status).toBe(400);
  });

  it("rejects login with the wrong password", async () => {
    const email = uniqueEmail();
    await api("/api/auth/register", {
      method: "POST",
      body: { email, password: "password123", name: "Test" },
    });

    const res = await api("/api/auth/login", {
      method: "POST",
      body: { email, password: "wrong-password" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated requests to protected routes", async () => {
    const res = await api("/api/auth/me");
    expect(res.status).toBe(401);
  });
});
