// Hosted journey C1 (spec #45, seam C): the app host's first steps through the real Railway backend
// and the locked contract, on whatever app address playwright.hosted.config.ts is given. One giver
// device and one guardian device. No jar is created, so nothing lands on the locked contract.
// Writes the run to evidence/hosting.json under "c1", next to the backend checks already there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";

const PIN = "482913"; // test devices only
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE = join(REPO, "evidence", "hosting.json");

interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
  file: string;
}

const steps: string[] = [];
let finished = false;
const accounts: Record<string, string> = {};
const passed = (step: string) => {
  steps.push(step);
  console.log(`ok: ${step}`);
};

// Device keys live per origin, so each app address gets its own saved devices (outside the repo);
// reruns on the same address unlock them instead of asking the sponsor for new accounts.
function devicesDir(): string {
  const host = new URL(test.info().project.use.baseURL ?? "").host;
  return join(homedir(), ".sats-jar", "hosted-journey-devices", host);
}

async function device(browser: Browser, name: string): Promise<Device> {
  const file = join(devicesDir(), `${test.info().project.name}-${name}.json`);
  const { baseURL, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context = await browser.newContext({
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
    ...(isMobile !== undefined ? { isMobile } : {}),
    ...(hasTouch !== undefined ? { hasTouch } : {}),
    ...(existsSync(file) ? { storageState: file } : {}),
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`console error on the ${name}'s device: ${message.text()}`);
  });
  return { name, context, page, file };
}

const accountOf = (device: Device) =>
  device.page.evaluate(() => (JSON.parse(localStorage.getItem("sats-jar:device") ?? "{}") as { accountId?: string | null }).accountId ?? null);

/** Saves the device, PIN-locked keys and all, so a rerun on the same address unlocks it. */
async function save(device: Device): Promise<void> {
  await expect.poll(() => device.page.evaluate(() => localStorage.getItem("sats-jar:device") !== null)).toBe(true);
  mkdirSync(dirname(device.file), { recursive: true });
  await device.context.storageState({ path: device.file });
}

/** Sets the device up with a PIN, or unlocks it on a rerun, then waits for `ready`. */
async function passGate(page: Page, ready: Locator): Promise<"set up" | "unlocked" | "open"> {
  const setUp = page.getByRole("heading", { name: "Set up Sats Jar on this device" });
  const unlock = page.getByRole("heading", { name: "Unlock Sats Jar" });
  await expect(setUp.or(unlock).or(ready).first()).toBeVisible();
  let how: "set up" | "unlocked" | "open" = "open";
  if (await setUp.isVisible()) {
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByLabel("Type it again").fill(PIN);
    await page.getByRole("button", { name: "Set up" }).click();
    how = "set up";
  } else if (await unlock.isVisible()) {
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByRole("button", { name: "Unlock" }).click();
    how = "unlocked";
  }
  await expect(setUp.or(unlock)).toHaveCount(0);
  await expect(ready).toBeVisible();
  return how;
}

test("C1: a giver starts a jar and a guardian joins, through the hosted backend", async ({ browser, request }) => {
  const baseURL = test.info().project.use.baseURL ?? "";
  const giver = await device(browser, "giver");
  const guardian = await device(browser, "guardian");
  const nickname = `Hosted check ${new Date().toISOString().slice(0, 16)}`;
  let links: string[] = [];

  await test.step("the giver sets a PIN and starts a jar with 2 invites", async () => {
    const { page } = giver;
    await page.goto("/new");
    const how = await passGate(page, page.getByLabel("Jar nickname"));
    await page.getByLabel("Jar nickname").fill(nickname);
    await page.getByLabel("2", { exact: true }).check();
    await page.getByRole("button", { name: "Make invite links" }).click();
    await expect(page.getByRole("heading", { name: `${nickname}: invite the guardians` })).toBeVisible();
    links = await page.locator(".invite .mono").allTextContents();
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.startsWith(`${new URL(baseURL).origin}/join/`)).toBe(true);
    await save(giver);
    // The giver's own account is made when they create the jar, which C1 never does.
    const account = await accountOf(giver);
    if (account !== null) accounts.giver = account;
    passed(`the giver's device was ${how} with a PIN and the backend made a draft with 2 invite links`);
  });

  await test.step("the guardian opens their invite link, sets a PIN and joins", async () => {
    const { page } = guardian;
    await page.goto(links[0] ?? "");
    await expect(page.getByRole("heading", { name: `Be a guardian of ${nickname}` })).toBeVisible();
    const how = await passGate(page, page.getByRole("button", { name: "Join as a guardian" }));
    await page.getByRole("button", { name: "Join as a guardian" }).click();
    await expect(page.getByText(`You're a guardian of ${nickname}.`, { exact: false })).toBeVisible();
    // Joining is when the backend makes the guardian's sponsored account.
    await expect.poll(() => accountOf(guardian), { message: "the guardian's device holds its sponsored account" }).not.toBeNull();
    accounts.guardian = (await accountOf(guardian)) ?? "";
    await save(guardian);
    passed(`the guardian's device was ${how} with a PIN, joined from the invite link and holds sponsored account ${accounts.guardian}`);
  });

  await test.step("the giver's draft page shows the guardian joined, from fresh answers", async () => {
    const { page } = giver;
    // The draft page polls the backend every 10 s; the flip from Waiting to Joined needs an uncached answer.
    const polled = page.waitForResponse((response) => /\/api\/drafts\/[^/]+$/.test(new URL(response.url()).pathname) && response.request().method() === "GET");
    const firstInvite = page.locator(".invite").first();
    await expect(firstInvite.locator(".badge")).toHaveText("Joined");
    const response = await polled;
    expect(response.status()).toBe(200);
    expect(response.headers()["x-vercel-cache"] ?? "").not.toBe("HIT");
    passed("the giver's draft page shows guardian 1 joined (draft read not served from cache)");
  });

  await test.step("a public record loads with no device set up", async () => {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto("/proof/1");
    const record = page.getByRole("heading", { name: /: public record$/ });
    const noJar = page.getByText("There is no such jar.");
    await expect(record.or(noJar).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /^(Unlock Sats Jar|Set up Sats Jar on this device)$/ })).toHaveCount(0);
    passed(`/proof/1 loads with no sign-in and shows ${(await record.isVisible()) ? "the jar's public record" : '"There is no such jar." read from the chain'}`);
    await context.close();
  });

  await test.step("POST /api/keeper/run answers with a report", async () => {
    const response = await request.post("/api/keeper/run");
    expect(response.status()).toBe(200);
    const report = (await response.json()) as { startedAt?: unknown; steps?: unknown };
    expect(typeof report.startedAt).toBe("number");
    expect(Array.isArray(report.steps)).toBe(true);
    passed(`POST /api/keeper/run answered 200 with a report of ${(report.steps as unknown[]).length} steps`);
  });
  finished = true;
});

test.afterAll(() => {
  const project = test.info().project.name;
  // Re-read just before writing so the desktop and phone runs, and the backend checks, are all kept.
  const evidence = JSON.parse(readFileSync(EVIDENCE, "utf8")) as Record<string, unknown>;
  const c1 = (evidence.c1 ?? {}) as Record<string, unknown>;
  c1[project] = {
    base_url: test.info().project.use.baseURL,
    deployed_commit: process.env.SATS_JAR_HOSTED_COMMIT ?? null,
    ran_at: new Date().toISOString(),
    passed: finished,
    accounts,
    steps,
  };
  evidence.c1 = c1;
  writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
});
