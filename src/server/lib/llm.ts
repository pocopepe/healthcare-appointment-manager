// LLM integration for pre-visit and post-visit summaries.
//
// Default provider is Cloudflare Workers AI, which needs no API key — just
// the `AI` binding — and comes with a free daily allocation. Anthropic and
// OpenAI are supported too, over plain fetch so neither SDK is a dependency.
//
// Two safety properties matter here:
//
//  1. Cost. Workers AI includes 10,000 Neurons/day free. On the free plan
//     requests simply fail past that; on the paid plan they bill. Either way
//     it's unpleasant, so the app counts its own calls in `llm_usage` and
//     stops at a self-imposed daily cap well below the allocation.
//  2. Availability. Every failure — no key, cap reached, non-2xx, network
//     error, unparseable output — resolves to a typed "unavailable" result
//     rather than throwing, so booking and visit completion never break.

import { sql } from "drizzle-orm";
import type { Bindings } from "../env";
import type { Db } from "../db/client";
import { llmUsage } from "../db/schema";

export type PreVisitSummary = {
  urgency: "Low" | "Medium" | "High";
  chiefComplaint: string;
  suggestedQuestions: string[];
};

export type UnavailableReason = "not_configured" | "daily_limit" | "error";

export type LlmResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: UnavailableReason };

// Each summary costs roughly 15-25 Neurons, so even a few hundred calls a day
// sit comfortably inside the 10,000 free allocation. Override with the
// LLM_DAILY_LIMIT var if you want to run closer to (or further from) the line.
const DEFAULT_DAILY_LIMIT = 200;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Unset falls back to the default; an explicit 0 is a kill switch that
// disables LLM calls entirely (used by the test suite so running tests can
// never spend real Neurons, and available in production without a redeploy).
function dailyLimit(env: Bindings): number {
  if (env.LLM_DAILY_LIMIT === undefined || env.LLM_DAILY_LIMIT === "") {
    return DEFAULT_DAILY_LIMIT;
  }
  const raw = Number(env.LLM_DAILY_LIMIT);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DAILY_LIMIT;
}

export async function getUsageToday(db: Db): Promise<number> {
  const row = await db.query.llmUsage.findFirst({
    where: (u, { eq }) => eq(u.date, todayUtc()),
  });
  return row?.requests ?? 0;
}

// Atomic increment: two concurrent requests can't clobber each other's count
// the way a read-then-write would.
async function recordUsage(db: Db): Promise<void> {
  await db
    .insert(llmUsage)
    .values({ date: todayUtc(), requests: 1 })
    .onConflictDoUpdate({
      target: llmUsage.date,
      set: { requests: sql`${llmUsage.requests} + 1` },
    });
}

async function callLLM(
  env: Bindings,
  db: Db,
  prompt: string,
): Promise<LlmResult<string>> {
  const provider = env.LLM_PROVIDER ?? "workers-ai";

  // Check the self-imposed budget before spending anything. The read is
  // slightly racy under concurrency, but the cap sits far enough below the
  // real allocation that a couple of extra calls can't matter.
  const limit = dailyLimit(env);
  if ((await getUsageToday(db)) >= limit) {
    console.warn(`[llm] daily cap of ${limit} requests reached; skipping call`);
    return { ok: false, reason: "daily_limit" };
  }

  try {
    let text: string | null = null;

    if (provider === "workers-ai") {
      if (!env.AI) return { ok: false, reason: "not_configured" };
      await recordUsage(db);
      const res = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 1024,
      })) as { response?: string };
      text = res.response ?? null;
    } else if (provider === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: "not_configured" };
      await recordUsage(db);
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-3-5-haiku-20241022",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        console.error("Anthropic API error", res.status, await res.text());
        return { ok: false, reason: "error" };
      }
      const data = (await res.json()) as { content: { type: string; text?: string }[] };
      text = data.content.find((b) => b.type === "text")?.text ?? null;
    } else if (provider === "openai") {
      if (!env.OPENAI_API_KEY) return { ok: false, reason: "not_configured" };
      await recordUsage(db);
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) {
        console.error("OpenAI API error", res.status, await res.text());
        return { ok: false, reason: "error" };
      }
      const data = (await res.json()) as { choices: { message: { content: string } }[] };
      text = data.choices[0]?.message?.content ?? null;
    } else {
      return { ok: false, reason: "not_configured" };
    }

    if (!text) return { ok: false, reason: "error" };
    return { ok: true, value: text };
  } catch (err) {
    // Network failure, timeout, model overloaded, neuron allocation exhausted
    // upstream — never let any of it break booking or the visit workflow.
    console.error("LLM call failed", err);
    return { ok: false, reason: "error" };
  }
}

