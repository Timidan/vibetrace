import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@vibetrace/schema": fileURLToPath(new URL("./packages/schema/src/index.ts", import.meta.url)),
      "@vibetrace/graph": fileURLToPath(new URL("./packages/graph/src/index.ts", import.meta.url)),
      "@vibetrace/og": fileURLToPath(new URL("./packages/og/src/index.ts", import.meta.url)),
      "@vibetrace/verifier": fileURLToPath(new URL("./packages/verifier/src/index.ts", import.meta.url)),
      "@vibetrace/score": fileURLToPath(new URL("./packages/score/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"]
  }
});
