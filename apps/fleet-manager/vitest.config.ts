import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Pure-function tests only for now — DB-dependent paths are
    // exercised by scripts/e2e-terraform.sh. As real integration
    // coverage lands the pool/setup will move here.
    environment: "node",
  },
});
