// Everything the App SDK's testnet checks do (packages/sdk/src/verify-testnet.ts and
// verify-testnet-2.ts), done by people through the web app on testnet: one browser context per
// device, the backend and its keeper on this machine (playwright.config.ts). Each step reads the
// chain back through the app's own screens, and the run writes every transaction it saw to
// evidence/web-testnet.json. Rows of docs/web-parity.md are named in the step titles.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { BACKEND, BASE_URL, CONTRACT, KEEPER, SPONSOR } from "../playwright.config.ts";

const PIN = "482913"; // test devices only
const CHILD_ADDRESS = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl"; // BIP-84's published test address
const P2WSH_ADDRESS = "tb1qsl5kuaj5rtxl9uje7mp7t5jwgsu8zjw07svh8n43srnfm6ydxe7qslkptf"; // dev-2 jar 1, a jar address
// Devices keep their PIN-locked keys between runs (outside the repo), so reruns reuse their
// sponsored accounts instead of funding new ones. A phone is set up through the screens on the
// run that first makes it; later runs unlock it, and skip the restore, which needs its words.
const DEVICES = join(homedir(), ".sats-jar", "web-journey-devices");
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Step {
  row: number[];
  step: string;
  explorerUrl?: string;
  detail?: string;
}
const evidence: Step[] = [];
const record = (row: number[], step: string, extra: Omit<Step, "row" | "step"> = {}) => {
  evidence.push({ row, step, ...extra });
  console.log(`ok [${row.join(",")}]: ${step}${extra.explorerUrl ? ` ${extra.explorerUrl}` : ""}${extra.detail ? ` (${extra.detail})` : ""}`);
};

interface Device {
  name: string;
  context: BrowserContext;
  page: Page;
  persisted: boolean;
}

// Every open jar page re-reads the chain every 10 seconds. Six devices on one machine polling
// at once trip the public RPC's rate limit, which no single person would, so a device not in
// use waits on a blank page.
const pages: Page[] = [];
async function parkOthers(active: Page): Promise<void> {
  await Promise.all(pages.filter((page) => page !== active && page.url() !== "about:blank").map((page) => page.goto("about:blank")));
}

async function device(browser: Browser, name: string, persisted: boolean): Promise<Device> {
  const file = join(DEVICES, `${name}.json`);
  // The project's viewport and device (desktop or phone) apply to every device's context.
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = test.info().project.use;
  const context = await browser.newContext({
    baseURL: BASE_URL,
    ...(viewport !== undefined ? { viewport } : {}),
    ...(userAgent !== undefined ? { userAgent } : {}),
    ...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
    ...(isMobile !== undefined ? { isMobile } : {}),
    ...(hasTouch !== undefined ? { hasTouch } : {}),
    ...(persisted && existsSync(file) ? { storageState: file } : {}),
  });
  const page = await context.newPage();
  pages.push(page);
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`console error on ${name}'s device: ${message.text()}`);
  });
  return { name, context, page, persisted };
}

async function save(device: Device) {
  if (!device.persisted) return;
  mkdirSync(DEVICES, { recursive: true });
  await device.context.storageState({ path: join(DEVICES, `${device.name}.json`) });
}

/** Saves a device whose keys the app has just made, and fails at once if they are not in the saved file. */
async function saveKeys(device: Device) {
  await expect.poll(() => device.page.evaluate(() => localStorage.getItem("sats-jar:device") !== null)).toBe(true);
  await save(device);
  const saved = readFileSync(join(DEVICES, `${device.name}.json`), "utf8");
  expect(saved, `${device.name}'s saved device holds its PIN-locked keys`).toContain("sats-jar:device");
}

/** Opens a path; if the PIN gate shows, sets the device up or unlocks it, then waits for `ready`. */
async function open(page: Page, path: string, ready: (page: Page) => Locator): Promise<void> {
  await parkOthers(page);
  await page.goto(path);
  await passGate(page, ready(page));
}

async function passGate(page: Page, ready: Locator): Promise<void> {
  const setUp = page.getByRole("heading", { name: "Choose a PIN for this device" });
  const unlock = page.getByRole("heading", { name: "Unlock Sats Jar" });
  await expect(setUp.or(unlock).or(ready).first()).toBeVisible();
  if (await setUp.isVisible()) {
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByLabel("Type it again").fill(PIN);
    await page.getByRole("button", { name: "Save my PIN" }).click();
  } else if (await unlock.isVisible()) {
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByRole("button", { name: "Unlock" }).click();
  }
  // Wait for the gate to go: the screen behind it re-renders once the device is unlocked.
  await expect(setUp.or(unlock)).toHaveCount(0);
  await expect(ready).toBeVisible();
}

