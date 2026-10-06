import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";

const fileBytes = 120_000;
const pendingNotice = "You can pair now. Files will wait until checking and device confirmation finish.";
type FixtureState = {
  sourceReads: number; sourceSnapshots: number; hashPending: boolean;
  hashReleased: boolean; releaseHash: () => void; rejectHash: () => void;
  controls: string[]; sentBytes: number; testPeer: RTCPeerConnection;
};

async function pendingSourcePair(context: BrowserContext) {
  let offer: { sessionId: string; sdp: string };
  let answer: { sessionId: string; sdp: string } | undefined;
  await context.route("**/api/rendezvous/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown;
    if (request.method() === "DELETE") json = { ok: true };
    else if (path.endsWith("/health")) json = { ready: true, protocol: 2 };
    else if (path.endsWith("/rooms")) {
      answer = undefined; offer = request.postDataJSON();
      json = { roomId: "a".repeat(32), ownerToken: "b".repeat(64), code: "123456", expiresAt: Date.now() + 120_000 };
    } else if (path.endsWith("/join")) json = { joinId: "c".repeat(32), ...offer };
    else if (path.endsWith("/answer")) { answer = request.postDataJSON(); json = { ok: true }; }
    else json = answer ? { status: "answered", ...answer } : { status: "waiting" };
    await route.fulfill({ json });
  });
  await context.addInitScript((fileBytes) => {
    const state = window as unknown as FixtureState;
    state.sourceReads = 0; state.sourceSnapshots = 0;
    state.hashPending = false; state.hashReleased = false;
    state.controls = []; state.sentBytes = 0;
    let release!: () => void;
    let reject!: (reason: Error) => void;
    const gate = new Promise<void>((resolve, rejectGate) => { release = resolve; reject = rejectGate; });
    state.releaseHash = () => { state.hashReleased = true; release(); };
    state.rejectHash = () => { state.hashReleased = true; reject(new Error("Injected source read failure")); };
    const file = new File([new Uint8Array(fileBytes).fill(37)], "test.bin", { lastModified: 7 });
    const slice = file.slice.bind(file);
    file.slice = (...args) => {
      state.sourceReads++;
      const chunk = slice(...args);
      const read = chunk.arrayBuffer.bind(chunk);
      chunk.arrayBuffer = async () => {
        if (!state.hashReleased) {
          state.hashPending = true;
          try { await gate; } finally { state.hashPending = false; }
        }
        return read();
      };
      return chunk;
    };
    window.showDirectoryPicker = async () => ({
      kind: "directory", name: "pending-source",
      async *entries() { yield [file.name, { kind: "file", name: file.name, getFile: async () => { state.sourceSnapshots++; return file; } }]; },
    }) as unknown as FileSystemDirectoryHandle;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
      if (typeof data === "string") state.controls.push(JSON.parse(data).type);
      else state.sentBytes += data instanceof Blob ? data.size : data.byteLength;
      return Reflect.apply(send, this, [data]);
    };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(config?: RTCConfiguration) { super(config); state.testPeer = this; }
    };
  }, fileBytes);
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
  await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
  await sender.getByRole("button", { name: "Get pairing code", exact: true }).click();
  await expect.poll(() => sender.evaluate(() => (window as unknown as FixtureState).hashPending)).toBe(true);
  await expect(sender.getByText(pendingNotice, { exact: false })).toBeVisible();
  return { sender, receiver, errors };
}

async function connect(sender: Page, receiver: Page) {
  // This is the regression: an unresolved source byte read must not hold up pairing.
  await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await receiver.getByRole("button", { name: "Connect to sender", exact: true }).click();
  for (const page of [sender, receiver]) await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
  await expect(sender.getByLabel("Device verification code")).toHaveText((await receiver.getByLabel("Device verification code").textContent())!);
}

async function expectNoPayload(sender: Page) {
  const snapshot = await sender.evaluate(() => {
    const state = window as unknown as FixtureState;
    return { manifest: state.controls.includes("manifest"), bytes: state.sentBytes };
  });
  expect(snapshot).toEqual({ manifest: false, bytes: 0 });
}

