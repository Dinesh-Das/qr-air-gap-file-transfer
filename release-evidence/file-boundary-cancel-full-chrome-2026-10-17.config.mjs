import {defineConfig} from '@playwright/test';
export default defineConfig({
  "testDir": "C:\\Users\\dines\\AppData\\Local\\Temp\\qrft-fresh-current-2026-10-17-Oo61W0\\e2e",
  "timeout": 45000,
  "workers": 1,
  "use": {
    "channel": "chrome",
    "baseURL": "http://127.0.0.1:4178",
    "trace": "retain-on-failure"
  },
  "webServer": {
    "command": "node \"C:\\Users\\dines\\AppData\\Local\\Temp\\qrft-fresh-current-2026-10-17-Oo61W0\\validation\\file-boundary-cancel-full-chrome-2026-10-17-server.mjs\"",
    "cwd": "C:/Users/dines/AppData/Local/Temp/qrft-fresh-current-2026-10-17-Oo61W0",
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
