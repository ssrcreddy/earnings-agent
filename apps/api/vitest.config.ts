import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "api",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    fileParallelism: false,
    // Integration tests hit the real test database and start pg-boss.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
