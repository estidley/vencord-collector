import { test, expect } from "@playwright/test";

test("optional receiver sync: token checked at setup, never stored readable, status shown, stop removes it", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${process.env.COLLECTOR_HOST_TEST_PORT ?? "4319"}/?always=1&sync=1`);
    await page.getByLabel("Buffer passphrase", { exact: false }).fill("synthetic browser sync passphrase");
    await expect(page.getByText("Nothing is uploaded.")).toBeVisible();
    await page.getByLabel("Also sync everything collected").check();
    await expect(page.getByText(/sent, encrypted, to your personal-coordination-mcp receiver on this computer/)).toBeVisible();
    await expect(page.getByLabel("Importer ID")).toHaveValue("collector-home");
    await expect(page.getByLabel("Receiver port on 127.0.0.1")).toHaveValue("4320");
    // A token the receiver rejects fails setup and arms nothing.
    await page.getByLabel("Importer token").fill("W".repeat(43));
    await page.getByRole("button", { name: "Accept at my own risk and start collecting" }).click();
    await expect(page.getByText(/Automatic collection was not started. The receiver rejected that importer token/)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__liveFixture.storedSync())).toBeUndefined();
    expect(await page.evaluate(() => (window as any).__liveFixture.status().active)).toBe(false);
    await page.getByLabel("Buffer passphrase", { exact: false }).fill("synthetic browser sync passphrase");
    await page.getByLabel("Also sync everything collected").check();
    await page.getByLabel("Importer token").fill("R".repeat(43));
    await page.getByRole("button", { name: "Accept at my own risk and start collecting" }).click();
    await expect(page.getByText("Collecting automatically and syncing to your receiver. You can close this panel.")).toBeVisible();
    await expect(page.getByLabel("Importer token")).toHaveCount(0);
    const stored = await page.evaluate(() => (window as any).__liveFixture.storedSync());
    expect(stored).toBeTruthy(); expect(atob(stored)).not.toContain("RRRR");
    await page.evaluate(async () => { await (window as any).__liveFixture.emit(); await (window as any).__liveFixture.syncTick(); });
    await expect(page.getByTestId("sync-status")).toContainText("0 pending · 1 delivered");
    expect(await page.evaluate(() => (window as any).__liveFixture.received())).toBe(1);
    await page.getByRole("button", { name: "Stop collecting and forget password" }).click();
    await expect(page.getByText(/stay off after restarting/)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__liveFixture.storedSync())).toBeUndefined();
    await expect(page.getByTestId("sync-status")).toHaveCount(0);
    expect(errors).toEqual([]);
});
