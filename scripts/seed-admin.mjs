#!/usr/bin/env node
// Bootstraps the very first admin account. Public /api/auth/register only
// ever creates patients (see src/server/routes/auth.ts), and admin routes
// require an existing admin — so the first admin has to be inserted
// directly. Run once per environment:
//   node scripts/seed-admin.mjs --local
//   node scripts/seed-admin.mjs --remote
//
// Reads ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME from the environment, or
// prompts on the CLI with sensible defaults for local dev.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const ITERATIONS = 100_000;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Mirrors src/server/lib/password.ts exactly so the resulting hash verifies
// correctly against the app's login endpoint.
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return `pbkdf2$${ITERATIONS}$${toHex(salt.buffer)}$${toHex(bits)}`;
}

const target = process.argv.includes("--remote") ? "--remote" : "--local";
const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? "changeme123";
const name = process.env.ADMIN_NAME ?? "Admin";

const passwordHash = await hashPassword(password);
const id = randomUUID();

const escape = (s) => s.replace(/'/g, "''");
const sql = `INSERT INTO users (id, email, password_hash, role, name) VALUES ('${id}', '${escape(email)}', '${passwordHash}', 'admin', '${escape(name)}');`;

execFileSync(
  "npx",
  ["wrangler", "d1", "execute", "healthcare-appointment-manager-db", target, "--command", sql],
  { stdio: "inherit" },
);

console.log(`\nAdmin account created: ${email} / ${password}`);
console.log("Change this password after first login — there's no self-service reset yet.");
