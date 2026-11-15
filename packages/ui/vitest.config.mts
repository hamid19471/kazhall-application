import { defineConfig } from "vitest/config";

/**
 * Unit and component tests for the shared UI package.
 *
 * `jsdom` gives the React Aria components a DOM; `package.json`'s `test`
 * script also re-runs the date-conversion suite under two extreme timezones
 * (UTC−10 and UTC+14) to prove no calendar day moves with the machine's zone.
 */
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    pool: "forks",
  },
});
