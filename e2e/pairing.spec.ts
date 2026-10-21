import { browserChannel } from "./browser-channel";
import { test, expect, chromium, type Page, type BrowserContext } from "@playwright/test";
import { createHash } from "node:crypto";
import { formatBytes } from "../src/lib/format";

async function setupPair(context: BrowserContext, alteredOffer = false, fileBytes = 120_000, realRuntime = false, manual = false, durableSource = false, selectFiles = false, dropSource = false, manyFiles = false, reuseSource = false) {
  let offer: { sessionId: string; sdp: string };
  let answer: { sessionId: string; sdp: string } | undefined;
  if (!realRuntime) await context.route("**/api/rendezvous/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown;
    if (request.method() === "DELETE") json = { ok: true };
    else if (path.endsWith("/health")) json = { ready: true, protocol: 2 };
    else if (path.endsWith("/rooms")) {
      answer = undefined;
      offer = request.postDataJSON();
      json = { roomId: "a".repeat(32), ownerToken: "b".repeat(64), code: "123456", expiresAt: Date.now() + 120_000 };
    } else if (path.endsWith("/join")) json = { joinId: "c".repeat(32), ...offer, sdp: offer.sdp + (alteredOffer ? "a=x-test:altered\r\n" : "") };
    else if (path.endsWith("/answer")) { answer = request.postDataJSON(); json = { ok: true }; }
    else json = answer ? { status: "answered", ...answer } : { status: "waiting" };
    await route.fulfill({ json });
  });
  await context.addInitScript(({ fileBytes, durableSource, manyFiles, reuseSource }) => {
    const state = window as unknown as {
      sentControls: Array<{ type: string }>; sentBytes: number; testChannel: RTCDataChannel; sourceReads: number;
      showDirectoryPicker: () => Promise<unknown>;
    };
    state.sentControls = [];
    state.sentBytes = 0;
    state.sourceReads = 0;
    const originalSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
      if (typeof data === "string") state.sentControls.push(JSON.parse(data));
      else state.sentBytes += data instanceof Blob ? data.size : data.byteLength;
      return Reflect.apply(originalSend, this, [data]);
    };
    const OriginalPeer = RTCPeerConnection;
    window.RTCPeerConnection = class extends OriginalPeer {
      constructor(config?: RTCConfiguration) {
        super(config);
        (window as unknown as { testPeer: RTCPeerConnection }).testPeer = this;
        this.addEventListener("datachannel", (event) => { state.testChannel = event.channel; });
      }
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options);
        state.testChannel = channel;
        return channel;
      }
    };
    const file = new File([new Uint8Array(fileBytes).fill(37)], "test.bin", { lastModified: 7 });
    const slice = file.slice.bind(file);
    file.slice = (...args) => { state.sourceReads += 1; return slice(...args); };
    state.showDirectoryPicker = async () => ({
      kind: "directory", name: "browser-fixture",
      async *entries() { yield [file.name, { kind: "file", name: file.name, getFile: async () => file }]; },
    });
    if (durableSource) state.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("browser-fixture", { create: true });
      const handle = await directory.getFileHandle("test.bin", { create: true });
      if (!reuseSource) {
        const writer = await handle.createWritable();
        await writer.write(new Uint8Array(fileBytes).fill(37));
        await writer.close();
      }
      return directory;
    };
    window.showOpenFilePicker = async () => {
      const directory = await state.showDirectoryPicker() as FileSystemDirectoryHandle;
      const empty = await directory.getFileHandle("empty.bin", { create: true });
      const writer = await empty.createWritable(); await writer.close();
      return [await directory.getFileHandle("test.bin"), empty];
    };
    if (manyFiles) state.showDirectoryPicker = async () => {
      const directory = (name: string, entries: Array<[string, unknown]>): unknown => ({
        kind: "directory", name, async *entries() { yield* entries; },
      });
      const groups: Array<[string, unknown]> = [];
      for (let group = 0; group < 12; group++) {
        const entries: Array<[string, unknown]> = [];
        for (let offset = 0; offset < 100; offset++) {
          const index = group * 100 + offset;
          const name = `file-${String(index).padStart(6, "0")}.bin`;
          const bytes = new Uint8Array(index % 10 === 0 ? 0 : 257);
          for (let n = 0; n < bytes.length; n++) bytes[n] = (index >>> ((n % 4) * 8)) ^ (n * 31);
          const file = new File([bytes], name, { lastModified: 7 });
          entries.push([name, { kind: "file", name, getFile: async () => file }]);
        }
        const name = `group-${String(group).padStart(2, "0")}`;
        groups.push([name, directory(name, entries)]);
      }
      groups.push(["empty", directory("empty", [["nested", directory("nested", [])]])]);
      return directory("many-files", groups);
    };
  }, { fileBytes, durableSource, manyFiles, reuseSource });
  const sender = await context.newPage();
  const receiver = await context.newPage();
  const errors: string[] = [];
  for (const page of [sender, receiver]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("/");
    await page.getByRole("button", { name: page === sender ? "Send" : "Receive", exact: true }).click();
  }
  await expect(sender.getByRole("button", { name: "Choose folder", exact: true })).toBeEnabled();
  if (dropSource) await sender.evaluate(async () => {
    const folder = await window.showDirectoryPicker!();
    await folder.getDirectoryHandle("empty", { create: true });
    const loose = await (await navigator.storage.getDirectory()).getFileHandle("loose.txt", { create: true });
    const writer = await loose.createWritable(); await writer.write("loose"); await writer.close();
    const handles = [folder, loose];
    const data = new DataTransfer();
    for (const handle of handles) data.items.add(new File([], handle.name));
    DataTransferItem.prototype.getAsFileSystemHandle = function() { return Promise.resolve(handles.find((handle) => handle.name === this.getAsFile()?.name) ?? null); };
    document.querySelector("#sender-workspace .workspace")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  else await sender.getByRole("button", { name: selectFiles ? "Choose files" : "Choose folder", exact: true }).click();
  await sender.getByRole("button", { name: "Get pairing code" }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText(/\d{3} \d{3}/);
  const pairingCode = (await sender.locator(".pairing-code-large").textContent())!.replace(/\s/g, "");
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill(pairingCode);
  if (manual) {
    await sender.getByText("Troubleshoot connection", { exact: true }).click();
    await receiver.getByText("Troubleshoot connection", { exact: true }).click();
    await receiver.getByRole("textbox", { name: "Sender address", exact: true }).fill("127.0.0.1:4179");
  }
  await receiver.getByRole("button", { name: "Connect to sender" }).click();
  for (const page of [sender, receiver]) await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
  return { sender, receiver, errors };
}

async function controls(page: Page) {
  return page.evaluate(() => (window as unknown as { sentControls: Array<{ type: string }> }).sentControls.map(({ type }) => type));
}

async function expectErrorDetails(page: Page, text: string | RegExp) {
  const details = page.locator(".transfer-error-details");
  await expect(details.locator("pre")).toBeHidden();
  await details.locator("summary").click();
  await expect(details.locator("pre")).toContainText(text);
}

test("temporary peer interruption updates both screens and disables confirmation until recovery", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  for (const page of [sender, receiver]) {
    // A snapshot may lack selected-candidate stats even when the channel is
    // connected. Reproduce that state, then request a fresh real snapshot.
    await page.evaluate(() => {
      const peer = (window as unknown as { testPeer: RTCPeerConnection }).testPeer;
      peer.getStats = async () => new Map() as RTCStatsReport;
    });
    const details = page.locator(".connection-diagnostics");
    await details.locator("summary").click();
    await expect(details.locator("dd").first()).toHaveText("connected");
    await expect(details.locator("dd").nth(3)).toHaveText("Unavailable");
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const peer = (window as unknown as { testPeer: RTCPeerConnection }).testPeer;
      delete (peer as unknown as { getStats?: unknown }).getStats;
    });
    await expect.poll(async () => {
      await details.getByRole("button", { name: "Refresh connection details" }).click();
      await expect(details.locator("dd").nth(3)).not.toHaveText("Reading…");
      return details.locator("dd").nth(3).textContent();
    }).toMatch(/^(UDP|TCP)$/);
    await page.evaluate(() => {
      const peer = (window as unknown as { testPeer: RTCPeerConnection }).testPeer;
      Object.defineProperty(peer, "connectionState", { configurable: true, value: "disconnected" });
      peer.dispatchEvent(new Event("connectionstatechange"));
    });
    await expect(page.getByText("Connection interrupted", { exact: true })).toBeVisible();
    await details.getByRole("button", { name: "Refresh connection details" }).click();
    await expect(details.locator("dd").first()).toHaveText("disconnected");
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeDisabled();
    await page.evaluate(() => {
      const peer = (window as unknown as { testPeer: RTCPeerConnection }).testPeer;
      delete (peer as unknown as { connectionState?: string }).connectionState;
      peer.dispatchEvent(new Event("connectionstatechange"));
    });
    await expect(page.getByText("Connection interrupted", { exact: true })).toHaveCount(0);
    await details.getByRole("button", { name: "Refresh connection details" }).click();
    await expect(details.locator("dd").first()).toHaveText("connected");
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      const peer = (window as unknown as { testPeer: RTCPeerConnection }).testPeer;
      peer.getStats = async () => { throw new Error("Injected unavailable diagnostics"); };
    });
    await details.getByRole("button", { name: "Refresh connection details" }).click();
    await expect(details.locator("dd").nth(3)).toHaveText("Unavailable");
    await expect(details.locator("dd").nth(4)).toHaveText("Unavailable");
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
  }
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const missing of ["webrtc", "opfs", "locks", "worker", "picker", "crypto", "subtle", "digest"] as const) test(`receiver preflight blocks missing ${missing} even after reconnect`, async ({ page }) => {
  let requests = 0;
  page.on("request", (request) => { if (request.url().includes("/api/rendezvous/") && !request.url().endsWith("/health")) requests++; });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((missing) => {
    if (missing === "webrtc") Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: undefined });
    if (missing === "opfs") Object.defineProperty(navigator.storage, "getDirectory", { configurable: true, value: undefined });
    if (missing === "locks") Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    if (missing === "worker") Object.defineProperty(window, "Worker", { configurable: true, value: undefined });
    if (missing === "picker") Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: undefined });
    if (missing === "crypto") Object.defineProperty(window, "crypto", { configurable: true, value: undefined });
    if (missing === "subtle") Object.defineProperty(crypto, "subtle", { configurable: true, value: undefined });
    if (missing === "digest") Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: undefined });
  }, missing);
  await page.goto("/");
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  const message = missing === "webrtc" ? "This browser cannot make a direct connection. Open this app in a current Edge or Chrome window."
    : missing === "picker" ? "This browser cannot choose a destination folder. Open this app in a current Edge or Chrome window."
    : "This browser cannot store transfer data safely. Open this app in a current Edge or Chrome window.";
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect to sender", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reconnect and resume", exact: true }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect to sender", exact: true })).toHaveCount(0);
  expect(requests).toBe(0);
  expect(errors).toEqual([]);
});

for (const missing of ["webrtc", "crypto", "subtle", "digest"] as const) test(`sender checks ${missing} support before reading source bytes or pairing`, async ({ page }) => {
  let requests = 0;
  page.on("request", (request) => { if (request.url().includes("/api/rendezvous/") && !request.url().endsWith("/health")) requests++; });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((missing) => {
    if (missing === "webrtc") Object.defineProperty(window, "RTCPeerConnection", { configurable: true, value: undefined });
    if (missing === "crypto") Object.defineProperty(window, "crypto", { configurable: true, value: undefined });
    if (missing === "subtle") Object.defineProperty(crypto, "subtle", { configurable: true, value: undefined });
    if (missing === "digest") Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: undefined });
    const state = window as unknown as { testSourceReads: number; testPickerCalls: number };
    state.testSourceReads = 0;
    state.testPickerCalls = 0;
    const file = new File(["source bytes"], "test.txt");
    const slice = file.slice.bind(file);
    file.slice = (...args) => { state.testSourceReads++; return slice(...args); };
    window.showDirectoryPicker = async () => {
      state.testPickerCalls++;
      return {
      kind: "directory", name: "unsupported-fixture",
      async *entries() { yield [file.name, { kind: "file", name: file.name, getFile: async () => file }]; },
      } as unknown as FileSystemDirectoryHandle;
    };
  }, missing);
  await page.goto("/");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose folder", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Choose files", exact: true })).toBeDisabled();
  await expect(page.getByText(missing === "webrtc"
    ? /This browser cannot make a direct connection/
    : /This browser cannot store transfer data safely/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { testSourceReads: number }).testSourceReads)).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { testPickerCalls: number }).testPickerCalls)).toBe(0);
  expect(requests).toBe(0);
  expect(errors).toEqual([]);
});

