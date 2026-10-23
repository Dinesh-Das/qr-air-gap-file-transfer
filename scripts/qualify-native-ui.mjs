// Derived from the preserved production-UI native-file harness. App modules are never patched.
import { readFile, writeFile, mkdir, stat, statfs, readdir, open, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { nativeUiPlan, nativeSampleComplete, writeNativeUiFixture } from './native-ui-contract.mjs';
import { readWindowsProcessMemory } from './browser-process-memory.mjs';
const work = fileURLToPath(new URL('../', import.meta.url)), root = resolve(process.env.QRFT_NATIVE_UI_OUTPUT ?? '');
if (!process.env.QRFT_NATIVE_UI_OUTPUT)
    throw Error('Use the guarded native UI runner.');
const p = JSON.parse(await readFile(root + '/CONTEXT.json', 'utf8')), plan = nativeUiPlan(process.env.QRFT_NATIVE_UI_MIB), FILE_BYTES = plan.fileBytes, RESERVE = plan.reserveBytes;
if (p.root !== root.replaceAll('\\', '/') || p.plan.fileBytes !== FILE_BYTES)
    throw Error('Native context mismatch');
await mkdir(root + '/evidence');
const fsStart = await statfs(root);
assert(fsStart.bavail * fsStart.bsize >= plan.requiredFreeBytes, 'Three-copy reserve preflight');
const fixture = await writeNativeUiFixture(root + '/source-aes-ctr.bin', String(plan.mib));
await writeFile(root + '/evidence/FIXTURE.json', JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx' });
const sha = b => createHash('sha256').update(b).digest('hex'), hash = async (path) => { const h = createHash('sha256'); for await (const b of createReadStream(path))
    h.update(b); return h.digest('hex'); };
assert.equal(sha(await readFile(process.execPath)), p.runtimeSha256);
for (const f of p.inputs)
    assert.equal(sha(await readFile(work + '/' + f.path)), f.sha256, f.path);
for (const f of p.builtAssets) {
    assert.equal(sha(await readFile(work + '/' + f.path)), f.sha256);
    assert.equal(sha(await readFile(p.stage + '/' + f.path)), f.sha256);
}
const free = await statfs(root);
assert(free.bavail * free.bsize >= RESERVE + 419430400 + 2 * FILE_BYTES, 'Disk reserve+margin+two copies');
const sourceBefore = await stat(fixture.path);
assert.equal(sourceBefore.size, FILE_BYTES);
assert.equal(await hash(fixture.path), fixture.sha256);
console.log(JSON.stringify({ root }));
await writeFile(root + '/evidence/RUNNER.source.txt', await readFile(new URL(import.meta.url)), { flag: 'wx' });
await writeFile(root + '/PLAN.json', JSON.stringify({ at: new Date().toISOString(), root, current: p, source: fixture.path, sourceSha256: fixture.sha256, sourceBefore, fileBytes: FILE_BYTES, reserve: RESERVE, scope: 'Smoke or5GiB determined by immutable plan; current exact productionUI/assets; two dedicated Chromium profiles; realsamehost productionrendezvous andRTC. Native disk source throughpickeradapter; realOPFSdestination adapter. Deliberately deny post-save store deletion to retainbothcopies; cleanupsuccess nottestedhere. StrictWindowsnativeprocessobserver; missingPID invalidatesmeasurement. NotactualOSpicker/physicalnetwork/GUI/cleanOS/generalresourcequalification.' }, null, 2) + '\n', { flag: 'wx' });
const { chromium, expect } = await import(pathToFileURL(p.stage + '/node_modules/@playwright/test/index.mjs'));
const { freeSignalPort } = await import(pathToFileURL(p.stage + '/tests/free-signal-port.mjs'));
const port = await freeSignalPort();
let signalPort = await freeSignalPort();
while (signalPort === port)
    signalPort = await freeSignalPort();
const url = 'http://127.0.0.1:' + port;
let server, serverClosed, serverOutput = '', sender, receiver, error, phase = 'startup', sampling = false, stopping = false, timer, abortedForDisk = false;
const contexts = [], endpoints = [], memory = [], resources = [], errors = [], cleanupErrors = [], events = [], browserVersions = [];
const progress = await open(root + '/evidence/progress.log', 'wx');
const note = async (event, extra = {}) => { const row = { at: new Date().toISOString(), event, ...extra }; events.push(row); await progress.write(JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); };
const snapshot = page => page.evaluate(() => { const x = window.__nativeUi; return { counts: x.counts, ackIndices: [...x.ackIndices], binaryBytes: x.binaryBytes, binaryFrames: x.binaryFrames, manifest: x.manifest, nativeReadBytes: x.nativeReadBytes, nativeReads: x.nativeReads, maxNativeRead: x.maxNativeRead, snapshots: x.snapshots, pickerCalls: x.pickerCalls, preservationAttempts: x.preservationAttempts, nativeSize: x.file?.size, nativeName: x.file?.name, nativeModified: x.file?.lastModified }; });
async function sample() { if (sampling || stopping)
    return; sampling = true; const samplePhase = phase; try {
    const fs = await statfs(root);
    resources.push({ at: new Date().toISOString(), phase: samplePhase, free: fs.bavail * fs.bsize });
    if (fs.bavail * fs.bsize < RESERVE) {
        abortedForDisk = true;
        for (const context of contexts)
            await context.close();
        throw Error('Disk reserve violated');
    }
    for (const endpoint of endpoints) {
        const row = { requestedAtMs: Date.now(), role: endpoint.role, phase: samplePhase };
        try {
            row.before = (await endpoint.cdp.send('SystemInfo.getProcessInfo')).processInfo;
            row.native = await readWindowsProcessMemory(row.before.map(x => x.id));
            row.after = (await endpoint.cdp.send('SystemInfo.getProcessInfo')).processInfo;
        }
        catch (e) {
            row.error = String(e);
            row.observerDiagnostic = e.observerDiagnostic;
            row.cause = e.cause ? { code: e.cause.code, signal: e.cause.signal, killed: e.cause.killed } : undefined;
        }
        row.at = new Date().toISOString();
        row.phase = samplePhase === phase ? phase : samplePhase + '->' + phase;
        memory.push(row);
        await appendFile(root + '/evidence/native-samples.ndjson', JSON.stringify(row) + '\n');
    }
}
catch (e) {
    errors.push(String(e));
}
finally {
    sampling = false;
} }
async function checkpointSample() { while (sampling)
    await new Promise(r => setTimeout(r, 20)); await sample(); }
try {
    server = spawn(process.execPath, [p.stage + '/scripts/serve.mjs'], { cwd: root, env: { ...process.env, QRFT_PORT: String(port), QRFT_SIGNAL_PORT: String(signalPort) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    serverClosed = once(server, 'exit');
    await new Promise((resolve, reject) => { let done = false; const end = e => { if (done)
        return; done = true; clearTimeout(t); e ? reject(e) : resolve(); }, t = setTimeout(() => end(Error('Runtime startup timeout: ' + serverOutput)), 10000); server.stdout.on('data', b => { serverOutput += b; if (serverOutput.includes('AirGap QR is running'))
        end(); }); server.stderr.on('data', b => serverOutput += b); server.once('error', end); server.once('exit', () => end(Error('Runtime exited: ' + serverOutput))); });
    for (const asset of p.builtAssets) {
        const response = await fetch(url + '/' + asset.path.slice(5));
        assert(response.ok);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(sha(bytes), asset.sha256);
        const copy = root + '/evidence/TESTED-DIST/' + asset.path.slice(5);
        await mkdir(dirname(copy), { recursive: true });
        await writeFile(copy, bytes, { flag: 'wx' });
    }
    for (const role of ['sender', 'receiver']) {
        const context = await chromium.launchPersistentContext(root + '/' + role + '-profile', { channel: process.env.QRFT_TEST_BROWSER_CHANNEL, headless: true });
        contexts.push(context);
        browserVersions.push({ role, version: context.browser().version(), channel: process.env.QRFT_TEST_BROWSER_CHANNEL ?? 'bundled' });
        context.setDefaultTimeout(5000);
        const cdp = await context.browser().newBrowserCDPSession();
        endpoints.push({ role, cdp });
        await context.exposeFunction('__nativeStage', event => { if (role === 'sender' && event === 'manifest')
            phase = 'receive-and-verify'; });
        await context.addInitScript(() => { const s = window.__nativeUi = { counts: {}, ackIndices: new Set(), binaryBytes: 0, binaryFrames: 0, manifest: null, nativeReadBytes: 0, nativeReads: 0, maxNativeRead: 0, snapshots: 0, pickerCalls: 0, preservationAttempts: 0, preserve: false }; const send = RTCDataChannel.prototype.send; RTCDataChannel.prototype.send = function (data) { if (typeof data === 'string') {
            const c = JSON.parse(data);
            s.counts[c.type] = (s.counts[c.type] ?? 0) + 1;
            if (c.type === 'ack') {
                if (!Array.isArray(c.indices))
                    throw Error('ACK indices missing');
                for (const index of c.indices) {
                    if (!Number.isSafeInteger(index) || index < 0)
                        throw Error('Invalid ACK index');
                    s.ackIndices.add(index);
                }
            }
            if (c.type === 'manifest') {
                s.manifest = c.manifest;
                void window.__nativeStage('manifest');
            }
        }
        else {
            s.binaryBytes += data instanceof Blob ? data.size : data.byteLength;
            s.binaryFrames++;
        } return Reflect.apply(send, this, [data]); }; const remove = FileSystemDirectoryHandle.prototype.removeEntry; FileSystemDirectoryHandle.prototype.removeEntry = function (name, options) { if (s.preserve && this.name === 'qr-air-gap-block-store-v1' && options?.recursive) {
            s.preservationAttempts++;
            throw new DOMException('Diagnostic preservation: receive copy retained', 'NotAllowedError');
        } return Reflect.apply(remove, this, [name, options]); }; });
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(role + ': ' + e.message));
        await page.goto(url);
        browserVersions.at(-1).storage = await page.evaluate(async () => {
            try { return { estimate: await navigator.storage.estimate(), persisted: await navigator.storage.persisted(), secureContext: isSecureContext }; }
            catch (error) { return { error: String(error) }; }
        });
        await page.getByRole('button', { name: role === 'sender' ? 'Send' : 'Receive', exact: true }).click();
        if (role === 'sender')
            sender = page;
        else
            receiver = page;
    }
    await checkpointSample();
    timer = setInterval(() => void sample(), 2000);
    await sender.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'native-input'; i.hidden = true; document.body.appendChild(i); });
    await sender.locator('#native-input').setInputFiles(fixture.path);
    await sender.evaluate(fileBytes => { const s = window.__nativeUi, file = document.querySelector('#native-input').files[0]; if (!(file instanceof File) || file.size !== fileBytes)
        throw Error('Native file size mismatch'); s.file = file; const slice = file.slice.bind(file); file.slice = (start, end) => { if (end - start > 4194304 || start < 0 || end > file.size)
        throw Error('Unexpected source range'); const b = slice(start, end), read = b.arrayBuffer.bind(b); b.arrayBuffer = async () => { const bytes = await read(); s.nativeReads++; s.nativeReadBytes += bytes.byteLength; s.maxNativeRead = Math.max(s.maxNativeRead, bytes.byteLength); return bytes; }; return b; }; const handle = { kind: 'file', name: file.name, getFile: async () => { s.snapshots++; return file; } }; window.showDirectoryPicker = async () => { s.pickerCalls++; return { kind: 'directory', name: 'native-source', async *entries() { yield [file.name, handle]; } }; }; }, FILE_BYTES);
    await receiver.evaluate(() => { window.showDirectoryPicker = async () => { window.__nativeUi.pickerCalls++; return (await navigator.storage.getDirectory()).getDirectoryHandle('native-destination', { create: true }); }; });
    phase = 'preparing-and-pairing';
    await sender.getByRole('button', { name: 'Choose folder', exact: true }).click();
    const begin = Date.now();
    await sender.getByRole('button', { name: 'Get pairing code', exact: true }).click();
    await expect(sender.locator('.pairing-code-large')).toHaveText(/^\d{3} \d{3}$/);
    const code = (await sender.locator('.pairing-code-large').innerText()).replaceAll(' ', '');
    await receiver.getByRole('textbox', { name: 'Six-digit pairing code' }).fill(code);
    await receiver.getByRole('button', { name: 'Connect to sender', exact: true }).click();
    for (const page of [sender, receiver])
        await expect(page.getByRole('button', { name: 'Codes match', exact: true })).toBeEnabled();
    assert.equal(await sender.getByLabel('Device verification code').textContent(), await receiver.getByLabel('Device verification code').textContent());
    const before = await snapshot(sender);
    assert.equal(before.binaryBytes, 0);
    assert.equal(before.manifest, null);
    await sender.getByRole('button', { name: 'Codes match', exact: true }).click();
    const senderOnly = await snapshot(sender);
    assert.equal(senderOnly.binaryBytes, 0);
    assert.equal(senderOnly.manifest, null);
    await receiver.getByRole('button', { name: 'Codes match', exact: true }).click();
    await note('both-devices-confirmed', { elapsedMs: Date.now() - begin });
    await expect(receiver.getByRole('button', { name: 'Choose destination and save', exact: true })).toBeVisible({ timeout: Math.max(1, begin + plan.deadlineMs - Date.now()) });
    assert(!abortedForDisk);
    phase = 'received-verified';
    await checkpointSample();
    const received = await snapshot(sender);
    assert(received.manifest);
    assert.equal(received.binaryFrames, Math.ceil(received.manifest.totalBytes / received.manifest.blockSize));
    assert.equal(received.binaryBytes, received.manifest.totalBytes + received.binaryFrames * 44);
    await note('received-and-verified', { elapsedMs: Date.now() - begin, source: received });
    await receiver.screenshot({ path: root + '/evidence/received-verified.png', fullPage: true });
    await receiver.evaluate(() => { window.__nativeUi.preserve = true; });
    phase = 'save-and-verify';
    await receiver.getByRole('button', { name: 'Choose destination and save', exact: true }).click();
    await expect(receiver.getByRole('heading', { name: 'Transfer complete', exact: true })).toBeVisible({ timeout: Math.max(1, begin + plan.deadlineMs - Date.now()) });
    await expect(receiver.getByRole('button', { name: 'Retry temporary storage cleanup', exact: true })).toBeVisible();
    assert(!abortedForDisk);
    phase = 'saved-with-copy-retained';
    await checkpointSample();
    const source = await snapshot(sender), destination = await snapshot(receiver);
    assert.equal(source.nativeReadBytes, 2 * FILE_BYTES);
    assert.equal(source.maxNativeRead, 4194304);
    assert.equal(source.snapshots, 2);
    assert.equal(source.pickerCalls, 1);
    assert.equal(destination.pickerCalls, 1);
    assert.equal(destination.preservationAttempts, 1);
    assert.equal(destination.ackIndices.length, source.binaryFrames);
    assert.deepEqual([...destination.ackIndices].sort((a, b) => a - b), Array.from({ length: source.binaryFrames }, (_, i) => i));
    await note('saved-and-verified', { elapsedMs: Date.now() - begin, source, destination });
    await receiver.screenshot({ path: root + '/evidence/saved-verified.png', fullPage: true });
    const descriptors = await receiver.evaluate(async () => { const root = await navigator.storage.getDirectory(), stores = await root.getDirectoryHandle('qr-air-gap-block-store-v1'), data = []; for await (const [name, h] of stores.entries()) {
        if (h.kind === 'directory') {
            const f = await (await h.getFileHandle('payload.bin')).getFile();
            data.push({ name, size: f.size });
        }
    } const saved = await (await (await (await root.getDirectoryHandle('native-destination')).getDirectoryHandle('native-source')).getFileHandle('source-aes-ctr.bin')).getFile(); return { stores: data, saved: { name: saved.name, size: saved.size } }; });
    assert.equal(descriptors.stores.length, 1);
    assert.equal(descriptors.stores[0].size, source.manifest.totalBytes);
    assert.equal(descriptors.saved.size, FILE_BYTES);
    await writeFile(root + '/evidence/BROWSER-COPIES.json', JSON.stringify(descriptors, null, 2), { flag: 'wx' });
}
catch (e) {
    error = { message: e.message, stack: e.stack };
    try {
        await receiver?.screenshot({ path: root + '/evidence/failure-receiver.png', fullPage: true });
    }
    catch { }
}
finally {
    stopping = true;
    clearInterval(timer);
    while (sampling)
        await new Promise(r => setTimeout(r, 20));
    for (const endpoint of endpoints)
        try {
            await endpoint.cdp.detach();
        }
        catch (e) {
            cleanupErrors.push(String(e));
        }
    for (const context of contexts)
        try {
            await context.close();
        }
        catch (e) {
            cleanupErrors.push(String(e));
        }
    if (server && server.exitCode === null) {
        server.kill();
        try {
            await serverClosed;
        }
        catch (e) {
            cleanupErrors.push(String(e));
        }
    }
    await progress.close();
}
let independent;
try {
    if (!error) {
        const sent = events.find(x => x.event === 'saved-and-verified').source, manifest = sent.manifest, files = [];
        async function find(dir) { for (const e of await readdir(dir, { withFileTypes: true })) {
            const path = dir + '/' + e.name;
            assert(!e.isSymbolicLink(), 'Unexpected receiver profile link');
            if (e.isDirectory())
                await find(path);
            else if (e.isFile() && path.replaceAll('\\', '/').includes('/Default/File System/')) {
                const s = await stat(path);
                if (s.size === FILE_BYTES || s.size === manifest.totalBytes)
                    files.push({ path, size: s.size });
            }
        } }
        await find(root + '/receiver-profile');
        const payload = files.filter(x => x.size === manifest.totalBytes), saved = files.filter(x => x.size === FILE_BYTES);
        assert.equal(payload.length, 1);
        assert.equal(saved.length, 1);
        const handles = await Promise.all([fixture.path, payload[0].path, saved[0].path].map(x => open(x, 'r'))), h = createHash('sha256');
        try {
            for (let offset = 0; offset < FILE_BYTES; offset += 4194304) {
                const length = Math.min(4194304, FILE_BYTES - offset), buffers = [Buffer.alloc(length), Buffer.alloc(length), Buffer.alloc(length)];
                for (let i = 0; i < 3; i++) {
                    let got = 0;
                    while (got < length) {
                        const r = await handles[i].read(buffers[i], got, length - got, offset + got);
                        assert(r.bytesRead > 0);
                        got += r.bytesRead;
                    }
                }
                assert(buffers[0].equals(buffers[1]), 'Payload mismatch at ' + offset);
                assert(buffers[0].equals(buffers[2]), 'Saved mismatch at ' + offset);
                h.update(buffers[0]);
            }
        }
        finally {
            for (const handle of handles)
                await handle.close();
        }
        assert.equal(h.digest('hex'), fixture.sha256);
        const metadata = Buffer.from(JSON.stringify({ schema: 'airgap-qr-tree', version: 3, rootName: 'native-source', directories: [], files: [{ path: 'source-aes-ctr.bin', size: String(FILE_BYTES), sha256: fixture.sha256, lastModified: Math.trunc(sourceBefore.mtimeMs) }] })), footer = Buffer.alloc(16);
        footer.writeBigUInt64LE(BigInt(metadata.length));
        footer.write('QRF3END1', 8);
        const stream = createHash('sha256');
        for await (const b of createReadStream(fixture.path))
            stream.update(b);
        stream.update(metadata);
        stream.update(footer);
        assert.equal(stream.digest('hex'), manifest.streamSha256);
        const f = await open(payload[0].path, 'r');
        try {
            const tail = Buffer.alloc(metadata.length + 16);
            assert.equal((await f.read(tail, 0, tail.length, FILE_BYTES)).bytesRead, tail.length);
            assert(tail.equals(Buffer.concat([metadata, footer])));
        }
        finally {
            await f.close();
        }
        assert.equal(await hash(payload[0].path), manifest.streamSha256);
        independent = { payload: payload[0], saved: saved[0], sourceSha256: fixture.sha256, streamSha256: manifest.streamSha256, everyByteCompared: FILE_BYTES, passed: true };
    }
}
catch (e) {
    error ??= { message: e.message, stack: e.stack };
}
const sourceAfter = await stat(fixture.path);
assert.equal(sourceAfter.size, sourceBefore.size);
assert.equal(sourceAfter.mtimeMs, sourceBefore.mtimeMs);
assert.equal(await hash(fixture.path), fixture.sha256);
for (const f of p.inputs)
    assert.equal(sha(await readFile(work + '/' + f.path)), f.sha256);
for (const f of p.builtAssets)
    assert.equal(sha(await readFile(work + '/' + f.path)), f.sha256);
const fs1 = await statfs(root);
resources.push({ at: new Date().toISOString(), phase: 'closed', free: fs1.bavail * fs1.bsize });
const nativeComplete = memory.length > 0 && memory.every(nativeSampleComplete) && ['sender', 'receiver'].every(role => memory.some(x => x.role === role)), functionalPassed = !error && !!independent?.passed && errors.length === 0 && cleanupErrors.length === 0, record = { at: new Date().toISOString(), recordedUtcDate: new Date().toISOString().slice(0, 10), root, plan, browserVersions, sourceCommit: p.sourceCommit, currentAssets: p.builtAssets, fixture, error, errors, cleanupErrors, functionalPassed, nativeComplete, sampledReserveMet: resources.every(x => x.free >= RESERVE), sourceBefore, sourceAfter, independent, events, memory, resources, serverOutput, releaseReady: false, scope: 'CurrentproductionUI nativeFile→realrendezvous/samehostRTC→durableOPFS→injectedOPFSdestination; byte-for-byteoriginal/payload/saved comparison and independentfile/streamhashes. Two isolated Chromium browsers, strictnativeprocessobserver. Post-save deletion deliberatelydenied toretainreceivecopy; appcorrectlyshowscleanuprequired, notcleanupsuccess. Mocksource/destinationpickers,noactualOSpicker/physicalnetwork/GUI/cleanOS/broadresourcequalification. Functional/memory/disk statuses separated; oldmemoryfailures notrelabeled.' };
record.performanceAccepted = false;
record.resourceMatrixAccepted = false;
record.smokeOnly = plan.smokeOnly;
record.payloadRetention = 'Source andbothcopies kept on this runner; workflow artifacts exclude payload/profile binaries. Hosted copies unavailable after VM teardown; deterministic fixture and complete byte/hash audit metadata retained.';
await writeFile(root + '/evidence/RAW.json', JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ root, functionalPassed, nativeComplete, reserveMet: record.sampledReserveMet, error, errors, cleanupErrors, memorySamples: memory.length }));
process.exitCode = functionalPassed && nativeComplete && record.sampledReserveMet && errors.length === 0 ? 0 : 1;