const checkIt = async (scope: Page | Locator): Promise<string> => {
  const link = scope.getByRole("link", { name: "Check it yourself ↗" }).last();
  await expect(link).toBeVisible();
  return (await link.getAttribute("href")) ?? "";
};

const section = (page: Page, heading: string): Locator =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

/** Sets up a phone from its recovery phrase; returns the words. Optionally types wrong words first. */
async function setUpPhone(page: Page, wrongFirst: boolean): Promise<string[]> {
  await page.getByRole("button", { name: "Show my recovery phrase" }).click();
  const list = page.locator("ol.words li");
  await expect(list).toHaveCount(12);
  const words = await list.allTextContents();
  await page.getByRole("button", { name: "I've written them down" }).click();
  const labels = page.getByText(/^Word \d+$/);
  await expect(labels).toHaveCount(3);
  const asked = (await labels.allTextContents()).map((label) => Number(label.replace("Word ", "")));
  const typeWords = async (pick: (n: number) => string) => {
    for (const n of asked) await page.getByLabel(`Word ${n}`, { exact: true }).fill(pick(n));
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByLabel("Type it again").fill(PIN);
    await page.getByRole("button", { name: "Finish" }).click();
  };
  if (wrongFirst) {
    await typeWords(() => "zzz");
    await expect(page.getByText("Those words do not match your recovery phrase. Look at it again.")).toBeVisible();
    record([17], "wrong recovery words are refused");
  }
  await typeWords((n) => words[n - 1] ?? "");
  return words;
}

/**
 * Presses a button until its request goes through, as a person would after a refusal that says to
 * try again: a brand-new account shows on chain a few blocks after it is made, and a public RPC
 * can be briefly unavailable.
 */
async function pressUntil(page: Page, button: string, done: Locator): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    // An alert can come from another section's read (the public RPC hiccuping), so the press may
    // have gone through after all: never press again once its result shows.
    if (await done.isVisible()) return;
    await page.getByRole("button", { name: button }).click();
    const outcome = await Promise.race([
      done.waitFor().then(() => "done" as const),
      page.getByRole("alert").waitFor().then(() => "refused" as const),
    ]);
    if (outcome === "done") return;
    if (attempt === 6) throw new Error(`"${button}" kept being refused: ${await page.getByRole("alert").textContent()}`);
    await page.waitForTimeout(5_000);
  }
}

/** Presses a "try it" button; a locked or new device shows the PIN gate first, then the person presses again. */
async function tryIt(page: Page, button: string): Promise<Locator> {
  const press = page.getByRole("button", { name: button });
  await press.click();
  const gate = page.getByRole("heading", { name: /^(Unlock Sats Jar|Choose a PIN for this device)$/ });
  const tried = section(page, "Try to break the rule").getByText(/^Refused: /);
  await expect(gate.or(tried).first()).toBeVisible();
  if (await gate.isVisible()) {
    await passGate(page, press);
    await press.click();
  }
  return section(page, "Try to break the rule");
}

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

test.afterAll(() => {
  const commit = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();
  const project = test.info().project.name;
  writeFileSync(
    join(REPO, "evidence", project === "desktop" ? "web-testnet.json" : `web-testnet-${project}.json`),
    `${JSON.stringify(
      {
        about:
          "Live testnet run of the web app (koukikouks/sats-jar#43): every person's step of the App SDK's testnet checks, done through the browser. Output of app/journeys/web-testnet.journey.ts. `row` is the row of docs/web-parity.md.",
        contract: CONTRACT,
        width: project,
        ran_at: new Date().toISOString(),
        code_commit: commit,
        steps: evidence,
      },
      null,
      2,
    )}\n`,
  );
});