function extractJson<T>(raw: string): T | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
}

export function explainUnavailable(reason: UnavailableReason): string {
  switch (reason) {
    case "daily_limit":
      return "The AI summary was not generated: today's automated summary limit has been reached. It will be available again after midnight UTC.";
    case "not_configured":
      return "The AI summary was not generated because no language model is configured for this environment.";
    default:
      return "The AI summary could not be generated. Your doctor's own notes are attached to this record.";
  }
}

export async function generatePreVisitSummary(
  env: Bindings,
  db: Db,
  symptoms: string,
): Promise<LlmResult<PreVisitSummary>> {
  const prompt = `Analyse these symptoms and return ONLY a JSON object with keys "urgency" (one of "Low", "Medium", "High"), "chiefComplaint" (short string), and "suggestedQuestions" (an array of exactly three strings, questions the doctor should ask). Do not include any text outside the JSON object.

Symptoms: ${symptoms}`;

  const raw = await callLLM(env, db, prompt);
  if (!raw.ok) return raw;

  const parsed = extractJson<PreVisitSummary>(raw.value);
  if (
    !parsed ||
    !["Low", "Medium", "High"].includes(parsed.urgency) ||
    typeof parsed.chiefComplaint !== "string" ||
    !Array.isArray(parsed.suggestedQuestions)
  ) {
    console.error("LLM returned unparseable pre-visit summary", raw.value);
    return { ok: false, reason: "error" };
  }
  return { ok: true, value: parsed };
}

export type PrescriptionItem = {
  medication: string;
  dosage: string;
  timesPerDay: number;
  durationDays: number;
};

// The prescription is passed in as structured data and spelled out verbatim
// in the prompt rather than left for the model to infer from shorthand in
// the notes. Asked to expand "Rx ibuprofen 400mg TDS 5/7" on its own, a small
// model will confidently produce a different dose and schedule — which is the
// one kind of error this feature must not make. The model is told to restate
// the schedule exactly and not to add advice of its own.
export async function generatePostVisitSummary(
  env: Bindings,
  db: Db,
  clinicalNotes: string,
  prescription: PrescriptionItem[] = [],
): Promise<LlmResult<string>> {
  const schedule = prescription.length
    ? prescription
        .map(
          (p) =>
            `- ${p.medication} ${p.dosage}, ${p.timesPerDay} time(s) per day, for ${p.durationDays} day(s) in a row`,
        )
        .join("\n")
    : "- No medication was prescribed.";

  const prompt = `Convert these clinical notes into a patient-friendly summary with a medication schedule and follow-up steps. Write in plain, reassuring language a patient with no medical background can follow.

Rules you must follow exactly:
- Reproduce the medication schedule below word for word in meaning. Do not change any dose, frequency, or number of days.
- Do not invent medicines, doses, schedules, tests, or advice that are not stated below.
- Do not describe the course in weeks or weekdays. It runs for a number of consecutive days.
- If something is unclear, tell the patient to ask their doctor rather than guessing.

Medication schedule (authoritative):
${schedule}

Clinical notes: ${clinicalNotes}`;

  return callLLM(env, db, prompt);
}