test("local service check blocks selection and connection until a successful retry", async ({ page }) => {
  let available = false;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/rendezvous/health", (route) => route.fulfill({
    status: available ? 200 : 503,
    json: available ? { ready: true, protocol: 2 } : { error: "Signaling bind unavailable for this test." },
  }));
  await page.goto("/");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Local connection unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Choose folder", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Choose files", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await expect(page.getByText("Local connection unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect to sender", exact: true })).toBeDisabled();
  available = true;
  await page.getByRole("button", { name: "Retry connection check", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect to sender", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Six-digit pairing code" })).toHaveValue("123456");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose folder", exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});

test("service loss before preparation reads no source bytes and retry retains selection", async ({ page }) => {
  let available = true;
  let rooms = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/rendezvous/health", (route) => route.fulfill({ status: available ? 200 : 503,
    json: available ? { ready: true, protocol: 2 } : { error: "The local connection service is unavailable." },
  }));
  await page.route("**/api/rendezvous/rooms", async (route) => {
    rooms++;
    if (!available) await route.fulfill({ status: 503, json: { error: "The local connection service is unavailable." } });
    else await route.continue();
  });
  await page.addInitScript(() => {
    const state = window as unknown as { reads: number; picks: number };
    state.reads = 0; state.picks = 0;
    const file = new File([new Uint8Array(120_000).fill(37)], "test.bin", { lastModified: 7 });
    const slice = file.slice.bind(file);
    file.slice = (...args) => { state.reads++; return slice(...args); };
    window.showDirectoryPicker = async () => {
      state.picks++;
      return { kind: "directory", name: "preflight-fixture",
        async *entries() { yield [file.name, { kind: "file", name: file.name, getFile: async () => file }]; },
      } as unknown as FileSystemDirectoryHandle;
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Choose folder", exact: true }).click();
  available = false;
  await page.getByRole("button", { name: "Get pairing code", exact: true }).click();
  await expect(page.getByRole("alert").getByText(/The local connection service is unavailable/)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { reads: number }).reads)).toBe(0);
  expect(rooms).toBe(0);
  available = true;
  await page.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(page.locator(".pairing-code-large")).toHaveText(/\d{3} \d{3}/);
  expect(await page.evaluate(() => (window as unknown as { reads: number }).reads)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as { picks: number }).picks)).toBe(1);
  expect(errors).toEqual([]);
});