test("everything the SDK's testnet checks do, through the web app", async ({ browser, request }) => {
  // Testnet only: refuse to send anything if the setup points anywhere else.
  for (const account of [CONTRACT, SPONSOR, KEEPER]) expect(account.endsWith(".testnet")).toBe(true);
  expect(process.env.SPONSOR_PRIVATE_KEY, "SPONSOR_PRIVATE_KEY").toBeTruthy();
  expect(process.env.KEEPER_PRIVATE_KEY, "KEEPER_PRIVATE_KEY").toBeTruthy();

  const giver = await device(browser, "giver", true);
  const guardian1 = await device(browser, "guardian-1", true);
  const guardian2 = await device(browser, "guardian-2", true);
  const child = await device(browser, "child", true);
  const friend = await device(browser, "friend", true);
  const restored = await device(browser, "restored-child", false);
  const devices = [giver, guardian1, guardian2, child, friend];
  // Saves each device once its step is over, when the app has written everything it keeps.
  const step = (title: string, body: () => Promise<void>) =>
    test.step(title, async () => {
      await body();
      for (const each of devices) await save(each);
    });
  const nickname = `Web check ${new Date().toISOString().slice(0, 16)}`;
  let jarId = "";
  let unlockAt = 0;
  let childWords: string[] = [];
  let childCode = "";
  let receiveCode = "";

  await step("[1, 2, 3] the giver's device: set up or unlock, lock, a wrong PIN refused", async () => {
    const { page } = giver;
    const home = () => page.getByRole("heading", { name: "Your jars" });
    await page.goto("/");
    const welcome = page.getByRole("link", { name: "Make a jar" });
    await expect(welcome.or(page.getByRole("heading", { name: "Unlock Sats Jar" })).first()).toBeVisible();
    if (await page.getByRole("heading", { name: "Sats Jar", exact: true }).isVisible()) {
      await welcome.click();
      await passGate(page, page.getByRole("heading", { name: "Make a jar" }));
      record([1], "a new device is set up with a PIN");
      await saveKeys(giver);
      await page.goto("/");
    }
    await passGate(page, home());
    await page.getByRole("button", { name: "Lock" }).click();
    await page.getByLabel("PIN", { exact: true }).fill("000000");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("That PIN is not right. Try again.")).toBeVisible();
    record([2, 3], "the app locks, and a wrong PIN is refused");
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(home()).toBeVisible();
  });

  let links: string[] = [];
  await step("[4, 5] the giver starts a jar with 2 guardians", async () => {
    const { page } = giver;
    await open(page, "/new", (p) => p.getByLabel("Jar nickname"));
    await page.getByLabel("Jar nickname").fill(nickname);
    await page.getByRole("button", { name: "Make invite links" }).click();
    await expect(page.getByRole("heading", { name: `${nickname}: invite the guardians` })).toBeVisible();
    links = await page.locator(".invite .mono").allTextContents();
    expect(links).toHaveLength(2);
    record([4, 5], "2 invite links made and kept on the device");
  });

  await step("[6, 7] both guardians see what the invite is for and join; a used link is refused", async () => {
    for (const [n, guardian] of [guardian1, guardian2].entries()) {
      const { page } = guardian;
      await page.goto(links[n] ?? "");
      await expect(page.getByRole("heading", { name: `Be a guardian of ${nickname}` })).toBeVisible();
      await passGate(page, page.getByRole("button", { name: "Join as a guardian" }));
      await page.getByRole("button", { name: "Join as a guardian" }).click();
      await expect(page.getByText(`You're a guardian of ${nickname}.`, { exact: false })).toBeVisible();
      await saveKeys(guardian);
      record([6, 7], `guardian ${n + 1} previewed the link and joined`);
    }
    await guardian1.page.goto(links[0] ?? "");
    await expect(guardian1.page.getByText("Someone has already joined with this invite link. Ask for a new link.")).toBeVisible();
    record([7], "a used invite link is refused");
  });

  await step("[8] every create refusal the screens can reach is a real refused transaction", async () => {
    const { page } = giver;
    await open(page, page.url().replace(/^https?:\/\/[^/]+/, ""), (p) => p.getByRole("heading", { name: "The jar's rule" }));
    const attempts: { code: string; address?: string; cap?: string; date?: string; message: string }[] = [
      { code: "INVALID_CHILD_ADDRESS", address: "not-an-address", message: "That is not a Bitcoin address the jar can pay." },
      { code: "CHILD_ADDRESS_WRONG_NETWORK", address: "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu", message: "That address is for a different Bitcoin network." },
      { code: "CHILD_ADDRESS_NOT_P2WPKH", address: P2WSH_ADDRESS, message: "The child's address must be a standard native segwit address" },
      { code: "CAP_TOO_SMALL", cap: "1000", message: "The cap is too small to pay its own Bitcoin fees." },
      { code: "UNLOCK_IN_PAST", date: "2001-01-01", message: "The unlock date must be in the future." },
      { code: "LOCKTIME_OUT_OF_RANGE", date: "2105-06-01", message: "That unlock date is too far away for Bitcoin." },
    ];
    for (const attempt of attempts) {
      await page.getByLabel("Where should the allowance go?").fill(attempt.address ?? CHILD_ADDRESS);
      await page.getByLabel("Allowance cap (sats each period)").fill(attempt.cap ?? "2500");
      await page.getByLabel("Every 30 days").check();
      await page.getByLabel("Unlock date").fill(attempt.date ?? "2040-05-01");
      await page.getByRole("button", { name: "Make the jar" }).click();
      const alert = page.getByRole("alert");
      await expect(alert).toContainText(attempt.message);
      record([8], `${attempt.code}: "${(await alert.textContent())?.replace(" Check it yourself ↗", "")}"`, { explorerUrl: await checkIt(alert) });
    }
    record([8], "PERIOD_TOO_SHORT and TOO_FEW_GUARDIANS cannot be sent from the screens", {
      detail: "the form offers only 30 days or demo timing (600 s), and offers Create only once 2 guardians have joined",
    });
  });

  await step("[8, 10, 11, 12, 13] the giver creates a demo-timing jar and sees it, empty", async () => {
    const { page } = giver;
    await page.getByLabel("Where should the allowance go?").fill(CHILD_ADDRESS);
    await page.getByLabel("Allowance cap (sats each period)").fill("2500");
    await page.getByLabel("Demo timing: every 10 minutes").check();
    // Unlocks after the emergency payment and the claim steps; the handover delay is 3 minutes.
    await page.getByLabel("Unlocks in (minutes)").fill("8");
    unlockAt = Math.floor(Date.now() / 1000) + 8 * 60;
    await page.getByRole("button", { name: "Make the jar" }).click();
    await page.waitForURL(/\/jar\/\d+$/);
    jarId = page.url().split("/").at(-1) ?? "";
    await expect(page.getByRole("heading", { name: nickname })).toBeVisible();
    await expect(page.getByText("Demo timing").first()).toBeVisible();
    await expect(page.getByText("0 sats in the jar")).toBeVisible();
    await expect(page.getByText("You gave this jar · You hold this jar")).toBeVisible();
    await expect(page.getByText("No top-ups yet.")).toBeVisible();
    await expect(page.getByText("Up to 2,500 sats every 10 minutes.")).toBeVisible();
    await expect(page.getByText("Starts with the first counted top-up.")).toBeVisible();
    await expect(page.locator("img.qr")).toBeVisible();
    await expect(page.getByText(/^If no handover happens, the Bitcoin-only exit opens on /)).toBeVisible();
    record([8, 10, 11, 12, 13], `jar ${jarId} created; the jar page shows it empty, demo timing, with its top-up QR code`);
  });

  await step("[9, 10] guardians see the jar; an unknown jar is refused", async () => {
    await open(guardian2.page, `/jar/${jarId}`, (p) => p.getByRole("heading", { name: nickname }));
    await expect(guardian2.page.getByText("You're a guardian", { exact: true })).toBeVisible();
    await open(guardian1.page, "/", (p) => p.getByRole("heading", { name: "Your jars" }));
    await expect(guardian1.page.getByText(nickname)).toBeVisible();
    record([9, 10], "guardians list the jar and see themselves as guardians");
    await open(giver.page, "/jar/999999", (p) => p.getByText("There is no such jar."));
    record([10], "an unknown jar reads as UNKNOWN_JAR's sentence");
  });

  await step("[17, 19] the child's phone: wrong words refused, then set up from its recovery phrase", async () => {
    const { page } = child;
    await parkOthers(page);
    await page.goto(`/jar/${jarId}/set-up`);
    const claimHeading = page.getByRole("heading", { name: `Claim ${nickname}` });
    const fresh = page.getByRole("heading", { name: "Set up your jar" });
    await expect(fresh.or(page.getByRole("heading", { name: "Unlock Sats Jar" })).first()).toBeVisible();
    if (await fresh.isVisible()) {
      childWords = await setUpPhone(page, true);
      await expect(page.getByRole("heading", { name: `Claim ${nickname}` })).toBeVisible();
      await saveKeys(child);
    } else {
      await passGate(page, claimHeading);
      record([17], "the child's phone was set up on an earlier run; unlocked with its PIN");
    }
    await expect(claimHeading).toBeVisible();
    await expect(page.getByText("After handover, nobody, Sats Jar included, can recover your jar without this phone or your recovery phrase.")).toBeVisible();
    childCode = (await page.locator(".code").textContent()) ?? "";
    record([17, 19], "the child's phone is set up and shows its guardian code", { detail: childCode });
  });

  await step("[17, 26] the friend's phone is set up and shows its receive code", async () => {
    const { page } = friend;
    await parkOthers(page);
    await page.goto("/receive");
    const show = page.getByRole("button", { name: "Show my recovery phrase" });
    await expect(show.or(page.getByRole("heading", { name: "Unlock Sats Jar" })).first()).toBeVisible();
    if (await show.isVisible()) {
      await setUpPhone(page, false);
      await expect(page.getByRole("heading", { name: "Your receive code" })).toBeVisible();
      await saveKeys(friend);
    }
    await passGate(page, page.getByRole("heading", { name: "Your receive code" }));
    receiveCode = (await page.locator(".mono").first().textContent()) ?? "";
    expect(receiveCode.length).toBeGreaterThan(20);
    record([17, 26], "the friend's receive code", { detail: receiveCode });
  });

  await step("[30, 32, 33] try it: a guardian's early spend and an outsider's approval are refused on chain", async () => {
    await open(guardian1.page, `/proof/${jarId}`, (p) => p.getByRole("heading", { name: "Try to break the rule" }));
    const early = await tryIt(guardian1.page, "Send its Bitcoin somewhere else before handover");
    await expect(early.getByText("Refused: Before handover, only the allowance and an emergency payment can pay out, and only to the child's address.")).toBeVisible();
    record([30, 33], "a guardian's early spend: SPEND_BEFORE_HANDOVER", { explorerUrl: await checkIt(early) });
    // Unlocked now, the page knows this device is a guardian, so it offers no outsider's approval.
    await expect(guardian1.page.getByRole("button", { name: "Approve its emergency payment as an outsider" })).toHaveCount(0);
    await open(friend.page, `/proof/${jarId}`, (p) => p.getByRole("heading", { name: "Try to break the rule" }));
    const outsider = await tryIt(friend.page, "Approve its emergency payment as an outsider");
    await expect(outsider.getByText("Refused: Only the jar's guardians can do that.")).toBeVisible();
    record([32, 33], "an outsider's approval: NOT_A_GUARDIAN", { explorerUrl: await checkIt(outsider) });
  });

  await step("[14, 15, 16] emergency payment: proposed, approved, the delay starts, the giver cancels", async () => {
    await open(guardian1.page, `/jar/${jarId}`, (p) => p.getByLabel("Amount (sats)"));
    await guardian1.page.getByLabel("Amount (sats)").fill("2000");
    await guardian1.page.getByRole("button", { name: "Propose" }).click();
    record([14], "a guardian proposed 2,000 sats", { explorerUrl: await checkIt(section(guardian1.page, "Emergency payment")) });
    await open(giver.page, `/jar/${jarId}`, (p) => p.getByText("2,000 sats proposed. 1 of 2 guardians have approved."));
    await open(guardian2.page, `/jar/${jarId}`, (p) => p.getByRole("button", { name: "Approve" }));
    await guardian2.page.getByRole("button", { name: "Approve" }).click();
    record([15], "the second guardian approved", { explorerUrl: await checkIt(section(guardian2.page, "Emergency payment")) });
    await open(giver.page, `/jar/${jarId}`, (p) => p.getByText(/^It goes out after .*, unless the giver cancels it\.$/));
    await open(guardian1.page, `/jar/${jarId}`, (p) => p.getByText("2,000 sats proposed. 2 of 2 guardians have approved."));
    await expect(guardian1.page.getByRole("button", { name: "Cancel it" })).toHaveCount(0);
    record([16], "2 approvals start the public delay; a guardian who isn't the giver is offered no cancel", {
      detail: "the SDK check's NOT_THE_GIVER refusal cannot be sent from the screens",
    });
    await open(giver.page, `/jar/${jarId}`, (p) => p.getByRole("button", { name: "Cancel it" }));
    await giver.page.getByRole("button", { name: "Cancel it" }).click();
    await expect(giver.page.getByText("The last emergency payment was cancelled.")).toBeVisible();
    record([16], "the giver cancelled it", { explorerUrl: await checkIt(section(giver.page, "Emergency payment")) });
  });

  await step("[20, 21, 23] the child claims; a guardian checks the code, then cancels the claim", async () => {
    await open(child.page, `/jar/${jarId}/set-up`, (p) => p.getByRole("button", { name: "Claim my jar" }));
    await pressUntil(child.page, "Claim my jar", child.page.getByText("Show this code to each guardian in person:"));
    await expect(child.page.locator(".code")).toHaveText(childCode);
    record([20], "the child's phone claimed the jar");
    await open(guardian1.page, `/jar/${jarId}`, (p) => p.getByRole("button", { name: "Check the child's code" }));
    await pressUntil(guardian1.page, "Check the child's code", guardian1.page.locator(".code"));
    await expect(guardian1.page.locator(".code")).toHaveText(childCode);
    record([21], "guardian 1 reads the same code from the chain", { detail: childCode });
    await guardian1.page.getByRole("button", { name: "Cancel the claim" }).click();
    record([23], "a guardian cancelled the claim", { explorerUrl: await checkIt(section(guardian1.page, "Handover")) });
    await open(giver.page, `/jar/${jarId}`, (p) => p.getByText(/^The jar unlocks on .*\. From then on, the child can take it over\.$/));
  });

  await step("[20, 21, 22] the child claims again and both guardians confirm", async () => {
    await open(child.page, `/jar/${jarId}/set-up`, (p) => p.getByRole("button", { name: "Claim my jar" }));
    await pressUntil(child.page, "Claim my jar", child.page.getByText("Show this code to each guardian in person:"));
    record([20], "a fresh claim after the cancel");
    for (const [n, guardian] of [guardian1, guardian2].entries()) {
      await open(guardian.page, `/jar/${jarId}`, (p) => p.getByRole("button", { name: "Check the child's code" }));
      await pressUntil(guardian.page, "Check the child's code", guardian.page.locator(".code"));
      await expect(guardian.page.locator(".code")).toHaveText(childCode);
      await guardian.page.getByRole("button", { name: "It matches: confirm" }).click();
      record([21, 22], `guardian ${n + 1} matched the code and confirmed`, { explorerUrl: await checkIt(section(guardian.page, "Handover")) });
    }
    await open(giver.page, `/jar/${jarId}`, (p) => p.getByText(/^Two guardians have confirmed\./));
  });

  await step("[24] the keeper completes the handover once the delay has passed and the jar has unlocked", async () => {
    const delayEndsAt = Math.floor(Date.now() / 1000) + 180;
    await sleep(Math.max(delayEndsAt, unlockAt) - Math.floor(Date.now() / 1000) + 15);
    for (let pass = 1; ; pass += 1) {
      const run = await request.post(`${BACKEND}/keeper/run`);
      const report = (await run.json()) as { steps: { action: string; jarId?: string; result: string; nearTx?: string }[] };
      for (const step of report.steps.filter((s) => s.jarId === jarId)) {
        record([24], `keeper: ${step.action} ${step.result}`, step.nearTx ? { explorerUrl: `https://testnet.nearblocks.io/txns/${step.nearTx}` } : {});
      }
      await open(child.page, `/jar/${jarId}`, (p) => p.getByRole("heading", { name: "Handover" }));
      if (await child.page.getByText(/^Handed over on /).isVisible()) break;
      if (pass === 6) throw new Error("the handover did not complete after 6 keeper passes");
      await sleep(20);
    }
    await expect(child.page.getByText("Nobody, Sats Jar included, can recover this jar without your phone or your recovery phrase. Keep your recovery phrase safe.")).toBeVisible();
    await expect(child.page.getByText("You hold this jar", { exact: false })).toBeVisible();
    await expect(child.page.getByText(/^If the signing network behind Sats Jar ever stops, the Bitcoin-only exit opens on .+, and only the holder's recovery phrase can use it\.$/)).toBeVisible();
    record([24], "the child holds the jar and reads that nobody can recover it without their phone or phrase");
  });

  await step("[18] the child's phrase restores the jar on another phone", async () => {
    const { page } = restored;
    if (childWords.length === 0) {
      // The SDK's own testnet checks have no restore; the screen test covers this row.
      record([18], "not run: the child's phone was set up on an earlier run, so its words were not shown on this one");
      return;
    }
    await parkOthers(page);
    await page.goto("/restore");
    await page.getByLabel("Recovery phrase").fill(childWords.join(" "));
    await page.getByLabel("PIN", { exact: true }).fill(PIN);
    await page.getByLabel("Type it again").fill(PIN);
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByRole("heading", { name: "Your jars" })).toBeVisible();
    const card = page.locator(".card").filter({ hasText: nickname });
    await expect(card.getByText("You hold this jar", { exact: false })).toBeVisible();
    record([18], "the restored phone holds the same jar");
  });

  await step("[31] try it: the family's spend after handover is refused as not the holder", async () => {
    // Locked, the page can't tell this is the giver's device and offers the outsider's wording;
    // unlocked, it offers the family's spend.
    await open(giver.page, `/proof/${jarId}`, (p) => p.getByRole("button", { name: "Spend it without holding it" }));
    await giver.page.getByRole("button", { name: "Spend it without holding it" }).click();
    await passGate(giver.page, giver.page.getByRole("button", { name: "Spend it as the family after handover" }));
    await giver.page.getByRole("button", { name: "Spend it as the family after handover" }).click();
    const tried = section(giver.page, "Try to break the rule");
    await expect(tried.getByText("Refused: Only the jar's holder can do that, and you no longer hold this jar.")).toBeVisible();
    record([31], "the family account's spend after handover: NOT_THE_HOLDER", { explorerUrl: await checkIt(tried) });
  });

  await step("[25] the holder's spend reaches the rule (the jar is empty)", async () => {
    const { page } = child;
    await open(page, `/jar/${jarId}`, (p) => p.getByRole("heading", { name: "Send Bitcoin" }));
    await page.getByLabel("To (Bitcoin address)").fill(CHILD_ADDRESS);
    await page.getByLabel("Amount (sats)").fill("1000");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("The jar does not hold enough Bitcoin for that payment and its fee.");
    record([25], "the holder's spend: INSUFFICIENT_BALANCE", { explorerUrl: await checkIt(alert) });
  });

  await step("[27, 28, 29] the holder transfers to the friend's receive code, cancels, transfers again; the friend accepts", async () => {
    const { page } = child;
    const start = async () => {
      await page.getByLabel("Their receive code").fill(receiveCode);
      await page.getByRole("button", { name: "Start the transfer" }).click();
      await expect(page.getByText("Send them this link so they can accept:")).toBeVisible();
    };
    await start();
    record([27], "a transfer to the friend's receive code", { explorerUrl: await checkIt(page) });
    await page.getByRole("button", { name: "Cancel the transfer" }).click();
    await expect(page.getByRole("heading", { name: "Send Bitcoin" })).toBeVisible();
    record([28], "the holder cancelled it", { explorerUrl: await checkIt(page) });
    await start();
    const acceptLink = (await page.locator(".mono").filter({ hasText: "/accept" }).textContent()) ?? "";
    await parkOthers(friend.page);
    await friend.page.goto(acceptLink);
    await passGate(friend.page, friend.page.getByRole("heading", { name: `Accept ${nickname}` }));
    await friend.page.getByRole("button", { name: "Accept the jar" }).click();
    await friend.page.waitForURL(new RegExp(`/jar/${jarId}$`));
    await expect(friend.page.getByText("You hold this jar", { exact: false })).toBeVisible();
    record([29], "the friend accepted with their own key and holds the jar");
  });

  await step("[33] the public record shows the jar's life, refusals included, with no account names", async () => {
    const page = await (await browser.newContext({ baseURL: BASE_URL, viewport: test.info().project.use.viewport ?? null })).newPage();
    await parkOthers(page);
    await page.goto(`/proof/${jarId}`);
    await expect(page.getByRole("heading", { name: `${nickname}: public record` })).toBeVisible();
    await expect(page.getByText("Held by: its holder since handover", { exact: false })).toBeVisible();
    const requests = section(page, "Requests");
    await expect(requests.getByText(/^Refused: /).first()).toBeVisible();
    const text = (await page.locator("main").textContent()) ?? "";
    expect(text).not.toMatch(/\.testnet/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll").toBe(true);
    record([33], `the public record lists ${await requests.locator("li").count()} requests, ${await requests.getByText(/^Refused: /).count()} of them refused, and names no account`);
  });
});
