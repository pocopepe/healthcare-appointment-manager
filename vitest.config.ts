import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";

const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Test-only fixed secret and feature toggles so the suite never
          // depends on a local .dev.vars file being present.
          JWT_SECRET: "test-secret-do-not-use-in-production",
          APP_BASE_URL: "http://localhost:5173",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
