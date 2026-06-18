import { defineConfig } from "vitest/config";

// Integration suite: spins up a real Redis via testcontainers (needs Docker).
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
