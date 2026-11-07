import { defineConfig } from "vitest/config";

/** Pure rules only: no database, no server setup. */
export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
