import { test, expect } from "@playwright/test";

test("explicit live session survives panel close/hidden/idle, accepts file imports, and locks at one hour", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.clock.install(); await page.goto("http://127.0.0.1:4319");
    await page.getByLabel("Buffer passphrase").fill("synthetic live browser passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await expect(page.getByText("0 records buffered")).toBeVisible();
    await page.getByRole("button", { name: "Use current Discord conversation" }).click();
    await page.getByLabel("I have authority").check(); await page.getByRole("button", { name: "Save permission" }).click();
    await expect(page.getByRole("button", { name: "Start live capture", exact: true })).toBeDisabled();
    await page.evaluate(async () => { await (window as any).__liveFixture.emit(); });
    await expect(page.getByText("0 records buffered")).toBeVisible();
    await page.getByLabel("Keep the buffer unlocked").check(); await page.getByRole("button", { name: "Start live capture", exact: true }).click();
    await expect(page.getByText(/Live: 1 conversation/)).toBeVisible();
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.clock.fastForward(360_000);
    await expect(page.getByText(/Live: 1 conversation/)).toBeVisible();
    await page.evaluate(() => { (window as any).__liveFixture.mount(false); });
    await expect(page.getByText("Test settings closed")).toBeVisible();
    await page.evaluate(async () => { await (window as any).__liveFixture.emit(); });
    expect(await page.evaluate(() => (window as any).__liveFixture.status().count)).toBe(1);
    await page.evaluate(() => { (window as any).__liveFixture.mount(true); });
    await expect(page.getByText("1 records buffered")).toBeVisible();
    // Add a separate file permission to the same Vencord buffer while live mode is running.
    await page.getByLabel("I have authority").check(); await page.getByRole("button", { name: "Save permission" }).click();
    await expect(page.getByLabel("Local JSON file")).toBeEnabled();
    await page.getByLabel("Local JSON file").setInputFiles("examples/manual-conversation.json");
    await page.getByLabel("Import all 1 reviewed messages").check(); await page.getByRole("button", { name: "Import reviewed messages" }).click();
    await expect(page.getByText("2 records buffered")).toBeVisible();
    await page.clock.fastForward(54 * 60_000 + 1000);
    await expect(page.getByLabel("Buffer passphrase")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__liveFixture.status().active)).toBe(false);
    expect(errors).toEqual([]);
});

test("closing a non-live Vencord panel drops its unlocked key", async ({ page }) => {
    await page.goto("http://127.0.0.1:4319"); await page.getByLabel("Buffer passphrase").fill("synthetic live browser passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await expect(page.getByText("0 records buffered")).toBeVisible();
    await page.evaluate(() => { (window as any).__liveFixture.mount(false); });
    await expect(page.getByText("Test settings closed")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__liveFixture.status().unlocked)).toBe(false);
});

test("all-conversations button requires authority and risk checks and does not restart after reload", async ({ page }) => {
    await page.goto("http://127.0.0.1:4319"); await page.getByLabel("Buffer passphrase").fill("synthetic all browser passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await page.getByRole("button", { name: "Allow all conversations" }).click();
    const start = page.getByRole("button", { name: "Start all conversations for one hour" });
    await expect(start).toBeDisabled();
    await page.getByLabel("I have authority and any required").check(); await expect(start).toBeDisabled();
    await page.getByLabel("I accept the account and privacy risks of all-conversations").check(); await start.click();
    await expect(page.getByText(/Live: ALL conversations on this account/)).toBeVisible();
    await page.evaluate(async () => { await (window as any).__liveFixture.emit(); });
    await expect(page.getByText("1 records buffered")).toBeVisible();
    await page.reload(); await page.getByLabel("Buffer passphrase").fill("synthetic all browser passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await expect(page.getByText("1 records buffered")).toBeVisible();
    expect(await page.evaluate(() => (window as any).__liveFixture.status().active)).toBe(false);
});
