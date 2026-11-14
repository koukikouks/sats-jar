// The web app's testnet journey (spec #37, seam B): the built app in Chromium, the backend with
// its keeper on this machine, the development contract on testnet.
//
//   SPONSOR_PRIVATE_KEY=... KEEPER_PRIVATE_KEY=... pnpm --dir app journeys
//
// Both keys come from the environment of the command that runs it and are never written to a file.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const CONTRACT = "sats-jar-dev-2.testnet";
export const SPONSOR = "sats-jar-app.testnet";
// The keeper whose function-call key works on CONTRACT (backend/README.md).
export const KEEPER = "keeper-2.sats-jar-app.testnet";
export const BACKEND = "http://localhost:8790";
export const BASE_URL = "http://localhost:4280";

export default defineConfig({
  testDir: "journeys",
  testMatch: "*.journey.ts",
  // The hosted journeys run against a deployed site with their own config (playwright.hosted.config.ts).
  testIgnore: "hosted-*.journey.ts",
  timeout: 45 * 60_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: "list",
  // A click waits at most 90 s, so a wrong step fails in minutes rather than at the 45-minute limit.
  use: { baseURL: BASE_URL, trace: "retain-on-failure", actionTimeout: 90_000, navigationTimeout: 90_000 },
  // The same journey at desktop and at phone width (pnpm --dir app journeys --project=phone).
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "node ../backend/src/server.ts",
      port: 8790,
      reuseExistingServer: false,
      env: {
        SPONSOR_ACCOUNT_ID: SPONSOR,
        SPONSOR_PRIVATE_KEY: process.env.SPONSOR_PRIVATE_KEY ?? "",
        CONTRACT_ACCOUNT_ID: CONTRACT,
        KEEPER_ACCOUNT_ID: KEEPER,
        KEEPER_PRIVATE_KEY: process.env.KEEPER_PRIVATE_KEY ?? "",
        DRAFTS_FILE: join(tmpdir(), "sats-jar-web-journey-drafts.json"),
        PORT: "8790",
      },
    },
    {
      command: "pnpm exec vite build && pnpm exec vite preview --port 4280 --strictPort",
      port: 4280,
      reuseExistingServer: false,
      env: { VITE_SATS_JAR_CONTRACT: CONTRACT, SATS_JAR_BACKEND: BACKEND },
    },
  ],
});
