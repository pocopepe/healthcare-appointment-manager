#!/usr/bin/env node
// Populates an environment with demo doctors and a demo patient so the app
// can be explored without clicking through admin setup first. Goes through
// the real HTTP API (not raw SQL) so it exercises the same validation and
// password hashing as a normal user would.
//
//   BASE_URL=https://your-worker.workers.dev \
//   ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=... \
//   node scripts/seed-demo.mjs
//
// Safe to re-run: accounts that already exist are skipped.

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("Set ADMIN_EMAIL and ADMIN_PASSWORD (the account from seed-admin.mjs).");
  process.exit(1);
}

const DEMO_PATIENT = {
  email: "patient@demo.test",
  password: "demopatient123",
  name: "Riya Patient",
};

// Every day of the week, so slots show up whenever someone looks.
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];

const DOCTORS = [
  {
    email: "cardio@demo.test",
    password: "demodoctor123",
    name: "Anita Rao",
    specialisation: "Cardiology",
    slotDurationMinutes: 30,
    bio: "Consultant cardiologist. Interested in preventative care and arrhythmia.",
    hours: { startTime: "09:00", endTime: "17:00" },
  },
  {
    email: "derma@demo.test",
    password: "demodoctor123",
    name: "Sam Verma",
    specialisation: "Dermatology",
    slotDurationMinutes: 20,
    bio: "Dermatologist covering general skin, allergy and follow-up care.",
    hours: { startTime: "10:00", endTime: "18:00" },
  },
  {
    email: "gp@demo.test",
    password: "demodoctor123",
    name: "Priya Nair",
    specialisation: "General Medicine",
    slotDurationMinutes: 15,
    bio: "General physician handling everyday complaints and referrals.",
    hours: { startTime: "08:00", endTime: "20:00" },
  },
];

async function call(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

const login = await call("/auth/login", {
  method: "POST",
  body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
});
if (login.status !== 200) {
  console.error("Admin login failed:", login.status, login.body);
  process.exit(1);
}
const adminToken = login.body.token;
console.log(`Signed in as admin on ${BASE_URL}\n`);

for (const doc of DOCTORS) {
  const res = await call("/admin/doctors", {
    method: "POST",
    token: adminToken,
    body: {
      email: doc.email,
      password: doc.password,
      name: doc.name,
      specialisation: doc.specialisation,
      slotDurationMinutes: doc.slotDurationMinutes,
      bio: doc.bio,
      availability: ALL_WEEK.map((dayOfWeek) => ({ dayOfWeek, ...doc.hours })),
    },
  });
  if (res.status === 201) {
    console.log(`  created doctor  ${doc.email.padEnd(20)} ${doc.specialisation}`);
  } else if (res.status === 409) {
    console.log(`  already exists  ${doc.email}`);
  } else {
    console.log(`  FAILED          ${doc.email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
}

const patient = await call("/auth/register", {
  method: "POST",
  body: DEMO_PATIENT,
});
if (patient.status === 201) {
  console.log(`  created patient ${DEMO_PATIENT.email}`);
} else if (patient.status === 409) {
  console.log(`  already exists  ${DEMO_PATIENT.email}`);
} else {
  console.log(`  FAILED          ${DEMO_PATIENT.email}: ${patient.status}`);
}

console.log(`
Demo accounts
  patient   ${DEMO_PATIENT.email} / ${DEMO_PATIENT.password}
  doctor    cardio@demo.test / demodoctor123   (also derma@ and gp@)
  admin     ${ADMIN_EMAIL} / (the password you set)

Doctors work every day, so slots appear for any future date you pick.`);