test("saved source recovery checks the service before reading files and offers a direct retry", async () => {
  const context = await chromium.launchPersistentContext(test.info().outputPath("profile"), { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try {
  const { sender } = await setupPair(context, false, 120_000, false, false, true);
  await expect(sender.getByText(/Your selection is saved on this device/)).toBeVisible();
  let available = true;
  await sender.route("**/api/rendezvous/health", (route) => route.fulfill({ status: available ? 200 : 503,
    json: available ? { ready: true, protocol: 2 } : { error: "Service unavailable during recovery." },
  }));
  await sender.reload();
  await sender.getByRole("button", { name: "Send", exact: true }).click();
  await expect(sender.getByRole("button", { name: "Recover saved source", exact: true })).toBeEnabled();
  const errors: string[] = [];
  sender.on("pageerror", (error) => errors.push(error.message));
  await sender.evaluate(() => {
    const state = window as unknown as { recoveryReads: number };
    state.recoveryReads = 0;
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = function() { state.recoveryReads++; return getFile.call(this); };
  });
  available = false;
  await sender.getByRole("button", { name: "Recover saved source", exact: true }).click();
  await expect(sender.getByRole("alert").getByText(/The local connection service is unavailable/)).toBeVisible();
  expect(await sender.evaluate(() => (window as unknown as { recoveryReads: number }).recoveryReads)).toBe(0);
  available = true;
  await sender.getByRole("button", { name: "Retry source recovery", exact: true }).click();
  await expect(sender.getByText(/Saved source checked and verified/)).toBeVisible();
  expect(await sender.evaluate(() => (window as unknown as { recoveryReads: number }).recoveryReads)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("interrupted transfer keeps unverified progress visible and retries without rehashing", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context, false, 12 * 1024 * 1024);
  await receiver.evaluate(() => {
    const send = RTCDataChannel.prototype.send;
    let first = true;
    const state = window as unknown as { holdAcks: boolean };
    state.holdAcks = true;
    RTCDataChannel.prototype.send = function(data) {
      if (state.holdAcks && typeof data === "string" && JSON.parse(data).type === "ack") {
        if (!first) return;
        first = false;
      }
      return Reflect.apply(send, this, [data]);
    };
  });
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  const metric = (page: Page, label: string) => page.locator(".transfer-progress-card .metric").filter({ has: page.getByText(label, { exact: true }) }).locator("strong");
  await expect(metric(sender, "Sent safely")).not.toHaveText(/^0 B/);
  await expect(metric(receiver, "Received safely")).not.toHaveText(/^0 B/);
  await expect(metric(sender, "Elapsed this attempt")).not.toHaveText("00:00");
  await sender.evaluate(() => (window as unknown as { testChannel: RTCDataChannel }).testChannel.close());
  await expect(sender.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await expect(receiver.getByRole("button", { name: "Reconnect and resume", exact: true })).toBeVisible();
  const frozen = [];
  for (const page of [sender, receiver]) {
    await expect(page.locator(".transfer-progress-card").getByText("Transfer stopped", { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(page.getByRole("button", { name: page === sender ? "Retry connection" : "Reconnect and resume", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(metric(page, page === sender ? "Last sent" : "Last received")).not.toHaveText(/^0 B/);
    await expect(page.getByText("Devices connected", { exact: true })).toHaveCount(0);
    await expect(metric(page, "Recent speed")).toHaveText("—");
    await expect(metric(page, "Current speed")).toHaveText("—");
    await expect(metric(page, "Transfer ETA")).toHaveText("—");
    await expect(page.getByText("This attempt was not verified. Reconnect to check which data can be reused.", { exact: true })).toBeVisible();
    const details = page.locator(".transfer-error-details");
    await expect(details.locator("pre")).toBeHidden();
    await details.locator("summary").click();
    await expect(details.locator("pre")).toContainText(/connection closed/);
    frozen.push(await metric(page, "Elapsed this attempt").textContent());
    await page.screenshot({ path: test.info().outputPath(page === sender ? "sender-interrupted.png" : "receiver-interrupted.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.evaluate(() => document.querySelector(".transfer-status-panel")!.getBoundingClientRect().top < document.querySelector(".transfer-card > .panel:first-child")!.getBoundingClientRect().top)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(page === sender ? "sender-interrupted-narrow.png" : "receiver-interrupted-narrow.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await sender.waitForTimeout(1_200);
  for (const [index, page] of [sender, receiver].entries()) await expect(metric(page, "Elapsed this attempt")).toHaveText(frozen[index]!);
  const reads = await sender.evaluate(() => (window as unknown as { sourceReads: number }).sourceReads);
  await receiver.evaluate(() => { (window as unknown as { holdAcks: boolean }).holdAcks = false; });
  await sender.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
  expect(await sender.evaluate(() => (window as unknown as { sourceReads: number }).sourceReads)).toBe(reads);
  await expect(sender.locator(".transfer-error-details")).toHaveCount(0);
  await receiver.getByRole("button", { name: "Reconnect and resume", exact: true }).click();
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await receiver.getByRole("button", { name: "Connect to sender", exact: true }).click();
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  // This wait includes retransmission and final disk-backed hashing of 12 MiB.
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible({ timeout: 15_000 });
  await expect(sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.")).toBeVisible();
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("interrupted-output", { create: true });
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const saved = await receiver.evaluate(async () => {
    const output = await (await navigator.storage.getDirectory()).getDirectoryHandle("interrupted-output");
    const tree = await output.getDirectoryHandle("browser-fixture");
    const file = await (await tree.getFileHandle("test.bin")).getFile();
    const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return { size: file.size, hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") };
  });
  expect(saved).toEqual({ size: 12 * 1024 * 1024, hash: createHash("sha256").update(Buffer.alloc(12 * 1024 * 1024, 37)).digest("hex") });
  expect(errors).toEqual([]);
});

test("failed final verification never labels the recorded bytes as safe and retry replaces corrupt storage", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await receiver.evaluate(() => {
    const post = Worker.prototype.postMessage;
    const state = window as unknown as { storageCorrupted: boolean };
    state.storageCorrupted = false;
    Worker.prototype.postMessage = function(message, ...args) {
      if (!state.storageCorrupted && message.type === "write-payload") {
        new Uint8Array(message.bytes)[0] ^= 1;
        state.storageCorrupted = true;
      }
      return Reflect.apply(post, this, [message, ...args]);
    };
  });
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("alert")).toContainText("Received files could not be verified");
  expect(await receiver.evaluate(() => (window as unknown as { storageCorrupted: boolean }).storageCorrupted)).toBe(true);
  expect(await controls(receiver)).not.toContain("receiver-complete");
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toHaveCount(0);
  for (const page of [sender, receiver]) {
    await expect(page.locator(".transfer-progress-card")).toContainText("Transfer stopped");
    await expect(page.locator(".transfer-progress-card")).toContainText("100.0%");
    await expect(page.locator(".transfer-progress-card")).toContainText("This attempt was not verified");
    await expect(page.locator(".transfer-progress-card")).not.toContainText(/Sent safely|Received safely|Transfer verified/);
  }
  await expectErrorDetails(receiver, /failed integrity verification and was discarded/);
  await sender.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
  await receiver.getByRole("button", { name: "Reconnect and resume", exact: true }).click();
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await receiver.getByRole("button", { name: "Connect to sender", exact: true }).click();
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  expect(await controls(receiver)).not.toContain("resume-ranges");
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("corruption-recovery", { create: true });
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const digest = await receiver.evaluate(async () => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("corruption-recovery");
    const folder = await parent.getDirectoryHandle("browser-fixture");
    const file = await (await folder.getFileHandle("test.bin")).getFile();
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
  expect(digest).toBe(createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex"));
  expect(errors).toEqual([]);
});

test("storage worker quota errors show space recovery advice without acknowledging unwritten data", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await receiver.evaluate(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.type === "write-payload") {
        this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, ok: false, error: { name: "QuotaExceededError", message: "Synthetic OPFS write quota failure" } } }));
        return;
      }
      return Reflect.apply(post, this, [message, ...args]);
    };
  });
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("alert")).toContainText("not enough temporary browser storage");
  await expectErrorDetails(receiver, /QuotaExceededError: Synthetic OPFS write quota failure/);
  expect(await controls(receiver)).not.toContain("ack");
  expect(await controls(receiver)).not.toContain("receiver-complete");
  await expect(receiver.getByRole("button", { name: "Reconnect and resume", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const status of [404, 503]) test(`pairing failure ${status} shows recovery advice before technical details`, async ({ page }) => {
  const technical = "listen EADDRINUSE 0.0.0.0:4174; synthetic pairing fault";
  await page.route("**/api/rendezvous/health", (route) => route.fulfill({ json: { ready: true, protocol: 2 } }));
  await page.route("**/api/rendezvous/join", (route) => route.fulfill({ status, json: { error: technical } }));
  await page.goto("/");
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await page.getByRole("button", { name: "Connect to sender", exact: true }).click();
  await expect(page.getByText(status === 404
    ? "That pairing code is unavailable or expired. Get the sender’s current code and reconnect."
    : "The local connection service is unavailable. Reopen the app using its launcher, then retry.", { exact: true })).toBeVisible();
  await expect(page.getByText(technical, { exact: false })).toBeHidden();
  await page.getByText("Error details", { exact: true }).click();
  await expect(page.locator(".transfer-error-details pre")).toContainText(technical);
  await expect(page.getByRole("button", { name: "Reconnect and resume", exact: true })).toBeVisible();
});

test("transfer metrics retain byte totals and elapsed time through pause and verification", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context, false, 12 * 1024 * 1024);
  await receiver.evaluate(() => {
    const send = RTCDataChannel.prototype.send;
    const pending: Array<{ channel: RTCDataChannel; data: string }> = [];
    let first = true;
    let holding = true;
    RTCDataChannel.prototype.send = function(data) {
      if (holding && typeof data === "string" && JSON.parse(data).type === "ack") {
        if (!first) { pending.push({ channel: this, data }); return; }
        first = false;
      }
      return Reflect.apply(send, this, [data]);
    };
    (window as unknown as { releaseAcks: () => void }).releaseAcks = () => {
      holding = false;
      for (const item of pending) Reflect.apply(send, item.channel, [item.data]);
      pending.length = 0;
    };
  });
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  const speed = sender.locator(".metric").filter({ hasText: "Recent speed" }).locator("strong");
  const metric = (page: Page, label: string) => page.locator(".metric").filter({ has: page.getByText(label, { exact: true }) }).locator("strong");
  await expect(speed).toHaveText(/[0-9].*\/s/);
  await sender.setViewportSize({ width: 1280, height: 720 });
  await sender.evaluate(() => window.scrollTo(0, 0));
  await expect(sender.getByRole("button", { name: "Pause", exact: true })).toBeInViewport({ ratio: 1 });
  await sender.getByRole("button", { name: "Pause", exact: true }).click();
  for (const page of [sender, receiver]) {
    const elapsed = metric(page, "Elapsed this attempt");
    await expect(elapsed).toHaveText(/^\d{2}:\d{2}$/);
    const beforePause = await elapsed.textContent();
    await expect.poll(() => elapsed.textContent()).not.toBe(beforePause);
    await expect(metric(page, "Remaining bytes")).not.toHaveText("0 B");
    await expect(metric(page, "Resumed")).toHaveText("0 B");
    await expect(metric(page, page === sender ? "Sent safely" : "Received safely")).toHaveText(/.+ of 12 MB/);
    await page.screenshot({ path: test.info().outputPath(page === sender ? "sender-progress.png" : "receiver-progress.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(page === sender ? "sender-progress-narrow.png" : "receiver-progress-narrow.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await expect(speed).toHaveText("—");
  await expect(metric(sender, "Current speed")).toHaveText("—");
  await expect(metric(sender, "Transfer ETA")).toHaveText("—");
  await sender.getByRole("button", { name: "Resume", exact: true }).click();
  await receiver.evaluate(() => (window as unknown as { releaseAcks: () => void }).releaseAcks());
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await expect(sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.")).toBeVisible();
  const stopped = [];
  for (const page of [sender, receiver]) {
    await expect(metric(page, "Remaining bytes")).toHaveText("0 B");
    await expect(metric(page, page === sender ? "Sent safely" : "Received safely")).toHaveText("12 MB of 12 MB");
    stopped.push(await metric(page, "Elapsed this attempt").textContent());
  }
  // Span more than two timer ticks to prove the verified attempt stays frozen.
  await sender.waitForTimeout(1_200);
  for (const [index, page] of [sender, receiver].entries()) {
    await expect(metric(page, "Elapsed this attempt")).toHaveText(stopped[index]!);
  }
  await sender.getByRole("button", { name: "New transfer", exact: true }).click();
  await expect(metric(sender, "Elapsed this attempt")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("receiver storage readiness refreshes and distinguishes unknown estimates", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    navigator.storage.estimate = async () => ({ quota: 10 * 1024 * 1024, usage: 2 * 1024 * 1024 });
    navigator.storage.persisted = async () => false;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  const readiness = page.locator('[aria-label="Receiver storage readiness"]');
  await expect(readiness).toContainText("8.0 MB estimated free");
  await expect(readiness).toContainText("may be evicted");
  await page.evaluate(() => { navigator.storage.estimate = async () => { throw new Error("Unavailable"); }; });
  await readiness.getByRole("button", { name: "Refresh storage check" }).click();
  await expect(readiness).toContainText("could not report available space");
  await expect(readiness).not.toContainText("8.0 MB");
  await page.evaluate(() => {
    navigator.storage.estimate = async () => ({});
    navigator.storage.persisted = async () => { throw new Error("Unsupported"); };
  });
  await readiness.getByRole("button", { name: "Refresh storage check" }).click();
  await expect(readiness).toContainText("Available browser space is unknown");
  await expect(readiness).toContainText("persistence status is unknown");
  expect(errors).toEqual([]);
});

test("mixed dropped items transfer and a busy sender ignores another drop", async () => {
  const context = await chromium.launchPersistentContext(test.info().outputPath("profile"), { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try {
    const { sender, receiver, errors } = await setupPair(context, false, 120_000, false, false, true, false, true);
    await expect(sender.getByText(/Your selection is saved on this device/)).toBeVisible();
    const captured = await sender.evaluate(() => {
      let calls = 0;
      DataTransferItem.prototype.getAsFileSystemHandle = async () => { calls++; throw new Error("Busy drop must not acquire handles"); };
      const data = new DataTransfer(); data.items.add(new File([], "unwanted.txt"));
      document.querySelector("#sender-workspace .workspace")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      return calls;
    });
    expect(captured).toBe(0);
    await sender.getByRole("button", { name: "Codes match", exact: true }).click();
    await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
    await receiver.evaluate(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("dropped-output", { create: true });
    });
    await receiver.getByRole("button", { name: "Choose destination and save" }).click();
    await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
    const saved = await receiver.evaluate(async () => {
      const output = await (await navigator.storage.getDirectory()).getDirectoryHandle("dropped-output");
      const tree = await output.getDirectoryHandle("Selected items");
      const folder = await tree.getDirectoryHandle("browser-fixture");
      await folder.getDirectoryHandle("empty");
      const loose = await (await tree.getFileHandle("loose.txt")).getFile();
      const file = await (await folder.getFileHandle("test.bin")).getFile();
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return { loose: await loose.text(), size: file.size,
        hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") };
    });
    expect(saved).toEqual({ loose: "loose", size: 120_000, hash: createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex") });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("repeated save clicks open one picker and block navigation until the verified save finishes", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  const save = receiver.getByRole("button", { name: "Choose destination and save", exact: true });
  await expect(save).toBeVisible();
  await receiver.evaluate(() => {
    const state = window as unknown as { savePickerCalls: number; destinationWrites: number; releaseSavePicker: () => void };
    state.savePickerCalls = 0;
    state.destinationWrites = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.releaseSavePicker = release;
    window.showDirectoryPicker = async () => {
      state.savePickerCalls++;
      await gate;
      return (await navigator.storage.getDirectory()).getDirectoryHandle("single-save-output", { create: true });
    };
    const createWritable = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function(options) {
      if (this.name === "test.bin") state.destinationWrites++;
      return Reflect.apply(createWritable, this, [options]);
    };
  });
  // Same-turn clicks exercise the synchronous guard before React removes the button.
  await save.evaluate((button) => {
    if (!(button instanceof HTMLButtonElement)) throw new Error("Expected the destination save button.");
    button.click(); button.click(); button.click();
  });
  await expect.poll(() => receiver.evaluate(() => (window as unknown as { savePickerCalls: number }).savePickerCalls)).toBe(1);
  await expect(receiver.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(receiver.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
  expect(await receiver.evaluate(() => (window as unknown as { destinationWrites: number }).destinationWrites)).toBe(0);
  await receiver.evaluate(() => (window as unknown as { releaseSavePicker: () => void }).releaseSavePicker());
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  await expect(receiver.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(receiver.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
  const result = await receiver.evaluate(async () => {
    const state = window as unknown as { savePickerCalls: number; destinationWrites: number };
    const destination = await (await navigator.storage.getDirectory()).getDirectoryHandle("single-save-output");
    const tree = await destination.getDirectoryHandle("browser-fixture");
    const file = await (await tree.getFileHandle("test.bin")).getFile();
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return { pickerCalls: state.savePickerCalls, writes: state.destinationWrites, size: file.size,
      sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
  });
  expect(result).toEqual({ pickerCalls: 1, writes: 1, size: 120_000, sha256: createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex") });
  expect(errors).toEqual([]);
});

test("selected files transfer preserves names, bytes and empty files", async () => {
  const context = await chromium.launchPersistentContext(test.info().outputPath("profile"), { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try {
    const { sender, receiver, errors } = await setupPair(context, false, 120_000, false, false, true, true);
    await expect(sender.getByText(/Your selection is saved on this device/)).toBeVisible();
    await sender.getByRole("button", { name: "Codes match", exact: true }).click();
    await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
    await receiver.evaluate(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("selected-output", { create: true });
    });
    await receiver.getByRole("button", { name: "Choose destination and save" }).click();
    await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
    const saved = await receiver.evaluate(async () => {
      const output = await (await navigator.storage.getDirectory()).getDirectoryHandle("selected-output");
      const tree = await output.getDirectoryHandle("Selected files");
      const names = []; for await (const [name] of tree.entries()) names.push(name);
      const file = await (await tree.getFileHandle("test.bin")).getFile();
      const empty = await (await tree.getFileHandle("empty.bin")).getFile();
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return { names: names.sort(), empty: empty.size, size: file.size,
        hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") };
    });
    expect(saved).toEqual({ names: ["empty.bin", "test.bin"], empty: 0, size: 120_000,
      hash: createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex") });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("aborted sender checkpoint transactions do not prevent verified transfer", async ({ context }) => {
  await context.addInitScript(() => {
    const getAll = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function(...args) {
      const request = Reflect.apply(getAll, this, args);
      if (this.transaction.db.name === "airgap-webrtc-sender") this.transaction.abort();
      return request;
    };
  });
  const { sender, receiver, errors } = await setupPair(context);
  await expect(sender.getByText(/could not be saved for reload recovery/)).toBeVisible();
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const crashBrowser of [false, true]) for (const selectedFiles of [false, true]) test(`sender recovery restores handles and refuses changed source (file selection: ${selectedFiles}, browser crash: ${crashBrowser})`, async () => {
  // Persisted filesystem handles are tested in a normal browser profile.
  const profile = test.info().outputPath("profile");
  let context = await chromium.launchPersistentContext(profile, { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try {
  await context.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      const directory = await root.getDirectoryHandle("sender-recovery-fixture", { create: true });
      const handle = await directory.getFileHandle("file.txt", { create: true });
      const writer = await handle.createWritable();
      await writer.write("alpha");
      await writer.close();
      return directory;
    };
    window.showOpenFilePicker = async () => [await (await window.showDirectoryPicker!()).getFileHandle("file.txt")];
  });
  let page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: selectedFiles ? "Choose files" : "Choose folder", exact: true }).click();
  await page.getByRole("button", { name: "Get pairing code" }).click();
  await expect(page.locator(".pairing-code-large")).toHaveText(/\d{3} \d{3}/);
  await expect(page.getByText(/Your selection is saved on this device/)).toBeVisible();
  if (crashBrowser) {
    const browser = context.browser()!;
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    const browserProcess = processInfo.find((entry) => entry.type === "browser");
    expect(browserProcess).toBeDefined();
    const pid = browserProcess!.id;
    expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
    // This PID comes from the dedicated test browser, never a process-name search.
    const disconnected = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
    process.kill(pid, "SIGKILL");
    await disconnected;
    context = await chromium.launchPersistentContext(profile, { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
    page = await context.newPage();
    await page.goto("/");
  } else await page.reload();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.evaluate(() => {
    const query = FileSystemHandle.prototype.queryPermission;
    const request = FileSystemHandle.prototype.requestPermission;
    const getFile = FileSystemFileHandle.prototype.getFile;
    const state = window as unknown as { recoveryReads: number; restorePermissions: () => void };
    state.recoveryReads = 0;
    FileSystemHandle.prototype.queryPermission = async () => "prompt";
    FileSystemHandle.prototype.requestPermission = async () => "denied";
    FileSystemFileHandle.prototype.getFile = function() { state.recoveryReads++; return getFile.call(this); };
    state.restorePermissions = () => {
      FileSystemHandle.prototype.queryPermission = query;
      FileSystemHandle.prototype.requestPermission = request;
      FileSystemFileHandle.prototype.getFile = getFile;
    };
  });
  await page.getByRole("button", { name: "Recover saved source", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Reading the source files was not allowed. Choose them again and allow access.");
  await expectErrorDetails(page, "NotAllowedError: Allow read access to the saved source to resume.");
  expect(await page.evaluate(() => (window as unknown as { recoveryReads: number }).recoveryReads)).toBe(0);
  await expect(page.locator(".pairing-code-large")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { restorePermissions: () => void }).restorePermissions());
  await page.getByRole("button", { name: "New transfer", exact: true }).click();
  await page.getByRole("button", { name: "Recover saved source", exact: true }).click();
  await expect(page.getByText(/Saved source checked and verified/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle("sender-recovery-fixture");
    const file = await directory.getFileHandle("file.txt");
    const writer = await file.createWritable(); await writer.write("bravo"); await writer.close();
  });
  await page.reload();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Recover saved source", exact: true }).click();
  await expect(page.getByRole("alert").getByText(/The saved source changed/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Codes match", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "New transfer", exact: true }).click();
  await page.getByRole("button", { name: "Discard saved source", exact: true }).click();
  await expect(page.getByText("Saved source discarded.", { exact: true })).toBeVisible();
  await page.reload();
  expect(await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open("airgap-webrtc-sender", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const count = database.transaction("sources", "readonly").objectStore("sources").count();
      count.onsuccess = () => { database.close(); resolve(count.result); };
      count.onerror = () => { database.close(); reject(count.error); };
    };
  }))).toBe(0);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recover saved source", exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

for (const manual of [false, true]) test(`production HTTP runtime pairs browsers (manual address: ${manual})`, async ({ context }) => {
  const requests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  // Block external HTTP requests while retaining the real local signaling runtime.
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== "http://127.0.0.1:4178") await route.abort("blockedbyclient");
    else await route.continue();
  });
  const { sender, receiver, errors } = await setupPair(context, false, 120_000, true, manual);
  expect(await controls(sender)).toEqual([]);
  expect(await controls(receiver)).toEqual([]);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await expect(sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.")).toBeVisible();
  expect(requests.some((url) => new URL(url).pathname.startsWith("/api/rendezvous/"))).toBe(true);
  expect(requests.some((url) => new URL(url).pathname.startsWith("/assets/"))).toBe(true);
  expect(requests.filter((url) => new URL(url).origin !== "http://127.0.0.1:4178")).toEqual([]);
  for (const page of [sender, receiver]) {
    const iceServers = await page.evaluate(() => (window as unknown as { testPeer: RTCPeerConnection }).testPeer.getConfiguration().iceServers ?? []);
    expect(iceServers).toEqual([]);
  }
  await test.info().attach("application-request-audit", { body: JSON.stringify({ manual, requests }, null, 2), contentType: "application/json" });
  expect(errors).toEqual([]);
});

test("a connection below the block-message limit gives browser recovery advice before any manifest", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await sender.evaluate(() => {
    Object.defineProperty((window as unknown as { testPeer: RTCPeerConnection }).testPeer, "sctp", {
      configurable: true, value: { maxMessageSize: 1024 },
    });
  });
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(sender.getByRole("alert")).toContainText("Open both laptops in current Edge or Chrome");
  expect(await controls(sender)).not.toContain("manifest");
  expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
  expect(errors).toEqual([]);
});

test("real WebRTC and OPFS transfer waits for both human confirmations", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await expect(sender.getByRole("button", { name: "Receive", exact: true })).toBeDisabled();
  await expect(receiver.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  for (const page of [sender, receiver]) await expect(page.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
  expect(await sender.getByLabel("Device verification code").textContent()).toBe(await receiver.getByLabel("Device verification code").textContent());
  expect(await controls(sender)).toEqual([]);
  expect(await controls(receiver)).toEqual([]);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(sender.getByRole("status")).toContainText("Waiting for confirmation");
  expect(await controls(sender)).toEqual(["peer-confirmed"]);
  expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await expect(sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.")).toBeVisible();
  await expect(sender.getByRole("button", { name: "Home", exact: true })).toBeEnabled();
  expect(await controls(sender)).toContain("manifest");
  expect(await controls(receiver)).toContain("receiver-complete");
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => {
      throw new DOMException("Synthetic destination quota failure", "QuotaExceededError");
    };
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByText(/Files remain verified in temporary storage/)).toBeVisible();
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-destination", { create: true });
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const savedHash = await receiver.evaluate(async () => {
    const destination = await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-destination");
    const tree = await destination.getDirectoryHandle("browser-fixture");
    const file = await (await tree.getFileHandle("test.bin")).getFile();
    const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
  expect(savedHash).toBe(createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex"));
  expect(errors).toEqual([]);
});

for (const retainPrefix of [true, false]) test(`oversized OPFS journal recovers without manual repair (valid prefix: ${retainPrefix})`, async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  const originalWireBytes = await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes);
  await receiver.reload();
  await receiver.evaluate(async (retainPrefix) => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("qr-air-gap-block-store-v1");
    for await (const [name, handle] of parent.entries()) {
      if (handle.kind !== "directory") continue;
      const journal = await (handle as FileSystemDirectoryHandle).getFileHandle("receipt.journal");
      const bytes = new Uint8Array(await (await journal.getFile()).arrayBuffer());
      const corrupt = new Uint8Array(300_000);
      if (retainPrefix) corrupt.set(bytes);
      const writer = await journal.createWritable();
      await writer.write(corrupt.buffer);
      await writer.close();
      return;
    }
    throw new Error("Expected native OPFS store");
  }, retainPrefix);
  await receiver.addInitScript(() => {
    const state = window as unknown as { receiptBodyReads: number; receiptSliceSizes: number[] };
    state.receiptBodyReads = 0;
    state.receiptSliceSizes = [];
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function() {
      if (this.name === "receipt.journal") state.receiptBodyReads++;
      return read.call(this);
    };
    const slice = File.prototype.slice;
    File.prototype.slice = function(start, end, type) {
      const blob = slice.call(this, start, end, type);
      if (this.name === "receipt.journal") {
        const read = blob.arrayBuffer.bind(blob);
        Object.defineProperty(blob, "arrayBuffer", { value: () => {
          state.receiptSliceSizes.push(blob.size);
          return read();
        } });
      }
      return blob;
    };
  });
  const reconnect = async () => {
    await receiver.reload();
    await sender.reload();
    await sender.getByRole("button", { name: "Send", exact: true }).click();
    await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
    await sender.getByRole("button", { name: "Get pairing code" }).click();
    await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
    await receiver.getByRole("button", { name: "Receive", exact: true }).click();
    await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
    await receiver.getByRole("button", { name: "Connect to sender" }).click();
    for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  };
  await reconnect();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await expect(receiver.getByRole("alert")).not.toBeVisible();
  expect(await receiver.evaluate(() => (window as unknown as { receiptBodyReads: number }).receiptBodyReads)).toBe(0);
  const sizes = await receiver.evaluate(() => (window as unknown as { receiptSliceSizes: number[] }).receiptSliceSizes);
  expect(sizes).toHaveLength(1);
  expect(sizes[0]).toBeGreaterThan(0);
  expect(sizes[0]).toBeLessThan(300_000);
  expect(await controls(receiver)).toContain("receiver-complete");
  if (retainPrefix) expect(await controls(receiver)).not.toContain("ack");
  expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(retainPrefix ? 0 : originalWireBytes);
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-receipt-destination", { create: true });
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const savedHash = await receiver.evaluate(async () => {
    const destination = await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-receipt-destination");
    const tree = await destination.getDirectoryHandle("browser-fixture");
    const file = await (await tree.getFileHandle("test.bin")).getFile();
    const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  });
  expect(savedHash).toBe(createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex"));
  expect(errors).toEqual([]);
});

for (const damage of ["checkpoints", "payload"] as const) test(`unusable receive copy can be discarded and re-received (damage: ${damage})`, async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  const wireBytes = await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes);
  await receiver.reload();
  await receiver.evaluate(async damage => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("qr-air-gap-block-store-v1");
    for await (const [, handle] of parent.entries()) {
      if (handle.kind !== "directory") continue;
      const directory = handle as FileSystemDirectoryHandle;
      const names = damage === "checkpoints" ? ["checkpoint-0.qbs", "checkpoint-1.qbs"] : ["payload.bin"];
      for (const name of names) {
        const file = await directory.getFileHandle(name, { create: true });
        const writer = await file.createWritable();
        await writer.write(new Uint8Array(damage === "checkpoints" ? [1, 2, 3] : []).buffer);
        await writer.close();
      }
    }
    const sibling = await parent.getDirectoryHandle("unrelated-test-copy", { create: true });
    const writer = await (await sibling.getFileHandle("sentinel", { create: true })).createWritable();
    await writer.write(new Uint8Array([42]).buffer); await writer.close();
  }, damage);
  const pairAgain = async (reloadReceiver: boolean) => {
    if (reloadReceiver) await receiver.reload();
    await sender.reload();
    await sender.getByRole("button", { name: "Send", exact: true }).click();
    await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
    await sender.getByRole("button", { name: "Get pairing code" }).click();
    await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
    if (reloadReceiver) await receiver.getByRole("button", { name: "Receive", exact: true }).click();
    await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
    await receiver.getByRole("button", { name: "Connect to sender" }).click();
    for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  };
  await pairAgain(true);
  await expect(receiver.getByRole("alert")).toBeVisible();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).not.toBeVisible();
  expect(await controls(receiver)).not.toContain("receiver-complete");
  const discard = receiver.getByRole("button", { name: "Discard unusable transfer copy", exact: true });
  if (damage === "checkpoints") {
    await receiver.evaluate(() => {
      const state = window as unknown as { discardCalls: number; releaseDiscard: () => void };
      state.discardCalls = 0;
      const remove = FileSystemDirectoryHandle.prototype.removeEntry;
      let armed = true;
      FileSystemDirectoryHandle.prototype.removeEntry = async function(name, options) {
        if (armed && this.name === "qr-air-gap-block-store-v1" && name.startsWith("s-")) {
          state.discardCalls++;
          if (state.discardCalls === 1) throw new Error("Injected discard failure");
          await new Promise<void>(resolve => { state.releaseDiscard = resolve; });
          armed = false;
        }
        return remove.call(this, name, options);
      };
    });
    await discard.click();
    await expect(receiver.getByRole("alert")).toContainText("could not be removed");
    await discard.evaluate(element => {
      (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click();
    });
    await expect(receiver.getByText("Removing the unusable transfer copy…", { exact: true })).toBeVisible();
    await expect(receiver.getByRole("button", { name: "Home", exact: true })).toBeDisabled();
    expect(await receiver.evaluate(() => (window as unknown as { discardCalls: number }).discardCalls)).toBe(2);
    await receiver.evaluate(() => (window as unknown as { releaseDiscard: () => void }).releaseDiscard());
  } else await discard.click();
  await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toBeVisible();
  const sentinel = await receiver.evaluate(async () => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("qr-air-gap-block-store-v1");
    const directory = await parent.getDirectoryHandle("unrelated-test-copy");
    const file = await (await directory.getFileHandle("sentinel")).getFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  });
  expect(sentinel).toEqual([42]);
  await pairAgain(false);
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(wireBytes);
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-discard-destination", { create: true });
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const hash = await receiver.evaluate(async () => {
    const tree = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-discard-destination")).getDirectoryHandle("browser-fixture");
    const file = await (await tree.getFileHandle("test.bin")).getFile();
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
  });
  expect(hash).toBe(createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex"));
  expect(errors).toEqual([]);
});

for (const target of ["sender", "receiver"] as const) for (const lateType of ["duplicate-completion", "error", "cancel"] as const) {
  test(`verified receive survives a queued ${lateType} callback on ${target}`, async ({ context }) => {
    const { sender, receiver, errors } = await setupPair(context);
    for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
    const sourceSuccess = sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.");
    await expect(sourceSuccess).toBeVisible();
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
    const page = target === "sender" ? sender : receiver;
    await page.evaluate(({ target, lateType }) => {
      const channel = (window as unknown as { testChannel: RTCDataChannel }).testChannel;
      if (channel.readyState !== "closed") throw new Error("Expected the completed connection to be closed.");
      const message = lateType === "duplicate-completion"
        ? { type: target === "sender" ? "receiver-complete" : "sender-complete" }
        : lateType === "error" ? { type: "error", message: "Late synthetic peer error" }
        : { type: "cancel", reason: "Late synthetic peer cancellation" };
      // Invoke the real retained listener deterministically, modelling a callback
      // queued before channel close. This does not send new packets after close.
      channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }, { target, lateType });
    await expect(sourceSuccess).toBeVisible();
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
    await receiver.evaluate(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("queued-callback-destination", { create: true });
    });
    await receiver.getByRole("button", { name: "Choose destination and save" }).click();
    await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
    const saved = await receiver.evaluate(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("queued-callback-destination");
      const tree = await root.getDirectoryHandle("browser-fixture");
      const file = await (await tree.getFileHandle("test.bin")).getFile();
      const bytes = await file.arrayBuffer();
      return { size: file.size, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("") };
    });
    expect(saved).toEqual({ size: 120_000, sha256: createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex") });
    expect(errors).toEqual([]);
  });
}

for (const stage of ["saving", "saved"] as const) test(`verified receive survives a queued error callback while ${stage}`, async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await receiver.evaluate(({ stage }) => {
    window.showDirectoryPicker = stage === "saved"
      ? async () => (await navigator.storage.getDirectory()).getDirectoryHandle("late-save-destination", { create: true })
      : () => new Promise<FileSystemDirectoryHandle>(resolve => {
        (window as unknown as { releasePicker: () => Promise<void> }).releasePicker = async () => {
          resolve(await (await navigator.storage.getDirectory()).getDirectoryHandle("late-save-destination", { create: true }));
        };
      });
  }, { stage });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  if (stage === "saving") await expect(receiver.getByRole("button", { name: "Stop and reconnect" })).toBeVisible();
  else await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  await receiver.evaluate(() => {
    const channel = (window as unknown as { testChannel: RTCDataChannel }).testChannel;
    if (channel.readyState !== "closed") throw new Error("Expected the verified connection to be closed.");
    channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "error", message: "Late synthetic peer error" }) }));
  });
  if (stage === "saving") {
    await expect(receiver.getByRole("button", { name: "Stop and reconnect" })).toBeVisible();
    await receiver.evaluate(() => (window as unknown as { releasePicker: () => Promise<void> }).releasePicker());
  }
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const saved = await receiver.evaluate(async () => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("late-save-destination");
    const root = await parent.getDirectoryHandle("browser-fixture");
    const file = await (await root.getFileHandle("test.bin")).getFile();
    return { size: file.size, hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("") };
  });
  expect(saved).toEqual({ size: 120_000, hash: createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex") });
  expect(errors).toEqual([]);
});

for (const outcome of ["success", "failure"] as const) for (const leave of [false, true]) {
  test(`temporary storage cleanup retry drains safely (${outcome}, receive more: ${leave})`, async ({ context }) => {
    const { sender, receiver, errors } = await setupPair(context);
    for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
    await receiver.evaluate(({ outcome }) => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("cleanup-retry-destination", { create: true });
      const original = FileSystemDirectoryHandle.prototype.removeEntry;
      (window as unknown as { restoreCleanup: () => void }).restoreCleanup = () => { FileSystemDirectoryHandle.prototype.removeEntry = original; };
      let attempts = 0;
      FileSystemDirectoryHandle.prototype.removeEntry = async function(name, options) {
        if (this.name !== "qr-air-gap-block-store-v1") return original.call(this, name, options);
        attempts += 1;
        if (attempts === 1) throw new DOMException("Synthetic initial cleanup failure", "NotAllowedError");
        (window as unknown as { cleanupPending: boolean }).cleanupPending = true;
        await new Promise<void>(resolve => { (window as unknown as { releaseCleanup: () => void }).releaseCleanup = resolve; });
        if (outcome === "failure") throw new DOMException("Synthetic retry cleanup failure", "NotAllowedError");
        return original.call(this, name, options);
      };
    }, { outcome });
    await receiver.getByRole("button", { name: "Choose destination and save" }).click();
    const complete = receiver.getByRole("heading", { name: "Transfer complete", exact: true });
    const retry = receiver.getByRole("button", { name: "Retry temporary storage cleanup", exact: true });
    await expect(complete).toBeVisible();
    await expect(retry).toBeVisible();
    await retry.click();
    await expect.poll(() => receiver.evaluate(() => (window as unknown as { cleanupPending?: boolean }).cleanupPending)).toBe(true);
    if (leave) {
      await receiver.getByRole("button", { name: "Receive more files", exact: true }).click();
    }
    const contended = await receiver.evaluate(async () => {
      const leases = (await navigator.locks.query()).held!.filter(lock => lock.name?.startsWith("airgap-qr-block-store-v1:") && lock.mode === "exclusive");
      if (leases.length !== 1) throw new Error(`Expected one held transfer-store lease, found ${leases.length}.`);
      return navigator.locks.request(leases[0].name!, { mode: "exclusive", ifAvailable: true }, lock => Boolean(lock));
    });
    expect(contended).toBe(false);
    if (leave) {
      // The store's lifetime lock must remain owned until the pending deletion
      // has settled. Reset must not open another transfer over this operation.
      await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toHaveCount(0);
    }
    await receiver.evaluate(() => (window as unknown as { releaseCleanup: () => void }).releaseCleanup());
    if (leave) {
      await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toBeVisible();
      await expect(receiver.locator(".transfer-problem")).toHaveCount(0);
      await expect(retry).toHaveCount(0);
    } else if (outcome === "success") {
      await expect(receiver.getByText("Temporary browser storage was reclaimed.", { exact: false })).toBeVisible();
      await expect(retry).toHaveCount(0);
    } else {
      await expect(complete).toBeVisible();
      await expect(retry).toBeVisible();
      await expectErrorDetails(receiver, "Synthetic retry cleanup failure");
    }
    const result = await receiver.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const parent = await root.getDirectoryHandle("cleanup-retry-destination");
      const tree = await parent.getDirectoryHandle("browser-fixture");
      const file = await (await tree.getFileHandle("test.bin")).getFile();
      const cache = await root.getDirectoryHandle("qr-air-gap-block-store-v1");
      let transferDirectories = 0;
      for await (const [, handle] of cache.entries()) if (handle.kind === "directory") transferDirectories += 1;
      const heldStoreLeases = (await navigator.locks.query()).held!.filter(lock => lock.name?.startsWith("airgap-qr-block-store-v1:") && lock.mode === "exclusive").length;
      return { size: file.size, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join(""), transferDirectories, heldStoreLeases };
    });
    expect(result).toEqual({ size: 120_000, sha256: createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex"), transferDirectories: outcome === "success" ? 0 : 1, heldStoreLeases: outcome === "failure" && !leave ? 1 : 0 });
    if (leave) {
      await receiver.evaluate(() => (window as unknown as { restoreCleanup: () => void }).restoreCleanup());
      await sender.getByRole("button", { name: "New transfer", exact: true }).click();
      await sender.evaluate(() => { (window as unknown as { sentBytes: number }).sentBytes = 0; });
      await expect(sender.getByRole("button", { name: "Choose folder", exact: true })).toBeEnabled();
      await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
      await sender.getByRole("button", { name: "Get pairing code" }).click();
      await expect(sender.locator(".pairing-code-large")).toHaveText(/\d{3} \d{3}/);
      const code = (await sender.locator(".pairing-code-large").textContent())!.replace(/\s/g, "");
      await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill(code);
      await receiver.getByRole("button", { name: "Connect to sender" }).click();
      for (const page of [sender, receiver]) {
        await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Codes match", exact: true }).click();
      }
      await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
      const payloadBytes = await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes);
      if (outcome === "failure") expect(payloadBytes).toBe(0);
      else expect(payloadBytes).toBeGreaterThan(120_000);
      await receiver.getByRole("button", { name: "Choose destination and save" }).click();
      await expect(complete).toBeVisible();
      await expect(receiver.getByText("Temporary browser storage was reclaimed.", { exact: false })).toBeVisible();
      const secondHash = await receiver.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const directory = await (await root.getDirectoryHandle("cleanup-retry-destination")).getDirectoryHandle("browser-fixture");
        const file = await (await directory.getFileHandle("test.bin")).getFile();
        return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("");
      });
      expect(secondHash).toBe(result.sha256);
    }
    expect(errors).toEqual([]);
  });
}

for (const crashDuringSave of [false, true]) test(`interrupted many-file destination save reuses verified files and repairs changed files (renderer crash: ${crashDuringSave})`, async ({ context: suppliedContext }) => {
  const context = crashDuringSave ? await chromium.launchPersistentContext(test.info().outputPath("profile"), { channel: browserChannel, baseURL: "http://127.0.0.1:4178" }) : suppliedContext;
  try { await exerciseDestinationRecovery(context, crashDuringSave); }
  finally { if (crashDuringSave) await context.close(); }
});

test("browser process termination during destination save preserves verified files", async () => {
  test.setTimeout(90_000);
  const profile = test.info().outputPath("profile");
  let context = await chromium.launchPersistentContext(profile, { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try {
    await exerciseDestinationRecovery(context, true, async () => {
      const browser = context.browser()!;
      const cdp = await browser.newBrowserCDPSession();
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const pid = processInfo.find((entry) => entry.type === "browser")!.id;
      expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
      const disconnected = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
      process.kill(pid, "SIGKILL");
      await disconnected;
      context = await chromium.launchPersistentContext(profile, { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
      return setupPair(context, false, 120_000, false, false, false, false, false, true);
    });
  } finally { await context.close(); }
});

async function waitForManyFilePreparation(sender: Page) {
  // Pairing no longer implies that the 1,200-file hash pass has finished.
  // Keep the five-second receive/verification assertion separate from checking.
  await test.step("Finish checking the 1,200-file source", async () => {
    await expect(sender.getByText("You can pair now. Files will wait until checking and device confirmation finish.", { exact: false }))
      .toHaveCount(0, { timeout: 30_000 });
  });
}

async function exerciseDestinationRecovery(context: BrowserContext, crashDuringSave: boolean,
  restartBrowser?: () => Promise<Awaited<ReturnType<typeof setupPair>>>) {
  test.setTimeout(90_000);
  const pair = await setupPair(context, false, 120_000, false, false, false, false, false, true);
  let { sender, receiver } = pair;
  const errors = pair.errors;
  let restartedErrors: string[] = [];
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await waitForManyFilePreparation(sender);
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-many-destination", { create: true });
    const original = FileSystemFileHandle.prototype.createWritable;
    let failed = false;
    const writes: string[] = [];
    (window as unknown as { destinationWrites: string[] }).destinationWrites = writes;
    FileSystemFileHandle.prototype.createWritable = async function(options) {
      if (!failed && this.name === "file-000600.bin") {
        failed = true;
        await new Promise<void>((resolve) => {
          (window as unknown as { releaseDestinationFault: () => void }).releaseDestinationFault = resolve;
        });
        throw new DOMException("Injected mid-tree quota failure", "QuotaExceededError");
      }
      if (this.name.startsWith("file-")) writes.push(this.name);
      return original.call(this, options);
    };
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByText("Writing destination files", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(receiver.getByText(/600 \/ 1200 files/)).toBeVisible({ timeout: 30_000 });
  await receiver.setViewportSize({ width: 900, height: 900 });
  // Exercise layout with synthetic long text while real saving is held still.
  // This is not a claim that the fixture contains this filename.
  const saveStatus = receiver.locator(".destination-save-status");
  await saveStatus.locator(":scope > div > div").last().evaluate((element) => {
    element.textContent = `folder/${"a".repeat(240)}.bin`;
  });
  const layout = await saveStatus.evaluate((element) => {
    const text = element.querySelector("div")!;
    return { textFits: text.scrollWidth <= text.clientWidth + 1,
      panelFits: element.getBoundingClientRect().right <= window.innerWidth,
      pageFits: document.documentElement.scrollWidth <= window.innerWidth };
  });
  expect(layout).toEqual({ textFits: true, panelFits: true, pageFits: true });
  await receiver.screenshot({ path: "release-evidence/long-save-path-900px.png", fullPage: true });
  if (crashDuringSave) {
    if (restartBrowser) {
      const restarted = await restartBrowser();
      sender = restarted.sender;
      receiver = restarted.receiver;
      restartedErrors = restarted.errors;
    } else {
    const cdp = await context.newCDPSession(receiver);
    const crashed = receiver.waitForEvent("crash");
    void cdp.send("Page.crash").catch(() => undefined);
    await crashed;
    await receiver.close();
    receiver = await context.newPage();
    receiver.on("pageerror", (error) => errors.push(error.message));
    await receiver.goto("/");
    await sender.reload();
    await sender.getByRole("button", { name: "Send", exact: true }).click();
    await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
    await sender.getByRole("button", { name: "Get pairing code" }).click();
    await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
    await receiver.getByRole("button", { name: "Receive", exact: true }).click();
    await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
    await receiver.getByRole("button", { name: "Connect to sender" }).click();
    }
    for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
    await waitForManyFilePreparation(sender);
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
    expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
    await receiver.evaluate(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-many-destination");
      const writes: string[] = [];
      (window as unknown as { destinationWrites: string[] }).destinationWrites = writes;
      const original = FileSystemFileHandle.prototype.createWritable;
      FileSystemFileHandle.prototype.createWritable = async function(options) {
        if (this.name.startsWith("file-")) writes.push(this.name);
        return original.call(this, options);
      };
    });
  } else {
    await receiver.evaluate(() => (window as unknown as { releaseDestinationFault: () => void }).releaseDestinationFault());
    await expect(receiver.getByText(/Files remain verified in temporary storage/)).toBeVisible({ timeout: 30_000 });
  }
  const checkpoint = await receiver.evaluate(async () => {
    const root = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-many-destination")).getDirectoryHandle("many-files");
    const marker = JSON.parse(await (await (await root.getFileHandle(".airgap-qr-v3.partial.json")).getFile()).text());
    const bits = Array.from(atob(marker.completed), (value) => value.charCodeAt(0));
    const completed = bits.reduce((sum, byte) => sum + byte.toString(2).replace(/0/g, "").length, 0);
    const group = await root.getDirectoryHandle("group-00");
    const writer = await (await group.getFileHandle("file-000001.bin")).createWritable();
    await writer.write(new Uint8Array(257).fill(255)); await writer.close();
    (window as unknown as { destinationWrites: string[] }).destinationWrites.length = 0;
    return { completed, fileCount: marker.fileCount };
  });
  expect(checkpoint).toEqual({ completed: 600, fileCount: 1200 });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible({ timeout: 30_000 });
  const recovered = await receiver.evaluate(async () => {
    const root = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("e2e-many-destination")).getDirectoryHandle("many-files");
    const files: Array<{ path: string; size: number; hash: string }> = [];
    const directories: string[] = [];
    const walk = async (directory: FileSystemDirectoryHandle, prefix = "") => {
      for await (const [name, handle] of directory.entries()) {
        const path = prefix + name;
        if (handle.kind === "directory") {
          directories.push(path); await walk(handle, `${path}/`);
        } else {
          const file = await handle.getFile();
          const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
          files.push({ path, size: file.size, hash });
        }
      }
    };
    await walk(root);
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort(),
      writes: (window as unknown as { destinationWrites: string[] }).destinationWrites };
  });
  const expectedFiles = Array.from({ length: 1200 }, (_, index) => {
    const bytes = Buffer.alloc(index % 10 === 0 ? 0 : 257);
    for (let n = 0; n < bytes.length; n++) bytes[n] = (index >>> ((n % 4) * 8)) ^ (n * 31);
    return { path: `group-${String(Math.floor(index / 100)).padStart(2, "0")}/file-${String(index).padStart(6, "0")}.bin`,
      size: bytes.length, hash: createHash("sha256").update(bytes).digest("hex") };
  });
  expect(recovered.files).toEqual(expectedFiles);
  expect(recovered.directories).toEqual(["empty", "empty/nested", ...Array.from({ length: 12 }, (_, index) => `group-${String(index).padStart(2, "0")}`)]);
  expect(recovered.writes).toEqual(["file-000001.bin", ...Array.from({ length: 600 }, (_, offset) => `file-${String(offset + 600).padStart(6, "0")}.bin`)]);
  expect(errors).toEqual([]);
  expect(restartedErrors).toEqual([]);
}

for (const boundary of ["open", "write", "closed"] as const) test(`stopping a save drains pending payload operation (${boundary})`, async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await receiver.evaluate(({ boundary }) => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("stopped-payload-destination", { create: true });
    const original = FileSystemFileHandle.prototype.createWritable;
    (window as unknown as { restorePayload: () => void }).restorePayload = () => { FileSystemFileHandle.prototype.createWritable = original; };
    const hold = () => {
      (window as unknown as { payloadPending: boolean }).payloadPending = true;
      return new Promise<void>(resolve => { (window as unknown as { releasePayload: () => void }).releasePayload = resolve; });
    };
    FileSystemFileHandle.prototype.createWritable = async function(options) {
      if (this.name !== "test.bin") return original.call(this, options);
      if (boundary === "open") await hold();
      const writer = await original.call(this, options);
      if (boundary === "write") {
        const write = writer.write.bind(writer);
        writer.write = async data => { await hold(); return write(data); };
      } else if (boundary === "closed") {
        const close = writer.close.bind(writer);
        writer.close = async () => { await close(); await hold(); };
      }
      return writer;
    };
  }, { boundary });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect.poll(() => receiver.evaluate(() => (window as unknown as { payloadPending?: boolean }).payloadPending)).toBe(true);
  await receiver.getByRole("button", { name: "Stop and reconnect", exact: true }).click();
  const lockGranted = await receiver.evaluate(() => navigator.locks.request("airgap-qr-large-destination-write-v1", { mode: "exclusive", ifAvailable: true }, lock => Boolean(lock)));
  expect(lockGranted).toBe(false);
  await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toHaveCount(0);
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toHaveCount(0);
  await receiver.evaluate(() => (window as unknown as { releasePayload: () => void }).releasePayload());
  await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toBeVisible();
  await expect(receiver.locator(".transfer-problem")).toHaveCount(0);
  const partial = await receiver.evaluate(async () => {
    const root = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("stopped-payload-destination")).getDirectoryHandle("browser-fixture");
    const marker = JSON.parse(await (await root.getFileHandle(".airgap-qr-v3.partial.json")).getFile().then(file => file.text()));
    const file = await (await root.getFileHandle("test.bin")).getFile();
    const held = (await navigator.locks.query()).held!.filter(lock => lock.name === "airgap-qr-large-destination-write-v1" || lock.name?.startsWith("airgap-qr-block-store-v1:")).length;
    return { completed: Array.from(atob(marker.completed), byte => byte.charCodeAt(0)), size: file.size, held };
  });
  expect(partial).toEqual({ completed: [0], size: boundary === "closed" ? 120_000 : 0, held: 0 });
  await receiver.evaluate(() => {
    (window as unknown as { restorePayload: () => void }).restorePayload();
    const original = FileSystemFileHandle.prototype.createWritable;
    (window as unknown as { payloadRewrites: number }).payloadRewrites = 0;
    FileSystemFileHandle.prototype.createWritable = async function(options) {
      if (this.name === "test.bin") (window as unknown as { payloadRewrites: number }).payloadRewrites += 1;
      return original.call(this, options);
    };
  });
  await sender.getByRole("button", { name: "New transfer", exact: true }).click();
  await sender.evaluate(() => { (window as unknown as { sentBytes: number }).sentBytes = 0; });
  await expect(sender.getByRole("button", { name: "Choose folder", exact: true })).toBeEnabled();
  await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
  await sender.getByRole("button", { name: "Get pairing code" }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText(/\d{3} \d{3}/);
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill((await sender.locator(".pairing-code-large").textContent())!.replace(/\s/g, ""));
  await receiver.getByRole("button", { name: "Connect to sender" }).click();
  for (const page of [sender, receiver]) {
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Codes match", exact: true }).click();
  }
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const saved = await receiver.evaluate(async () => {
    const root = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("stopped-payload-destination")).getDirectoryHandle("browser-fixture");
    const names: string[] = []; for await (const [name] of root.entries()) names.push(name);
    const file = await (await root.getFileHandle("test.bin")).getFile();
    return { names, size: file.size, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join(""), payloadRewrites: (window as unknown as { payloadRewrites: number }).payloadRewrites };
  });
  expect(saved).toEqual({ names: ["test.bin"], size: 120_000, sha256: createHash("sha256").update(Buffer.alloc(120_000, 37)).digest("hex"), payloadRewrites: 1 });
  expect(errors).toEqual([]);
});

for (const boundary of ["stream", "footer"] as const) test(`Stop during verification starts no further reads (${boundary})`, async ({ context }) => {
  const fileBytes = boundary === "stream" ? 8 * 1024 * 1024 : 120_000;
  const { sender, receiver, errors } = await setupPair(context, false, fileBytes);
  await receiver.evaluate(({ boundary }) => {
    const original = Worker.prototype.postMessage;
    const state = window as unknown as { verifyReads: number; verifyPending: boolean; releaseVerify: () => void; restoreVerify: () => void };
    state.verifyReads = 0;
    state.restoreVerify = () => { Worker.prototype.postMessage = original; };
    let held = false;
    Worker.prototype.postMessage = function(data: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const args = [data, options];
      const message = data as { type?: string; length?: number };
      if (message?.type === "read-payload") {
        state.verifyReads += 1;
        if (!held && (boundary === "stream" || message.length === 16)) {
          held = true; state.verifyPending = true;
          state.releaseVerify = () => { Reflect.apply(original, this, args); };
          return;
        }
      }
      return Reflect.apply(original, this, args);
    };
  }, { boundary });
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  // The stream fixture is 8 MiB; wait for transfer to reach the held read while
  // retaining the 45 s overall test deadline and exact Stop/read assertions.
  await expect.poll(() => receiver.evaluate(() => (window as unknown as { verifyPending?: boolean }).verifyPending), { timeout: boundary === "stream" ? 15_000 : 5_000 }).toBe(true);
  const beforeStop = await receiver.evaluate(() => (window as unknown as { verifyReads: number }).verifyReads);
  await receiver.getByRole("button", { name: "Stop and reconnect", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toHaveCount(0);
  await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toHaveCount(0);
  await receiver.evaluate(() => (window as unknown as { releaseVerify: () => void }).releaseVerify());
  await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toBeVisible();
  const afterStop = await receiver.evaluate(() => (window as unknown as { verifyReads: number }).verifyReads);
  console.log(JSON.stringify({ boundary, fileBytes, readsBeforeStop: beforeStop, readsAfterStop: afterStop }));
  if (boundary === "stream") expect(beforeStop).toBe(1);
  expect(afterStop).toBe(beforeStop);
  expect((await controls(receiver)).filter(message => message === "receiver-complete")).toEqual([]);
  await expect(receiver.locator(".transfer-problem")).toHaveCount(0);
  await receiver.evaluate(() => (window as unknown as { restoreVerify: () => void }).restoreVerify());
  await sender.getByRole("button", { name: "New transfer", exact: true }).click();
  await sender.evaluate(() => { (window as unknown as { sentBytes: number }).sentBytes = 0; });
  await expect(sender.getByRole("button", { name: "Choose folder", exact: true })).toBeEnabled();
  await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
  await sender.getByRole("button", { name: "Get pairing code" }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText(/\d{3} \d{3}/);
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill((await sender.locator(".pairing-code-large").textContent())!.replace(/\s/g, ""));
  await receiver.getByRole("button", { name: "Connect to sender" }).click();
  for (const page of [sender, receiver]) {
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Codes match", exact: true }).click();
  }
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
  await receiver.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("verified-abort-destination", { create: true }); });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const digest = await receiver.evaluate(async () => {
    const parent = await (await navigator.storage.getDirectory()).getDirectoryHandle("verified-abort-destination");
    const root = await parent.getDirectoryHandle("browser-fixture");
    const file = await (await root.getFileHandle("test.bin")).getFile();
    return { size: file.size, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2, "0")).join("") };
  });
  expect(digest).toEqual({ size: fileBytes, sha256: createHash("sha256").update(Buffer.alloc(fileBytes, 37)).digest("hex") });
  expect(errors).toEqual([]);
});

test("Stop cancels prefetched native OPFS verification bytes and resumes without resend", async ({ context }) => {
  const bytes = 8 * 1024 * 1024;
  const { sender, receiver, errors } = await setupPair(context, false, bytes);
  await receiver.evaluate(() => {
    const original = ReadableStream.prototype.getReader;
    const state = window as unknown as { heldStream?: ReadableStream<Uint8Array>; streamHeld: boolean; releaseStream: () => void; restoreStream: () => void };
    state.streamHeld = false;
    state.restoreStream = () => { ReadableStream.prototype.getReader = original; };
    ReadableStream.prototype.getReader = function(this: ReadableStream<Uint8Array>, ...args: unknown[]) {
      const stream = this;
      const reader = Reflect.apply(original, stream, args) as ReadableStreamDefaultReader<Uint8Array>;
      const read = reader.read.bind(reader);
      reader.read = async () => {
        const next = await read();
        if (!state.streamHeld && next.value?.byteLength === 4 * 1024 * 1024) {
          state.heldStream = stream;
          state.streamHeld = true;
          await new Promise<void>(resolve => { state.releaseStream = resolve; });
        }
        return next;
      };
      return reader;
    } as typeof original;
  });
  try {
    for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
    // This test targets verification cancellation, after all payload ACKs.
    // Keep transfer preparation outside the five-second verification assertion.
    await sender.waitForFunction(() => (window as unknown as { sentControls: Array<{ type: string }> }).sentControls.some(message => message.type === "sender-complete"));
    await expect.poll(() => receiver.evaluate(() => (window as unknown as { streamHeld: boolean }).streamHeld)).toBe(true);
    await receiver.getByRole("button", { name: "Stop and reconnect", exact: true }).click();
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toHaveCount(0);
    await receiver.evaluate(() => (window as unknown as { releaseStream: () => void }).releaseStream());
    await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toBeVisible();
    const afterStop = await receiver.evaluate(async () => {
      const state = window as unknown as { heldStream: ReadableStream<Uint8Array>; restoreStream: () => void };
      state.restoreStream();
      const reader = state.heldStream.getReader();
      try {
        const next = await reader.read();
        return { done: next.done, queuedBytes: next.value?.byteLength ?? 0 };
      } finally { await reader.cancel(); reader.releaseLock(); }
    });
    expect(afterStop).toEqual({ done: true, queuedBytes: 0 });
    expect((await controls(receiver)).filter(message => message === "receiver-complete")).toEqual([]);
    await sender.getByRole("button", { name: "New transfer", exact: true }).click();
    await sender.evaluate(() => { (window as unknown as { sentBytes: number }).sentBytes = 0; });
    await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
    await sender.getByRole("button", { name: "Get pairing code" }).click();
    await expect(sender.locator(".pairing-code-large")).toHaveText(/\d{3} \d{3}/);
    await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill((await sender.locator(".pairing-code-large").textContent())!.replace(/\s/g, ""));
    await receiver.getByRole("button", { name: "Connect to sender" }).click();
    for (const page of [sender, receiver]) {
      await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Codes match", exact: true }).click();
    }
    await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
    expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
    await receiver.evaluate(() => { window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("native-stream-destination", { create: true }); });
    await receiver.getByRole("button", { name: "Choose destination and save" }).click();
    await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
    const saved = await receiver.evaluate(async () => {
      const root = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("native-stream-destination")).getDirectoryHandle("browser-fixture");
      const file = await (await root.getFileHandle("test.bin")).getFile();
      return { bytes: file.size, sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), n => n.toString(16).padStart(2, "0")).join("") };
    });
    expect(saved).toEqual({ bytes, sha256: createHash("sha256").update(Buffer.alloc(bytes, 37)).digest("hex") });
    expect(errors).toEqual([]);
  } finally {
    await receiver.evaluate(() => {
      const state = window as unknown as { releaseStream?: () => void; restoreStream?: () => void };
      state.releaseStream?.(); state.restoreStream?.();
    }).catch(() => undefined);
  }
});

test("stopping a save removes its pending destination lock request", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await receiver.evaluate(async () => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("cancelled-lock-destination", { create: true });
    await new Promise<void>((resolve) => {
      void navigator.locks.request("airgap-qr-large-destination-write-v1", async () => {
        await new Promise<void>((release) => {
          (window as unknown as { releaseDestinationLock: () => void }).releaseDestinationLock = release;
          resolve();
        });
      });
    });
  });
  try {
    await receiver.getByRole("button", { name: "Choose destination and save" }).click();
    const pending = () => receiver.evaluate(async () => (await navigator.locks.query()).pending?.filter((lock) => lock.name === "airgap-qr-large-destination-write-v1").length ?? 0);
    await expect.poll(pending).toBe(1);
    await receiver.getByRole("button", { name: "Stop and reconnect", exact: true }).click();
    await expect(receiver.getByRole("textbox", { name: "Six-digit pairing code" })).toBeVisible();
    await expect.poll(pending).toBe(0);
    const names = await receiver.evaluate(async () => {
      const destination = await (await navigator.storage.getDirectory()).getDirectoryHandle("cancelled-lock-destination");
      const names: string[] = []; for await (const [name] of destination.entries()) names.push(name); return names;
    });
    expect(names).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await receiver.evaluate(() => (window as unknown as { releaseDestinationLock: () => void }).releaseDestinationLock());
  }
});

test("receiver rejects payload before human verification", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await sender.evaluate(() => (window as unknown as { testChannel: RTCDataChannel }).testChannel.send(new ArrayBuffer(44)));
  await expectErrorDetails(receiver, "Transfer data arrived before both devices were verified.");
  expect(await controls(receiver)).not.toContain("resume-complete");
  await expect(receiver.getByRole("button", { name: "Reconnect and resume" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("sender rejects premature success before human verification", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await receiver.evaluate(() => (window as unknown as { testChannel: RTCDataChannel }).testChannel.send(JSON.stringify({ type: "receiver-complete" })));
  await expectErrorDetails(sender, "Transfer data arrived before both devices were verified.");
  await expect(sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("rejecting the device sends no file data", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await receiver.getByRole("button", { name: "Codes do not match" }).click();
  await expect(receiver.getByRole("button", { name: "Reconnect and resume" })).toBeVisible();
  expect(await controls(sender)).not.toContain("manifest");
  expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
  expect(errors).toEqual([]);
});

test("altered signaling produces different verification codes and cannot authorize", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context, true);
  expect(await sender.getByLabel("Device verification code").textContent()).not.toBe(await receiver.getByLabel("Device verification code").textContent());
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await expectErrorDetails(receiver, /Device verification does not match this connection/);
  expect(await controls(sender)).not.toContain("manifest");
  expect(await controls(receiver)).not.toContain("resume-complete");
  expect(errors).toEqual([]);
});

test("premature success after authorization still cannot finish a transfer", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  await receiver.evaluate(() => {
    const channel = (window as unknown as { testChannel: RTCDataChannel }).testChannel;
    const send = channel.send.bind(channel);
    channel.send = ((data: string) => {
      if (JSON.parse(data).type === "resume-complete") {
        send(JSON.stringify({ type: "receiver-complete" }));
      } else send(data);
    }) as typeof channel.send;
  });
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expectErrorDetails(sender, "The receiver reported completion before all data was acknowledged.");
  await expect(sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("pairing retry retains the prepared source without rehashing or reselecting", async ({ context }) => {
  const { sender, receiver, errors } = await setupPair(context);
  const reads = await sender.evaluate(() => (window as unknown as { sourceReads: number }).sourceReads);
  await receiver.getByRole("button", { name: "Codes do not match" }).click();
  await sender.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
  expect(await sender.evaluate(() => (window as unknown as { sourceReads: number }).sourceReads)).toBe(reads);
  await receiver.getByRole("button", { name: "Reconnect and resume" }).click();
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await receiver.getByRole("button", { name: "Connect to sender" }).click();
  for (const page of [sender, receiver]) {
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
  }
  // A fresh session must require both human decisions again.
  expect(await controls(sender)).not.toContain("manifest");
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a journal truncated after flush is never acknowledged", async ({ context }) => {
  await context.route("**/assets/block-store.worker-*.js", async (route) => {
    const response = await route.fetch();
    const injection = `const originalFlush = FileSystemSyncAccessHandle.prototype.flush;
FileSystemSyncAccessHandle.prototype.flush = function() {
  originalFlush.call(this);
  if (this.getSize() > 0 && this.getSize() < 4096) this.truncate(0);
};\n`;
    await route.fulfill({ response, body: injection + await response.text() });
  });
  const { sender, receiver, errors } = await setupPair(context);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expectErrorDetails(receiver, /Temporary storage did not retain the transfer receipt/);
  expect(await controls(receiver)).not.toContain("ack");
  expect(await controls(receiver)).not.toContain("receiver-complete");
  expect(errors).toEqual([]);
});

for (const failedCommit of [1, 2]) test(`journal failure at commit ${failedCommit} resumes only durable blocks after refresh`, async ({ context }) => {
  await exerciseJournalResume(context, failedCommit);
});

test("sender and receiver reload resume only missing blocks after source recovery", async () => {
  const context = await chromium.launchPersistentContext(test.info().outputPath("profile"), { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try { await exerciseJournalResume(context, 2, true); }
  finally { await context.close(); }
});

test("receiver renderer crash during receipt commit recovers durable blocks and exact output", async () => {
  const context = await chromium.launchPersistentContext(test.info().outputPath("profile"), { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try { await exerciseJournalResume(context, 2, true, true); }
  finally { await context.close(); }
});

test("browser process termination during receive resumes exact durable blocks", async () => {
  const profile = test.info().outputPath("profile");
  let context = await chromium.launchPersistentContext(profile, { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
  try {
    await exerciseJournalResume(context, 2, true, true, async () => {
      const browser = context.browser()!;
      const cdp = await browser.newBrowserCDPSession();
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      const pid = processInfo.find((entry) => entry.type === "browser")!.id;
      expect(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid).toBe(true);
      const disconnected = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
      process.kill(pid, "SIGKILL");
      await disconnected;
      context = await chromium.launchPersistentContext(profile, { channel: browserChannel, baseURL: "http://127.0.0.1:4178" });
      // Reselect the identical source; this case isolates durable receiver recovery.
      return setupPair(context, false, 12 * 1024 * 1024, false, false, true, false, false, false, true);
    });
  } finally { await context.close(); }
});

async function exerciseJournalResume(context: BrowserContext, failedCommit: number, reloadSender = false, crashReceiver = false,
  restartBrowser?: () => Promise<Awaited<ReturnType<typeof setupPair>>>) {
  const pair = await setupPair(context, false, 12 * 1024 * 1024, false, false, reloadSender);
  let { sender, receiver } = pair;
  const errors = pair.errors;
  if (reloadSender) await expect(sender.getByText(/Your selection is saved on this device/)).toBeVisible();
  await receiver.evaluate(({ failedCommit, crashReceiver }) => {
    const post = Worker.prototype.postMessage;
    let journals = 0;
    Worker.prototype.postMessage = function(message, ...args) {
      if (message.type === "append-journal" && ++journals === failedCommit) {
        // Payload flush completed, but do not let this receipt become durable.
        if (crashReceiver) (window as unknown as { commitHeld: boolean }).commitHeld = true;
        else this.dispatchEvent(new ErrorEvent("error", { message: "Synthetic journal interruption", cancelable: true }));
        return;
      }
      return Reflect.apply(post, this, [message, ...args]);
    };
  }, { failedCommit, crashReceiver });
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  if (crashReceiver) await expect.poll(() => receiver.evaluate(() => (window as unknown as { commitHeld: boolean }).commitHeld)).toBe(true);
  else await expect(receiver.getByRole("button", { name: "Reconnect and resume" })).toBeVisible();
  const durable = await receiver.evaluate(() => (window as unknown as {
    sentControls: Array<{ type: string; indices?: number[] }>;
  }).sentControls.filter(({ type }) => type === "ack").flatMap(({ indices }) => indices ?? []));
  if (failedCommit === 1) expect(durable).toHaveLength(0);
  else expect(durable.length).toBeGreaterThan(0);
  const initialManifest = await sender.evaluate(() => (window as unknown as {
    sentControls: Array<{ type: string; manifest?: unknown }>;
  }).sentControls.find(({ type }) => type === "manifest")!.manifest);
  let before = 0;
  if (restartBrowser) {
    const restarted = await restartBrowser();
    sender = restarted.sender;
    receiver = restarted.receiver;
    errors.push(...restarted.errors);
    // Capture later page errors too; setupPair keeps collecting its own list.
    for (const page of [sender, receiver]) page.on("pageerror", (error) => errors.push(error.message));
  } else {
  if (crashReceiver) {
    const cdp = await context.newCDPSession(receiver);
    const crashed = receiver.waitForEvent("crash");
    // CDP deliberately terminates the renderer; rejection is expected on crash.
    void cdp.send("Page.crash").catch(() => undefined);
    await crashed;
    // Reopen the receiver in the same persistent profile after confirmed termination.
    await receiver.close();
    receiver = await context.newPage();
    receiver.on("pageerror", (error) => errors.push(error.message));
    await receiver.goto("/");
  } else await receiver.reload();
  if (reloadSender) {
    await sender.reload();
    await sender.getByRole("button", { name: "Send", exact: true }).click();
    await sender.getByRole("button", { name: "Recover saved source", exact: true }).click();
    await expect(sender.getByText(/Saved source checked and verified/)).toBeVisible();
    expect(await controls(sender)).toEqual([]);
    expect(await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes)).toBe(0);
  }
  await sender.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
  before = await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes);
  await receiver.getByRole("button", { name: "Receive", exact: true }).click();
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await receiver.getByRole("button", { name: "Connect to sender" }).click();
  }
  for (const page of [sender, receiver]) {
    await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Codes match", exact: true }).click();
  }
  // Resume retransmission and final disk-backed hashing are asynchronous.
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible({ timeout: 15_000 });
  await expect(sender.getByText("The receiver checked every transferred byte. Save the files on the receiving laptop to finish.")).toBeVisible();
  const ranges = await receiver.evaluate(() => (window as unknown as {
    sentControls: Array<{ type: string; ranges?: Array<[number, number]> }>;
  }).sentControls.filter(({ type }) => type === "resume-ranges").flatMap(({ ranges }) => ranges ?? []));
  expect(ranges.flatMap(([start, end]) => Array.from({ length: end - start }, (_, index) => start + index))).toEqual([...durable].sort((a, b) => a - b));
  const manifest = await sender.evaluate(() => (window as unknown as {
    sentControls: Array<{ type: string; manifest?: { totalBytes: number; blockSize: number } }>;
  }).sentControls.find(({ type }) => type === "manifest")!.manifest!);
  expect(manifest).toEqual(initialManifest);
  for (const page of [sender, receiver]) {
    await expect(page.locator(".metric").filter({ hasText: "Resumed" }).locator("strong")).toHaveText(formatBytes(durable.length * manifest.blockSize));
    await expect(page.locator(".metric").filter({ hasText: "Remaining bytes" }).locator("strong")).toHaveText("0 B");
  }
  const after = await sender.evaluate(() => (window as unknown as { sentBytes: number }).sentBytes);
  const blocks = Math.ceil(manifest.totalBytes / manifest.blockSize);
  expect(after - before).toBe(manifest.totalBytes - durable.length * manifest.blockSize + (blocks - durable.length) * 44);
  if (reloadSender) {
    await receiver.evaluate(() => {
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("recovered-output", { create: true });
    });
    await receiver.getByRole("button", { name: "Choose destination and save" }).click();
    await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
    const saved = await receiver.evaluate(async () => {
      const output = await (await navigator.storage.getDirectory()).getDirectoryHandle("recovered-output");
      const tree = await output.getDirectoryHandle("browser-fixture");
      const file = await (await tree.getFileHandle("test.bin")).getFile();
      const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return { size: file.size, hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") };
    });
    expect(saved).toEqual({ size: 12 * 1024 * 1024, hash: createHash("sha256").update(Buffer.alloc(12 * 1024 * 1024, 37)).digest("hex") });
  }
  expect(errors).toEqual([]);
}

for (const denied of [false, true]) test(`screen wake lock follows transfer lifecycle (denied: ${denied})`, async ({ context }) => {
  await context.addInitScript(({ denied }) => {
    const state = window as unknown as { activeWakeLocks: number };
    state.activeWakeLocks = 0;
    Object.defineProperty(document, "visibilityState", { get: () => "visible" });
    Object.defineProperty(navigator, "wakeLock", { value: { request: async () => {
      if (denied) throw new DOMException("Denied by test policy", "NotAllowedError");
      state.activeWakeLocks++;
      const lock = new EventTarget() as EventTarget & { released: boolean; release: () => Promise<void> };
      lock.released = false;
      lock.release = async () => {
        if (!lock.released) { lock.released = true; state.activeWakeLocks--; lock.dispatchEvent(new Event("release")); }
      };
      return lock;
    } } });
  }, { denied });
  const { sender, receiver, errors } = await setupPair(context);
  for (const page of [sender, receiver]) {
    await expect(page.getByText(denied ? /browser cannot keep the screen awake/ : "Keeping the screen awake during this transfer.")).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { activeWakeLocks: number }).activeWakeLocks)).toBe(denied ? 0 : 1);
  }
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  for (const page of [sender, receiver]) {
    await expect.poll(() => page.evaluate(() => (window as unknown as { activeWakeLocks: number }).activeWakeLocks)).toBe(0);
  }
  expect(errors).toEqual([]);
});
for (const stage of ["receiving", "complete", "saving", "saved"] as const) {
  test(`late answer-publication response failure preserves ${stage}`, async ({context}) => {
    await context.addInitScript(({holdAcks}) => {
      const state=window as unknown as {rejectAnswerResponse?:()=>void;answerResponseSettled?:boolean;heldAcks:Array<()=>void>;releaseAcks:()=>void};
      state.heldAcks=[];state.releaseAcks=()=>{for(const send of state.heldAcks.splice(0))send();};
      const fetchOriginal=window.fetch.bind(window);
      window.fetch=async(input,init)=>{
        const response=await fetchOriginal(input,init);
        const url=typeof input==="string"?input:input instanceof Request?input.url:input.toString();
        if(/\/joins\/[^/]+\/answer$/.test(new URL(url,location.href).pathname)){
          try{return await new Promise<Response>((_resolve,reject)=>{
            const abort=()=>reject(init?.signal?.reason);
            state.rejectAnswerResponse=()=>{init?.signal?.removeEventListener("abort",abort);reject(new TypeError("Controlled late answer-response failure"));};
            init?.signal?.addEventListener("abort",abort,{once:true});
          });}finally{state.answerResponseSettled=true;}
        }
        return response;
      };
      if(holdAcks){
        const original=RTCDataChannel.prototype.send;
        RTCDataChannel.prototype.send=function(data:string|Blob|ArrayBuffer|ArrayBufferView<ArrayBuffer>){
          if(typeof data==="string"&&JSON.parse(data).type==="ack"){state.heldAcks.push(()=>Reflect.apply(original,this,[data]));return;}
          return Reflect.apply(original,this,[data]);
        };
      }
    },{holdAcks:stage==="receiving"});
    const {sender,receiver,errors}=await setupPair(context);
    try{
      await receiver.waitForFunction(()=>typeof (window as unknown as {rejectAnswerResponse?:()=>void}).rejectAnswerResponse==="function");
      for(const page of [sender,receiver])await page.getByRole("button",{name:"Codes match",exact:true}).click();
      const ready=receiver.getByRole("button",{name:"Choose destination and save"});
      if(stage==="receiving")await receiver.waitForFunction(()=>(window as unknown as {heldAcks:Array<()=>void>}).heldAcks.length>0);
      else await expect(ready).toBeVisible();
      await receiver.evaluate(({holdSave})=>{
        const state=window as unknown as {releaseSave?:()=>void;saveOpen?:boolean};
        window.showDirectoryPicker=async()=>(await navigator.storage.getDirectory()).getDirectoryHandle("late-answer-destination",{create:true});
        if(holdSave){const original=FileSystemFileHandle.prototype.createWritable;FileSystemFileHandle.prototype.createWritable=async function(options){
          const writable=await original.call(this,options);
          if(this.name==="test.bin"){state.saveOpen=true;await new Promise<void>(done=>{state.releaseSave=done;});}
          return writable;
        };}
      },{holdSave:stage==="saving"});
      if(stage==="saving"||stage==="saved"){
        await ready.click();
        if(stage==="saving")await receiver.waitForFunction(()=>(window as unknown as {saveOpen?:boolean}).saveOpen);
        else await expect(receiver.getByRole("heading",{name:"Transfer complete",exact:true})).toBeVisible();
      }
      await receiver.evaluate(async()=>{
        const state=window as unknown as {rejectAnswerResponse?:()=>void};if(!state.rejectAnswerResponse)throw Error("Answer response was not held");
        state.rejectAnswerResponse();await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));
      });
      await receiver.waitForFunction(()=>(window as unknown as {answerResponseSettled?:boolean}).answerResponseSettled);
      if(stage==="receiving")await receiver.evaluate(()=>(window as unknown as {releaseAcks:()=>void}).releaseAcks());
      if(stage==="receiving"||stage==="complete"){await expect(ready).toBeVisible();await ready.click();}
      if(stage==="saving"){await expect(receiver.locator(".destination-save-status")).toBeVisible();await receiver.evaluate(()=>(window as unknown as {releaseSave:()=>void}).releaseSave());}
      await expect(receiver.getByRole("heading",{name:"Transfer complete",exact:true})).toBeVisible();
      const saved=await receiver.evaluate(async()=>{
        const root=await(await navigator.storage.getDirectory()).getDirectoryHandle("late-answer-destination");
        const tree=await root.getDirectoryHandle("browser-fixture");const file=await(await tree.getFileHandle("test.bin")).getFile();
        const bytes=new Uint8Array(await file.arrayBuffer());
        if(bytes.length!==120000||bytes.some(byte=>byte!==37))throw Error("Exact destination bytes differ");
        return {size:file.size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),byte=>byte.toString(16).padStart(2,"0")).join("")};
      });
      expect(saved).toEqual({size:120000,sha256:createHash("sha256").update(Buffer.alloc(120000,37)).digest("hex")});expect(errors).toEqual([]);
    }finally{await receiver.evaluate(()=>(window as unknown as {releaseSave?:()=>void}).releaseSave?.()).catch(()=>undefined);}
  });
}

