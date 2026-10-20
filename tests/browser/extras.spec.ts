import { test, expect } from "@playwright/test";

test("loaded selection and activity opt-in work through visible controls without changing password setup", async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto("http://127.0.0.1:4319?always=1");
    await page.getByLabel("Buffer passphrase").fill("synthetic extras testing password");
    await page.getByRole("button", { name: "Accept at my own risk and start collecting" }).click();
    await expect(page.getByText("0 records buffered")).toBeVisible();
    await page.getByText("Save messages already loaded in Discord", { exact: true }).click();
    await page.getByRole("button", { name: "Review loaded conversation" }).click();
    await expect(page.getByText(/synthetic cached text/)).toBeVisible();
    const save = page.getByRole("button", { name: "Save reviewed loaded messages" });
    await expect(save).toBeDisabled(); await page.getByLabel("I am authorized to save this loaded selection.").check(); await save.click();
    await expect(page.getByText("1 records buffered")).toBeVisible();
    await page.getByText("Scheduled events, presence and voice", { exact: true }).click();
    await page.getByLabel("Scheduled server events").check(); await page.getByLabel("Server IDs (comma separated)").fill("500");
    const choices = page.getByRole("button", { name: "Save activity choices" }); await expect(choices).toBeDisabled();
    await page.getByLabel("I confirm authority").check(); await choices.click();
    await expect(page.getByText(/Activity permission saved/)).toBeVisible();
    expect(await page.evaluate(() => (window as any).__liveFixture.activity())).toBe(1);
    await expect(page.getByText(/1 activity observations buffered/)).toBeVisible();
    await page.reload(); await expect(page.getByText(/Live: ALL conversations/)).toBeVisible();
    await page.getByText("Scheduled events, presence and voice", { exact: true }).click();
    await expect(page.getByLabel("Scheduled server events")).toBeChecked();
    await page.getByRole("button", { name: "Disable activity and erase observations" }).click();
    await expect(page.getByText(/Activity collection disabled/)).toBeVisible();
    await expect(page.getByText(/0 activity observations buffered/)).toBeVisible();
    expect(errors).toEqual([]);
});
