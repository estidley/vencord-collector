import { defineConfig } from "@playwright/test";
export default defineConfig({
    testDir: "./tests/browser", workers: 1,
    use: { baseURL: "http://127.0.0.1:4318", headless: true },
    webServer: [
        { command: "npm start", url: "http://127.0.0.1:4318", env: { COLLECTOR_PORT: "4318" }, reuseExistingServer: false },
        { command: "node tests/browser/server.mjs", url: "http://127.0.0.1:4319", reuseExistingServer: false }
    ],
    reporter: "list"
});
