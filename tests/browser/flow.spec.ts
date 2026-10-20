import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decodeBatch } from "../../src/core/connector";

test("real browser: grant, preview text safely, import, reload, export, revoke", async ({ page }) => {
    const errors: string[] = []; const external: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => { if (!req.url().startsWith("http://127.0.0.1:4317")) external.push(req.url()); });
    await page.goto("/");
    await page.getByLabel("Buffer passphrase").fill("strong browser testing passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await expect(page.getByText("0 snapshots buffered")).toBeVisible();
    const scope = page.getByLabel("Conversation permission (JSON)");
    const draft = JSON.parse(await scope.inputValue()); draft.allowExport = true;
    await scope.fill(JSON.stringify(draft));
    await page.getByLabel("I have authority").check(); await page.getByRole("button", { name: "Save permission" }).click();
    const sample = JSON.parse(await readFile("examples/manual-conversation.json", "utf8"));
    sample.messages[0].content = '<img src="https://invalid.example/track" onerror="alert(1)">';
    await expect(page.getByLabel("Local JSON file")).toBeEnabled();
    await page.getByLabel("Local JSON file").setInputFiles({ name: "manual.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)) });
    await expect(page.locator("pre")).toContainText("<img"); await expect(page.locator("pre img")).toHaveCount(0);
    await page.getByLabel("Import all 1 reviewed messages").check();
    await page.getByRole("button", { name: "Import reviewed messages" }).click();
    await expect(page.getByText("1 snapshots buffered")).toBeVisible();
    await page.reload(); await expect(page.getByText("1 snapshots buffered")).toHaveCount(0);
    await page.getByLabel("Buffer passphrase").fill("strong browser testing passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await expect(page.getByText("1 snapshots buffered")).toBeVisible();
    await page.getByRole("combobox", { name: "Conversation permission" }).selectOption({ index: 1 });
    await page.getByLabel("Separate transfer passphrase").fill("strong browser transfer passphrase");
    await page.getByLabel("Export this conversation").check();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download encrypted handoff" }).click();
    const download = await downloadPromise; const encrypted = JSON.parse(await readFile((await download.path())!, "utf8"));
    const batch = await decodeBatch(encrypted, "strong browser transfer passphrase", "owner");
    expect(batch.events).toHaveLength(1);
    await page.getByRole("button", { name: "Revoke permission" }).click();
    await expect(page.getByText("0 snapshots buffered")).toBeVisible();
    await page.getByRole("button", { name: "Lock now" }).click();
    await expect(page.getByLabel("Buffer passphrase")).toBeVisible();
    expect(errors).toEqual([]); expect(external).toEqual([]);
});

test("browser rejects an out-of-scope import without persisting it", async ({ page }) => {
    await page.goto("/"); await page.getByLabel("Buffer passphrase").fill("another browser test passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await page.getByLabel("I have authority").check(); await page.getByRole("button", { name: "Save permission" }).click();
    const sample = JSON.parse(await readFile("examples/manual-conversation.json", "utf8")); sample.messages[0].senderId = "999";
    await expect(page.getByLabel("Local JSON file")).toBeEnabled();
    await page.getByLabel("Local JSON file").setInputFiles({ name: "wrong.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(sample)) });
    await expect(page.getByRole("status")).toContainText("sender outside");
    await expect(page.getByText("0 snapshots buffered")).toBeVisible();
});

test("five-minute inactivity drops the unlocked session and clears an unimported preview", async ({ page }) => {
    await page.clock.install();
    await page.goto("/"); await page.getByLabel("Buffer passphrase").fill("idle lock testing passphrase");
    await page.getByRole("button", { name: "Create or unlock buffer" }).click();
    await page.getByLabel("I have authority").check(); await page.getByRole("button", { name: "Save permission" }).click();
    await expect(page.getByLabel("Local JSON file")).toBeEnabled();
    await page.getByLabel("Local JSON file").setInputFiles("examples/manual-conversation.json");
    await expect(page.locator("pre")).toContainText("Synthetic example");
    await page.clock.fastForward(300_001);
    await expect(page.getByLabel("Buffer passphrase")).toBeVisible();
    await expect(page.locator("pre")).toHaveCount(0);
    await expect(page.getByLabel("Buffer passphrase")).toHaveValue("");
});
