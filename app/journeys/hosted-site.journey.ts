// Hosted journey C2 (spec #45, seam C): production only. The apex satsjar.app serves the landing page,
// with and without JavaScript, and sends every app path to app.satsjar.app, so a button, an invite
// link or a public record opened on the apex lands in the app. Run with the app host as the base:
//
//   SATS_JAR_HOSTED_URL=https://app.satsjar.app pnpm --dir app journeys:hosted
//
// Writes the run to evidence/hosting.json under "c2".
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const APEX = "https://satsjar.app";
const APP = "https://app.satsjar.app";
const PIN = "482913"; // test devices only
const EVIDENCE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "evidence", "hosting.json");

const steps: string[] = [];
let finished = false;
const passed = (step: string) => {
  steps.push(step);
  console.log(`ok: ${step}`);
};

test("C2: the apex serves the landing and sends every app path to the app host", async ({ browser, request }) => {
  test.skip(test.info().project.use.baseURL !== APP, "C2 checks production only");

  await test.step("the landing reads without JavaScript and its buttons point at the app host", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${APEX}/`);
    await expect(page.getByRole("heading", { name: "Set your loved one up for life" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Make a jar" })).toHaveAttribute("href", `${APP}/new`);
    await expect(page.getByRole("link", { name: "Open the proof view" })).toHaveAttribute("href", `${APP}/proof/1`);
    await context.close();
    passed("satsjar.app shows the landing without JavaScript; Make a jar and Open the proof view point at app.satsjar.app");
  });

  await test.step("Make a jar on the landing opens the app's first screen", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${APEX}/`);
    await page.getByRole("link", { name: "Make a jar" }).click();
    await page.waitForURL(`${APP}/new`);
    await expect(page.getByRole("heading", { name: "Choose a PIN for this device" })).toBeVisible();
    await context.close();
    passed("Make a jar on satsjar.app lands on app.satsjar.app/new at the PIN screen");
  });

  // Fresh devices each run, so each run spends one sponsored guardian account (0.25 testnet NEAR).
  await test.step("an invite link opened on the apex joins on the app host", async () => {
    const giver = await (await browser.newContext({ baseURL: APP })).newPage();
    await giver.goto("/new");
    await giver.getByLabel("PIN", { exact: true }).fill(PIN);
    await giver.getByLabel("Type it again").fill(PIN);
    await giver.getByRole("button", { name: "Save my PIN" }).click();
    const nickname = `C2 ${new Date().toISOString().slice(0, 16)}`;
    await giver.getByLabel("Jar nickname").fill(nickname);
    await giver.getByRole("button", { name: "Make invite links" }).click();
    const link = (await giver.locator(".invite .mono").first().textContent()) ?? "";
    const token = new URL(link).pathname;
    const guardian = await (await browser.newContext()).newPage();
    await guardian.goto(`${APEX}${token}`);
    await guardian.waitForURL(`${APP}${token}`);
    await guardian.getByLabel("PIN", { exact: true }).fill(PIN);
    await guardian.getByLabel("Type it again").fill(PIN);
    await guardian.getByRole("button", { name: "Join as a guardian" }).click();
    await expect(guardian.getByText(`You're a guardian of ${nickname}.`, { exact: false })).toBeVisible();
    await giver.context().close();
    await guardian.context().close();
    passed(`an invite opened as satsjar.app${token} landed on app.satsjar.app and joined`);
  });

  await test.step("another app path and the raw page file redirect permanently", async () => {
    for (const path of ["/proof/1", "/app.html"]) {
      const response = await request.get(`${APEX}${path}`, { maxRedirects: 0 });
      expect(response.status()).toBe(308);
      expect(response.headers().location).toBe(`${APP}${path}`);
    }
    passed("satsjar.app/proof/1 and satsjar.app/app.html answer 308 to the same path on app.satsjar.app");
  });
  finished = true;
});

test.afterAll(() => {
  if (test.info().project.use.baseURL !== APP) return;
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as Record<string, unknown>;
  const c2 = (evidence.c2 ?? {}) as Record<string, unknown>;
  c2[test.info().project.name] = {
    base_url: APP,
    deployed_commit: process.env.SATS_JAR_HOSTED_COMMIT ?? null,
    ran_at: new Date().toISOString(),
    passed: finished,
    steps,
  };
  evidence.c2 = c2;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
});
