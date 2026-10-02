import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, statfs } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// Diagnostic only. Retains persistent profiles and payloads for reinspection.
// A nonpersistent automation context is not proof of a native private window.
process.env.VITEST = '1';
const { createServer } = await import('vite');
const output = resolve(process.argv[2] ?? 'release-evidence/storage-context-2026-10-14.json');
const profileParent = resolve('.tmp/storage-context-profiles');
await mkdir(profileParent, { recursive: true });
const totalBytes = 128 * 1024 ** 2;
const blockSize = 60 * 1024;
const expectedHash = createHash('sha256');
for (let offset = 0; offset < totalBytes; offset += 1024 ** 2) {
  const bytes = Buffer.alloc(Math.min(1024 ** 2, totalBytes - offset));
  for (let index = 0; index < bytes.length; index++) bytes[index] = ((offset + index) * 31 + Math.floor((offset + index) / 4096)) & 255;
  expectedHash.update(bytes);
}
const expectedSha256 = expectedHash.digest('hex');
const report = { startedAt: new Date().toISOString(), node: process.version, totalBytes, blockSize, expectedSha256, reserveBytes: 2 * 1024 ** 3, trials: [], limitations: ['One-host OPFS storage diagnostic, not end-to-end transfer, Wi-Fi, native destination, OS crash or power loss.', 'Nonpersistent Playwright contexts are not evidence of native Edge InPrivate or Chrome Incognito user workflows.', '128 MiB does not prove 5 GiB, 50–100 GB+ capacity, memory bounds or quota behavior.', 'Persistent profiles and their payloads are retained; nonpersistent data lifetime is tested by closing and creating a fresh context.'] };
const prior = JSON.parse(await readFile('release-evidence/cancel-payload-review-2026-10-14.json', 'utf8'));
report.inputs = [];
for (const path of [...prior.currentInputs.map(file => file.path), 'scripts/diagnose-storage-context.mjs'].sort()) report.inputs.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
const server = await createServer({ configFile: false, appType: 'custom', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { entries: [], include: ['@noble/hashes/sha2.js'] } });
server.middlewares.use('/storage-diagnostic', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Storage diagnostic</title>');
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
report.origin = origin;
async function inspect(page, write) {
  await page.goto(origin + '/storage-diagnostic');
  return page.evaluate(async ({ totalBytes, blockSize, write }) => {
    const { openBlockStore } = await import('/src/lib/block-store.ts');
    const { sha256 } = await import('/node_modules/@noble/hashes/sha2.js');
    const store = await openBlockStore({ storeId: 'retained-context-diagnostic-v1', totalBytes, blockSize });
    try {
      const before = store.progress();
      if (write) {
        for (let first = 0; first < store.totalBlocks; first += 32) {
          const blocks = [];
          for (let index = first; index < Math.min(store.totalBlocks, first + 32); index++) {
            const offset = index * blockSize;
            const bytes = new Uint8Array(Math.min(blockSize, totalBytes - offset));
            for (let at = 0; at < bytes.length; at++) bytes[at] = ((offset + at) * 31 + Math.floor((offset + at) / 4096)) & 255;
            blocks.push({ index, bytes });
          }
          await store.writeBlocks(blocks);
        }
      }
      const progress = store.progress();
      let sha256Hex = null;
      let individuallyPresentBlocks = 0;
      for (let index = 0; index < store.totalBlocks; index++) if (store.hasBlock(index)) individuallyPresentBlocks += 1;
      if (progress.complete) {
        const hash = sha256.create();
        for (let offset = 0; offset < totalBytes; offset += 1024 ** 2) hash.update(await store.readRange(offset, Math.min(1024 ** 2, totalBytes - offset)));
        sha256Hex = Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('');
      }
      return { before, progress, individuallyPresentBlocks, sha256Hex, quota: await navigator.storage.estimate(), persisted: await navigator.storage.persisted() };
    } finally { await store.close(); }
  }, { totalBytes, blockSize, write });
}
function assertComplete(result) {
  if (!result.progress.complete || result.progress.receivedBytes !== totalBytes || result.individuallyPresentBlocks !== Math.ceil(totalBytes / blockSize) || result.sha256Hex !== expectedSha256) throw new Error('Receipt/independent SHA-256 check failed');
}
try {
  for (const channel of ['msedge', 'chrome']) for (const mode of ['persistent-profile', 'nonpersistent-context']) {
    const disks = [];
    for (const path of ['C:/', 'D:/']) {
      const disk = await statfs(path);
      const availableBytes = disk.bavail * disk.bsize;
      if (availableBytes < report.reserveBytes + totalBytes * 2) throw new Error(`Insufficient reserved space: ${path}`);
      disks.push({ path, availableBytes });
    }
    const trial = { channel, mode, disks, startedAt: new Date().toISOString() };
    report.trials.push(trial);
    const profile = mode === 'persistent-profile' ? await mkdtemp(join(profileParent, channel + '-')) : null;
    trial.profile = profile;
    let browser, context;
    try {
      if (profile) context = await chromium.launchPersistentContext(profile, { channel });
      else { browser = await chromium.launch({ channel }); context = await browser.newContext(); }
      trial.browserVersion = context.browser().version();
      const page = await context.newPage();
      trial.written = await inspect(page, true);
      assertComplete(trial.written);
      await page.close();
      trial.reopenedPage = await inspect(await context.newPage(), false);
      assertComplete(trial.reopenedPage);
      await context.close(); context = undefined;
      if (browser) { await browser.close(); browser = undefined; }
      if (profile) context = await chromium.launchPersistentContext(profile, { channel });
      else { browser = await chromium.launch({ channel }); context = await browser.newContext(); }
      trial.afterBrowserClose = await inspect(await context.newPage(), false);
      if (profile) assertComplete(trial.afterBrowserClose);
      else if (trial.afterBrowserClose.progress.receivedBytes !== 0 || trial.afterBrowserClose.individuallyPresentBlocks !== 0 || trial.afterBrowserClose.sha256Hex !== null) throw new Error('Fresh nonpersistent context unexpectedly retained prior receipt data');
      trial.passed = true;
      trial.completedAt = new Date().toISOString();
      console.log(JSON.stringify({ channel, mode, passed: true, afterBrowserCloseBytes: trial.afterBrowserClose.progress.receivedBytes, profile }));
    } catch (error) { trial.error = String(error); throw error; }
    finally { if (context) await context.close(); if (browser) await browser.close(); }
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  report.completedAt = new Date().toISOString();
} finally {
  await server.close();
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
