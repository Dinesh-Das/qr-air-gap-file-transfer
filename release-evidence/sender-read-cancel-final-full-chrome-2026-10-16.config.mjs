import {defineConfig} from '@playwright/test';
const config={
  "testDir": "D:\\MyProjects\\qrft-fresh-current-2026-10-14-haEoDP\\e2e",
  "timeout": 45000,
  "workers": 1,
  "use": {
    "channel": "chrome",
    "baseURL": "http://127.0.0.1:4178",
    "trace": "retain-on-failure"
  },
  "webServer": {
    "command": "node \"D:\\MyProjects\\qrft-fresh-current-2026-10-14-haEoDP\\validation\\sender-read-cancel-final-full-chrome-2026-10-16-server.mjs\"",
    "cwd": "D:\\MyProjects\\qrft-fresh-current-2026-10-14-haEoDP",
    "env": {
      "QRFT_PORT": "4178",
      "QRFT_SIGNAL_PORT": "4179"
    },
    "url": "http://127.0.0.1:4178",
    "reuseExistingServer": false,
    "stdout": "pipe",
    "stderr": "pipe"
  },
  "outputDir": "C:\\Users\\dines\\AppData\\Local\\Temp\\qrft-sender-read-cancel-final-gate-chrome-7UNLOK\\results"
};
const selected=new RegExp("saved source recovery checks the service|mixed dropped items transfer|selected files transfer preserves|sender recovery restores handles");
config.projects=[{name:'chrome-d-results',grep:selected,outputDir:"D:\\MyProjects\\qrft-sender-read-cancel-chrome-results-2026-10-16-vx5zOB\\results"},{name:'chrome-c-results',grepInvert:selected,outputDir:"C:\\Users\\dines\\AppData\\Local\\Temp\\qrft-sender-read-cancel-final-gate-chrome-7UNLOK\\results"}];
export default defineConfig(config);
