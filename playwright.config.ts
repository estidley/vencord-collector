import { defineConfig } from "@playwright/test";
export default defineConfig({
    testDir: "./tests/browser", workers: 1,
    use: { baseURL: "http://127.0.0.1:4317", headless: true },
    webServer: { command: "npm start", url: "http://127.0.0.1:4317", reuseExistingServer: false },
    reporter: "list"
});
