import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Vitest defaults to five seconds, which suits a suite of pure functions.
    // This one clones repositories, spawns pseudo-terminals and loads fastlane;
    // several tests legitimately sit at three or four seconds, and under
    // parallel load they crossed the line and failed for no reason. A budget
    // exists to catch a hang, not to punish a slow-but-honest test.
    testTimeout: 30_000,
  },
});
