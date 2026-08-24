import { describe, it, expect } from "vitest";
import { db, testEnv } from "../helpers";
import { llmUsage } from "../../src/server/db/schema";
import {
  generatePreVisitSummary,
  generatePostVisitSummary,
  getUsageToday,
  explainUnavailable,
} from "../../src/server/lib/llm";

function today() {
  return new Date().toISOString().slice(0, 10);
}

// The point of the cap is that the app refuses to spend past its own budget,
// so an unexpected burst of traffic can't run into Cloudflare's daily Neuron
// allocation (failing hard on the free plan, billing on the paid one).
describe("LLM daily budget", () => {
  it("refuses to call the model once the daily cap is reached", async () => {
    // The suite runs with LLM_DAILY_LIMIT=0, so the budget is always spent.
    const before = await getUsageToday(db);

    const pre = await generatePreVisitSummary(testEnv, db, "headache for two days");
    expect(pre.ok).toBe(false);
    if (!pre.ok) expect(pre.reason).toBe("daily_limit");

    const post = await generatePostVisitSummary(testEnv, db, "viral infection, rest");
    expect(post.ok).toBe(false);
    if (!post.ok) expect(post.reason).toBe("daily_limit");

    // Crucially, a refused call must not have spent anything.
    expect(await getUsageToday(db)).toBe(before);
  });

  it("explains a capped summary in language a patient can read", () => {
    const text = explainUnavailable("daily_limit");
    expect(text).toMatch(/limit/i);
    expect(text).not.toMatch(/null|undefined|error code/i);
  });

  it("counts usage per UTC day so the budget resets at midnight", async () => {
    await db
      .insert(llmUsage)
      .values({ date: "2020-01-01", requests: 999 })
      .onConflictDoUpdate({ target: llmUsage.date, set: { requests: 999 } });
    await db
      .insert(llmUsage)
      .values({ date: today(), requests: 7 })
      .onConflictDoUpdate({ target: llmUsage.date, set: { requests: 7 } });

    // Yesterday's spend must not count against today's budget.
    expect(await getUsageToday(db)).toBe(7);
  });
});
