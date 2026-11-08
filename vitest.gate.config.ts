import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/apk-gate.server.ts"],
    fileParallelism: false,
    testTimeout: 0,
    hookTimeout: 30_000
  }
});
