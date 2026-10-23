import { defineConfig } from "@playwright/test";
const appPort = process.env.COLLECTOR_TEST_PORT ?? "4318", hostPort = process.env.COLLECTOR_HOST_TEST_PORT ?? "4319";
export default defineConfig({
    testDir: "./tests/browser", workers: 1,
    use: { baseURL: `http://127.0.0.1:${appPort}`, headless: true },
    webServer: [
        { command: "npm start", url: `http://127.0.0.1:${appPort}`, env: { COLLECTOR_PORT: appPort }, reuseExistingServer: false },
        { command: "node tests/browser/server.mjs", url: `http://127.0.0.1:${hostPort}`, env: { COLLECTOR_HOST_TEST_PORT: hostPort }, reuseExistingServer: false }
    ],
    reporter: "list"
});
