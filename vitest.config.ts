import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "next/server": path.resolve(__dirname, "./src/shims/next-server.ts")
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    fileParallelism: false
  }
});