async function finishAndAudit(receiver: Page, rootName = "pending-source", name = "test.bin", size = fileBytes, fill = 37) {
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toBeVisible();
  await receiver.evaluate(() => {
    window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("pending-output", { create: true });
  });
  await receiver.getByRole("button", { name: "Choose destination and save" }).click();
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toBeVisible();
  const saved = await receiver.evaluate(async ({ rootName, name }) => {
    const output = await (await navigator.storage.getDirectory()).getDirectoryHandle("pending-output");
    const tree = await output.getDirectoryHandle(rootName);
    const file = await (await tree.getFileHandle(name)).getFile();
    const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return { size: file.size, hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("") };
  }, { rootName, name });
  expect(saved).toEqual({ size, hash: createHash("sha256").update(Buffer.alloc(size, fill)).digest("hex") });
}

test("pairing and both human confirmations complete while source hashing is pending", async ({ context }) => {
  const { sender, receiver, errors } = await pendingSourcePair(context);
  await connect(sender, receiver);
  for (const [name, page] of [["sender", sender], ["receiver", receiver]] as const) {
    await test.info().attach(`${name}-pairing-while-hashing`, {
      body: await page.screenshot({ fullPage: true }), contentType: "image/png",
    });
  }
  await expectNoPayload(sender);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await expect.poll(() => sender.evaluate(() => (window as unknown as FixtureState).controls.includes("peer-confirmed"))).toBe(true);
  await expect.poll(() => receiver.evaluate(() => (window as unknown as FixtureState).controls.includes("peer-confirmed"))).toBe(true);
  expect(await sender.evaluate(() => (window as unknown as FixtureState).hashPending)).toBe(true);
  await expectNoPayload(sender);
  await sender.evaluate(() => (window as unknown as FixtureState).releaseHash());
  await finishAndAudit(receiver);
  expect(errors).toEqual([]);
});

test("completed source hashing still requires the other human confirmation before sending", async ({ context }) => {
  const { sender, receiver, errors } = await pendingSourcePair(context);
  await connect(sender, receiver);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await sender.evaluate(() => (window as unknown as FixtureState).releaseHash());
  await expect.poll(() => sender.evaluate(() => (window as unknown as FixtureState).hashPending)).toBe(false);
  await expect(sender.getByText(pendingNotice, { exact: false })).toHaveCount(0);
  await expectNoPayload(sender);
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await finishAndAudit(receiver);
  expect(errors).toEqual([]);
});

