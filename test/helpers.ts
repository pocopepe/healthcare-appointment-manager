import { env } from "cloudflare:test";
import type { Bindings } from "../src/server/env";
import { createDb } from "../src/server/db/client";

export const testEnv = env as unknown as Bindings;
export const db = createDb(testEnv.DB);

export async function api(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: any }> {
  const { SELF } = await import("cloudflare:test");
  const res = await SELF.fetch(`http://example.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();
  return { status: res.status, body };
}
