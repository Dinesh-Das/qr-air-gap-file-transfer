import { defineConfig } from "@playwright/test";
import { browserChannel } from "./e2e/browser-channel";

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  workers: 1,
  use: { channel: browserChannel, baseURL: "http://127.0.0.1:4178", trace: "retain-on-failure" },
  webServer: {
    command: "npm run serve",
    env: { QRFT_PORT: "4178", QRFT_SIGNAL_PORT: "4179" },
    url: "http://127.0.0.1:4178",
    reuseExistingServer: false,
  },
});
