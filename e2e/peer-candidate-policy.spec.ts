import { test, expect } from '@playwright/test';
let unsafe = '';
const publicLine = 'a=candidate:999 1 UDP 2113937151 203.0.113.1 9 typ host\r\n';
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
