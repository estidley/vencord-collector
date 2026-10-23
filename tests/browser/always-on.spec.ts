import { test, expect } from "@playwright/test";

test("password and one accept button start capture; reload needs no password; stop survives reload", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.clock.install(); await page.goto(`http://127.0.0.1:${process.env.COLLECTOR_HOST_TEST_PORT ?? "4319"}/?always=1`);
    await expect(page.getByRole("button", { name: "Accept at my own risk and start collecting" })).toBeEnabled();
    await page.getByLabel("Buffer passphrase", { exact: false }).fill("simple one time browser passphrase");
    expect(await page.evaluate(() => (window as any).__liveFixture.status().active)).toBe(false);
    await page.getByRole("button", { name: "Accept at my own risk and start collecting" }).click();
    await expect(page.getByText(/Continuous — no session time limit/)).toBeVisible();
    await expect(page.getByLabel("Conversation permission (JSON)")).not.toBeVisible();
    await page.clock.fastForward(2 * 60 * 60_000); await page.evaluate(async () => { await (window as any).__liveFixture.emit(); });
    await expect(page.getByText("1 records buffered")).toBeVisible();
    await page.reload(); await expect(page.getByText(/Continuous — no session time limit/)).toBeVisible();
    await expect(page.getByLabel("Buffer passphrase", { exact: false })).toHaveCount(0);
    const stored = await page.evaluate(() => (window as any).__liveFixture.storedAuto()); expect(stored).not.toContain("simple one time");
    await page.getByRole("button", { name: "Stop collecting and forget password" }).click();
    await expect(page.getByRole("status")).toContainText("stay off");
    await page.reload(); await expect(page.getByRole("button", { name: "Accept at my own risk and start collecting" })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).__liveFixture.status().active)).toBe(false); expect(errors).toEqual([]);
});

test("wrong password and switching accounts cannot start unauthorized capture", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${process.env.COLLECTOR_HOST_TEST_PORT ?? "4319"}/?always=1`);
    await page.getByLabel("Buffer passphrase", { exact: false }).fill("another one time browser passphrase");
    await page.getByRole("button", { name: "Accept at my own risk and start collecting" }).click();
    await expect(page.getByText(/Continuous — no session time limit/)).toBeVisible();
    await page.evaluate(async () => { await (window as any).__liveFixture.switchAccount("999"); });
    await expect(page.getByText(/This account is not collected/)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__liveFixture.status().unlocked)).toBe(false);
    await page.getByRole("button", { name: "Stop collecting and forget password" }).click();
    await page.getByLabel("Buffer passphrase", { exact: false }).fill("wrong password but long enough");
    await page.getByRole("button", { name: "Accept at my own risk and start collecting" }).click();
    await expect(page.getByRole("status")).toContainText("Cannot decrypt");
    expect(await page.evaluate(() => (window as any).__liveFixture.status().active)).toBe(false);
});
