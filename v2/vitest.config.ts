import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { include: ["src/**/*.test.ts", "app/**/*.test.ts"], fileParallelism: false },
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
});
