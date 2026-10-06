import { test, expect, type BrowserContext } from "@playwright/test";

const secretName = "private-acquisition-plan-SECRET-2026.txt";
type PrivacyState = {
  pendingSource: boolean; releaseSource: () => void;
  sentMessages: string[]; receivedMessages: string[]; sentBytes: number;
};

async function connectBeforeSourceCheck(context: BrowserContext) {
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
  await context.addInitScript((secretName) => {
    const state = window as unknown as PrivacyState;
    state.pendingSource = false; state.sentMessages = []; state.receivedMessages = []; state.sentBytes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state.releaseSource = release;
    let snapshots = 0;
    window.showDirectoryPicker = async () => ({
      kind: "directory", name: "private-source",
      async *entries() {
        yield [secretName, { kind: "file", name: secretName, getFile: async () => {
          snapshots++;
          if (snapshots === 1) return new File([new Uint8Array(8)], secretName, { lastModified: 7 });
          state.pendingSource = true;
          await gate;
          state.pendingSource = false;
          // A real source validation error includes the private relative path.
          return new File([new Uint8Array(9)], secretName, { lastModified: 8 });
        } }];
      },
    }) as unknown as FileSystemDirectoryHandle;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data: string | Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
      if (typeof data === "string") state.sentMessages.push(data);
      else state.sentBytes += data instanceof Blob ? data.size : data.byteLength;
      return Reflect.apply(send, this, [data]);
    };
    const Peer = RTCPeerConnection;
    window.RTCPeerConnection = class extends Peer {
      constructor(config?: RTCConfiguration) {
        super(config);
        this.addEventListener("datachannel", ({ channel }) => {
          channel.addEventListener("message", ({ data }) => {
            if (typeof data === "string") state.receivedMessages.push(data);
          });
        });
      }
    };
  }, secretName);
  const sender = await context.newPage();
  const receiver = await context.newPage();
  const errors: string[] = [];
  for (const page of [sender, receiver]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto("/");
    await page.getByRole("button", { name: page === sender ? "Send" : "Receive", exact: true }).click();
  }
  await sender.getByRole("button", { name: "Choose folder", exact: true }).click();
  await sender.getByRole("button", { name: "Get pairing code", exact: true }).click();
  await expect.poll(() => sender.evaluate(() => (window as unknown as PrivacyState).pendingSource)).toBe(true);
  await expect(sender.locator(".pairing-code-large")).toHaveText("123 456");
  await receiver.getByRole("textbox", { name: "Six-digit pairing code" }).fill("123456");
  await receiver.getByRole("button", { name: "Connect to sender", exact: true }).click();
  for (const page of [sender, receiver]) await expect(page.getByRole("button", { name: "Codes match", exact: true })).toBeEnabled();
  await expect(sender.getByLabel("Device verification code")).toHaveText((await receiver.getByLabel("Device verification code").textContent())!);
  return { sender, receiver, errors };
}

for (const confirmation of ["neither", "sender only", "receiver only"] as const) test(`source failure keeps private filenames local with ${confirmation} confirmed`, async ({ context }) => {
  const { sender, receiver, errors } = await connectBeforeSourceCheck(context);
  if (confirmation === "sender only") await sender.getByRole("button", { name: "Codes match", exact: true }).click();
  if (confirmation === "receiver only") await receiver.getByRole("button", { name: "Codes match", exact: true }).click();
  await sender.evaluate(() => (window as unknown as PrivacyState).releaseSource());
  await expect(sender.getByRole("button", { name: "Retry connection", exact: true })).toBeVisible();
  await sender.locator(".transfer-error-details summary").click();
  await expect(sender.locator(".transfer-error-details pre")).toContainText(secretName);
  await expect(receiver.getByRole("button", { name: "Reconnect and resume", exact: true })).toBeVisible();
  // Check the actual emitted wire messages as well as the remote UI. Closing
  // quickly must not hide an attempted diagnostic disclosure from the test.
  const emitted = await sender.evaluate(() => (window as unknown as PrivacyState).sentMessages);
  expect(emitted.join("\n")).not.toContain(secretName);
  expect(emitted.map((message) => JSON.parse(message).type)).not.toContain("manifest");
  expect(await sender.evaluate(() => (window as unknown as PrivacyState).sentBytes)).toBe(0);
  const received = await receiver.evaluate(() => (window as unknown as PrivacyState).receivedMessages);
  expect(received.join("\n")).not.toContain(secretName);
  expect(await receiver.locator("body").textContent()).not.toContain(secretName);
  for (const page of [sender, receiver]) await expect(page.getByRole("heading", { name: "Transfer complete", exact: true })).toHaveCount(0);
  await expect(receiver.getByRole("button", { name: "Choose destination and save" })).toHaveCount(0);
  expect(errors).toEqual([]);
});
