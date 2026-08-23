// LLM integration for pre-visit and post-visit summaries. Talks to the
// provider's HTTP API directly (fetch) so no SDK dependency is needed, and
// the provider is chosen at runtime via LLM_PROVIDER so it's easy to swap.
//
// If no API key is configured, every call returns `null` instead of
// throwing — callers persist that as "summary not available yet" so a
// flaky or unconfigured LLM never blocks booking or the visit workflow.

import type { Bindings } from "../env";

export type PreVisitSummary = {
  urgency: "Low" | "Medium" | "High";
  chiefComplaint: string;
  suggestedQuestions: string[];
};

async function callLLM(env: Bindings, prompt: string): Promise<string | null> {
  const provider = env.LLM_PROVIDER ?? "anthropic";

  try {
    if (provider === "anthropic") {
      if (!env.ANTHROPIC_API_KEY) return null;
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
        return null;
      }
      const data = (await res.json()) as {
        content: { type: string; text?: string }[];
      };
      return data.content.find((b) => b.type === "text")?.text ?? null;
    }

    if (provider === "openai") {
      if (!env.OPENAI_API_KEY) return null;
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
        return null;
      }
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      return data.choices[0]?.message?.content ?? null;
    }

    return null;
  } catch (err) {
    // Network failure, timeout, etc. Never let an LLM outage break booking
    // or the visit workflow — the caller falls back to "unavailable".
    console.error("LLM call failed", err);
    return null;
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

export async function generatePreVisitSummary(
  env: Bindings,
  symptoms: string,
): Promise<PreVisitSummary | null> {
  const prompt = `Analyse these symptoms and return ONLY a JSON object with keys "urgency" (one of "Low", "Medium", "High"), "chiefComplaint" (short string), and "suggestedQuestions" (an array of exactly three strings, questions the doctor should ask). Do not include any text outside the JSON object.

Symptoms: ${symptoms}`;

  const raw = await callLLM(env, prompt);
  if (!raw) return null;

  const parsed = extractJson<PreVisitSummary>(raw);
  if (
    !parsed ||
    !["Low", "Medium", "High"].includes(parsed.urgency) ||
    typeof parsed.chiefComplaint !== "string" ||
    !Array.isArray(parsed.suggestedQuestions)
  ) {
    console.error("LLM returned unparseable pre-visit summary", raw);
    return null;
  }
  return parsed;
}

export async function generatePostVisitSummary(
  env: Bindings,
  clinicalNotes: string,
): Promise<string | null> {
  const prompt = `Convert these clinical notes into a patient-friendly summary with a medication schedule and follow-up steps. Write in plain, reassuring language a patient with no medical background can follow. Clinical notes: ${clinicalNotes}`;

  return callLLM(env, prompt);
}
