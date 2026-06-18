import { defineConfig } from "vitest/config";

// Default suite: fast unit tests only. Integration tests (real Redis via
// testcontainers) live behind `npm run test:integration`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
    testTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.integration.test.ts",
        "src/fake-redis.ts",
      ],
    },
  },
});
