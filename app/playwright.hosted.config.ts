// The hosted journeys (spec #45, seam C): the deployed site and the Railway backend, nothing run on
// this machine. The app address is given at run time, e.g. a Vercel preview's branch address:
//
//   SATS_JAR_HOSTED_URL=https://<preview> pnpm --dir app journeys:hosted
import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.SATS_JAR_HOSTED_URL;
if (!baseURL) throw new Error("Set SATS_JAR_HOSTED_URL to the app address to check.");

export default defineConfig({
  testDir: "journeys",
  testMatch: "hosted-*.journey.ts",
  timeout: 10 * 60_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: "list",
  use: { baseURL, trace: "retain-on-failure", actionTimeout: 90_000, navigationTimeout: 90_000 },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } } },
  ],
});
