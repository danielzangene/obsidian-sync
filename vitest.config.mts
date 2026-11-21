import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Conflict-copy names use local time; pin it so tests are deterministic.
    env: { TZ: "UTC" },
  },
});
