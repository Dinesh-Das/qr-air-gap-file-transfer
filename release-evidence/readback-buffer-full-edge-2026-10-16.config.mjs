import {defineConfig} from '@playwright/test';
export default defineConfig({
  "testDir": "D:\\MyProjects\\qrft-fresh-current-2026-10-14-haEoDP\\e2e",
  "timeout": 45000,
  "workers": 1,
  "use": {
    "channel": "msedge",
    "baseURL": "http://127.0.0.1:4178",
    "trace": "retain-on-failure"
  },
  "webServer": {
    "command": "node \"D:\\MyProjects\\qrft-fresh-current-2026-10-14-haEoDP\\validation\\readback-buffer-full-edge-2026-10-16-server.mjs\"",
    "cwd": "D:\\MyProjects\\qrft-fresh-current-2026-10-14-haEoDP",
    "env": {
      "QRFT_PORT": "4178",
      "QRFT_SIGNAL_PORT": "4179"
    },
    "url": "http://127.0.0.1:4178",
    "reuseExistingServer": false,
    "stdout": "pipe",
    "stderr": "pipe"
  }
});
