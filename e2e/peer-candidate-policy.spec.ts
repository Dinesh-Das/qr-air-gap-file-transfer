import { test, expect } from '@playwright/test';
let unsafe = '';
const publicLine = 'a=candidate:999 1 UDP 2113937151 203.0.113.1 9 typ host\r\n';
for (const role of ['sender', 'receiver'] as const) test('local candidate failure gives network recovery without blaming the service: ' + role, async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const state = window as unknown as { sourceReads: number; sentBytes: number; manifests: number };
    state.sourceReads = 0; state.sentBytes = 0; state.manifests = 0;
    const file = new File([Uint8Array.of(1)], 'local-probe.txt', { lastModified: 7 });
    const slice = file.slice.bind(file);
    file.slice = (...args) => { state.sourceReads++; return slice(...args); };
    window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'local-probe',
      async *entries() { yield [file.name, { kind: 'file', name: file.name, getFile: async () => file }]; }
    }) as unknown as FileSystemDirectoryHandle;
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function(data) {
      if (typeof data === 'string') { if (JSON.parse(data).type === 'manifest') state.manifests++; }
      else state.sentBytes += data instanceof Blob ? data.size : data.byteLength;
      return Reflect.apply(send, this, [data]);
    };
  });
  await page.goto('/');
  const offer = await page.evaluate(async () => {
    const maker = new RTCPeerConnection({ iceServers: [] });
    try { maker.createDataChannel('template'); return (await maker.createOffer()).sdp!; }
    finally { maker.close(); }
  });
  const validPeerOffer = offer + 'a=candidate:999 1 UDP 2113937151 127.0.0.1 9 typ host\r\n';
  let rooms = 0, answers = 0;
  await page.route('**/api/rendezvous/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rooms')) rooms++;
    if (path.endsWith('/answer')) answers++;
    await route.fulfill({ json: path.endsWith('/health') ? { ready: true, protocol: 2 }
      : path.endsWith('/join') ? { joinId: 'c'.repeat(32), sessionId: 'a'.repeat(32), sdp: validPeerOffer }
        : { ok: true } });
  });
  await page.evaluate(() => {
    const get = Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype, 'localDescription')!.get!;
    Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', { configurable: true, get() {
      const description = Reflect.apply(get, this, []) as RTCSessionDescription | null;
      if (!description) return description;
      const sdp = description.sdp.split(/\r?\n/).filter(line => !line.startsWith('a=candidate:')).join('\r\n');
      return { type: description.type, sdp, toJSON: () => ({ type: description.type, sdp }) };
    } });
  });
  await page.getByRole('button', { name: role === 'sender' ? 'Send' : 'Receive', exact: true }).click();
  if (role === 'sender') {
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await page.getByRole('button', { name: 'Get pairing code', exact: true }).click();
  } else {
    await page.getByRole('textbox', { name: 'Six-digit pairing code' }).fill('123456');
    await page.getByRole('button', { name: 'Connect to sender', exact: true }).click();
  }
  await expect(page.locator('.transfer-problem')).toContainText('The browser could not find a local network connection.');
  await expect(page.locator('.transfer-problem')).toContainText('retry pairing');
  await expect(page.locator('.transfer-problem')).not.toContainText('service is unavailable');
  await expect(page.locator('.transfer-problem')).not.toContainText('files could not be prepared');
  await expect(page.locator('.transfer-error-details pre')).toBeHidden();
  await page.locator('.transfer-error-details summary').click();
  await expect(page.locator('.transfer-error-details pre')).toContainText('LocalCandidateUnavailableError');
  expect(await page.evaluate(() => {
    const state = window as unknown as { sourceReads: number; sentBytes: number; manifests: number };
    return { reads: state.sourceReads, bytes: state.sentBytes, manifests: state.manifests };
  })).toEqual({ reads: 0, bytes: 0, manifests: 0 });
  expect({ rooms, answers }).toEqual({ rooms: 0, answers: 0 });
  expect(errors).toEqual([]);
});

for (const role of ['receiver', 'sender'] as const) test('rejects explicit public peer candidates before native SDP processing: ' + role, async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { descriptions: RTCSessionDescriptionInit[]; delegatedCalls: number };
    state.descriptions = []; state.delegatedCalls = 0;
    RTCPeerConnection.prototype.setRemoteDescription = async function(description) {
      state.descriptions.push(description!);
      // Deliberately NEVER delegate to native SDP processing/ICE.
      throw new Error('Probe blocked native SDP processing');
    };
    const snapshot = new File([Uint8Array.of(1)], 'probe.txt', { lastModified: 7 });
    window.showDirectoryPicker = async () => ({ kind: 'directory', name: 'probe-folder',
      async *entries() { yield ['probe.txt', { kind: 'file', name: 'probe.txt', getFile: async () => snapshot }]; }
    }) as unknown as FileSystemDirectoryHandle;
  });
  let sessionId = '';
  await page.route('**/api/rendezvous/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    let value: unknown;
    if (path.endsWith('/health')) value = { ready: true, protocol: 2 };
    else if (path.endsWith('/join')) value = { joinId: 'c'.repeat(32), sessionId: 'a'.repeat(32), sdp: unsafe };
    else if (request.method() === 'DELETE') value = { ok: true };
    else if (path.endsWith('/rooms')) { sessionId = request.postDataJSON().sessionId; unsafe = request.postDataJSON().sdp.replaceAll('a=setup:actpass', 'a=setup:active') + publicLine; value = { roomId: 'b'.repeat(32), ownerToken: 'd'.repeat(64), code: '123456', expiresAt: Date.now() + 120000 }; }
    else value = { status: 'answered', sessionId, sdp: unsafe };
    await route.fulfill({ json: value });
  });
  await page.goto('/');
  const localTemplate = await page.evaluate(async () => {
    const maker = new RTCPeerConnection({ iceServers: [] });
    try {
      maker.createDataChannel('template');
      await maker.setLocalDescription(await maker.createOffer());
      return maker.localDescription!.sdp;
    } finally { maker.close(); }
  });
  unsafe = localTemplate + publicLine;
  expect(unsafe).toContain('a=fingerprint:');
  expect(unsafe).toContain('m=application');
  if (role === 'receiver') {
    await page.getByRole('button', { name: 'Receive', exact: true }).click();
    await page.getByRole('textbox', { name: 'Six-digit pairing code' }).fill('123456');
    await page.getByRole('button', { name: 'Connect to sender', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await page.getByRole('button', { name: 'Get pairing code' }).click();
  }
  await expect(page.locator('.transfer-problem')).toBeVisible();
  const observed = await page.evaluate(() => {
    const state = window as unknown as { descriptions: RTCSessionDescriptionInit[]; delegatedCalls: number };
    return { calls: state.descriptions.length, delegatedCalls: state.delegatedCalls };
  });
  expect(observed).toEqual({ calls: 0, delegatedCalls: 0 });
  await expect(page.getByText('The other device supplied unsupported local connection details. Open the current app on both devices, connect to the same local network, and retry pairing.', { exact: true })).toBeVisible();
  console.log(JSON.stringify({ role, ...observed }));
});