test("connection retry preserves the pending source read and requires fresh consent", async ({ context }) => {
  const { sender, receiver, errors } = await pendingSourcePair(context);
  await connect(sender, receiver);
  const before = await sender.evaluate(() => {
    const state = window as unknown as FixtureState;
    return { reads: state.sourceReads, snapshots: state.sourceSnapshots };
  });
  await receiver.evaluate(() => (window as unknown as FixtureState).testPeer.close());
  await expect(sender.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await sender.getByRole("button", { name: "Retry connection", exact: true }).click();
  await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
  expect(await sender.evaluate(() => {
    const state = window as unknown as FixtureState;
    return { reads: state.sourceReads, snapshots: state.sourceSnapshots };
  })).toEqual(before);
  expect(await sender.evaluate(() => (window as unknown as FixtureState).hashPending)).toBe(true);
  await receiver.getByRole("button", { name: "Reconnect and resume", exact: true }).click();
  await connect(sender, receiver);
  await expectNoPayload(sender);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await sender.evaluate(() => (window as unknown as FixtureState).releaseHash());
  await expect.poll(() => sender.evaluate(() => (window as unknown as FixtureState).hashPending)).toBe(false);
  await expect(sender.getByText(pendingNotice, { exact: false })).toHaveCount(0);
  await expectNoPayload(sender);
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await finishAndAudit(receiver);
  expect(errors).toEqual([]);
});

test("a pending source read failure sends no manifest and retry checks the source again", async ({ context }) => {
  const { sender, receiver, errors } = await pendingSourcePair(context);
  await connect(sender, receiver);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  const snapshots = await sender.evaluate(() => (window as unknown as FixtureState).sourceSnapshots);
  await sender.evaluate(() => (window as unknown as FixtureState).rejectHash());
  await expect(sender.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await sender.locator(".transfer-error-details summary").click();
  await expect(sender.locator(".transfer-error-details pre")).toContainText("Injected source read failure");
  await expectNoPayload(sender);
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toHaveCount(0);
  await expect(receiver.getByRole("heading", { name: "Transfer complete", exact: true })).toHaveCount(0);
  await sender.getByRole("button", { name: "Retry connection", exact: true }).click();
  await receiver.getByRole("button", { name: "Reconnect and resume", exact: true }).click();
  await connect(sender, receiver);
  await expect.poll(() => sender.evaluate(() => (window as unknown as FixtureState).sourceSnapshots)).toBeGreaterThan(snapshots);
  await expect(sender.getByText(pendingNotice, { exact: false })).toHaveCount(0);
  await expectNoPayload(sender);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await finishAndAudit(receiver);
  expect(errors).toEqual([]);
});

for (const oldOutcome of ["completion", "error"] as const) test(`discarding a pending source ignores its late ${oldOutcome} after replacement`, async ({ context }) => {
  const { sender, receiver, errors } = await pendingSourcePair(context);
  await connect(sender, receiver);
  await receiver.evaluate(() => (window as unknown as FixtureState).testPeer.close());
  await sender.getByRole("button", { name: "New transfer", exact: true }).click();
  await sender.evaluate(() => {
    const replacement = new File([new Uint8Array(71_003).fill(91)], "replacement.dat", { lastModified: 19 });
    window.showDirectoryPicker = async () => ({
      kind: "directory", name: "replacement-source",
      async *entries() { yield [replacement.name, { kind: "file", name: replacement.name, getFile: async () => replacement }]; },
    }) as unknown as FileSystemDirectoryHandle;
  });
  await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
  await sender.getByRole("button", { name: "Get pairing code", exact: true }).click();
  await receiver.getByRole("button", { name: "Reconnect and resume", exact: true }).click();
  await connect(sender, receiver);
  await expect(sender.getByText(pendingNotice, { exact: false })).toHaveCount(0);
  await sender.evaluate((oldOutcome) => {
    const state = window as unknown as FixtureState;
    if (oldOutcome === "error") state.rejectHash(); else state.releaseHash();
  }, oldOutcome);
  await expect.poll(() => sender.evaluate(() => (window as unknown as FixtureState).hashPending)).toBe(false);
  await expectNoPayload(sender);
  for (const page of [sender, receiver]) await page.getByRole("button", { name: "Codes match", exact: true }).click();
  await finishAndAudit(receiver, "replacement-source", "replacement.dat", 71_003, 91);
  await expect(sender.getByRole("button", { name: "Retry connection", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("Stop and reconnect retains pending preparation and requires fresh device confirmation", async ({ context }) => {
  const { sender, receiver, errors } = await pendingSourcePair(context);
  await connect(sender, receiver);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  const before = await sender.evaluate(() => {
    const state = window as unknown as FixtureState;
    return { reads: state.sourceReads, snapshots: state.sourceSnapshots };
  });
  await sender.getByRole("button", { name: "Stop and reconnect", exact: true }).click();
  await sender.getByRole("button", { name: "Retry connection", exact: true }).click();
  await receiver.getByRole("button", { name: "Reconnect and resume", exact: true }).click();
  await connect(sender, receiver);
  expect(await sender.evaluate(() => {
    const state = window as unknown as FixtureState;
    return { reads: state.sourceReads, snapshots: state.sourceSnapshots };
  })).toEqual(before);
  await expectNoPayload(sender);
  await sender.evaluate(() => (window as unknown as FixtureState).releaseHash());
  await expect(sender.getByText(pendingNotice, { exact: false })).toHaveCount(0);
  await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await expectNoPayload(sender);
  await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  await finishAndAudit(receiver);
  expect(errors).toEqual([]);
});
