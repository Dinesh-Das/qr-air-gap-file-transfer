// Derived from the preserved production-UI native-file harness. App modules are never patched.
import { readFile, writeFile, mkdir, stat, statfs, readdir, open, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { closeMixedAudit, stableMixedNativeSample } from './native-mixed-safety.mjs';
import { nativeMixedTreePlan } from './native-mixed-tree.mjs';
import { auditNativeMixedSource } from './native-mixed-contract.mjs';
import { installNativeMixedCounters, bindNativeMixedSource, mixedBrowserSnapshot, auditSavedMixedBrowser } from './native-mixed-browser.mjs';
import { createNativeMixedComparator, auditNativeMixedPayload } from './native-mixed-audit.mjs';
import { readWindowsProcessMemory } from './browser-process-memory.mjs';
import { cpuProfilePlan, summarizeCpuProfile } from './native-cpu-profile.mjs';
const work = fileURLToPath(new URL('../', import.meta.url)), root = resolve(process.env.QRFT_NATIVE_MIXED_OUTPUT ?? '');
if (!process.env.QRFT_NATIVE_MIXED_OUTPUT)
    throw Error('Use the guarded native UI runner.');
const p = JSON.parse(await readFile(root + '/CONTEXT.json', 'utf8')), plan = nativeMixedTreePlan(process.env.QRFT_NATIVE_MIXED_MODE ?? 'qualification'), FILE_BYTES = plan.fileBytes, RESERVE = plan.reserveBytes;
const cpuProfile = cpuProfilePlan(process.env.QRFT_NATIVE_MIXED_CPU_PROFILE);
assert.deepEqual(p.cpuProfile, cpuProfile);
if (p.root !== root.replaceAll('\\', '/') || p.plan.fileBytes !== FILE_BYTES)
    throw Error('Native context mismatch');
await mkdir(root + '/evidence');
const fsStart = await statfs(root);
assert(fsStart.bavail * fsStart.bsize >= plan.requiredFreeBytes, 'Three-copy reserve preflight');
assert.equal(p.fixtureSha256,createHash('sha256').update(await readFile(p.fixturePath)).digest('hex'));
const fixture=JSON.parse(await readFile(p.fixturePath,'utf8'));
const sourceAudit=await auditNativeMixedSource(fixture,plan.mode);
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
const sourceBefore=sourceAudit;
await writeFile(root+'/evidence/RUNNER.source.txt',await readFile(new URL(import.meta.url)),{flag:'wx'});
await writeFile(root+'/PLAN.json',JSON.stringify({root,current:p,fixturePath:p.fixturePath,sourceBefore,
 scope:'Fixed native mixed tree; injected directory/destination pickers; same-host production UI/RTC; receive copy deliberately retained; independent fresh-profile saved-tree and physical payload audit. No physical LAN/native permissions/GUI/general performance or resource acceptance.'},null,2)+'\n',{flag:'wx'});
const { chromium, expect } = await import(pathToFileURL(p.stage + '/node_modules/@playwright/test/index.mjs'));
const { freeSignalPort } = await import(pathToFileURL(p.stage + '/tests/free-signal-port.mjs'));
const port = await freeSignalPort();
let signalPort = await freeSignalPort();
while (signalPort === port)
    signalPort = await freeSignalPort();
const url = 'http://127.0.0.1:' + port;
let server, serverClosed, serverOutput = '', sender, receiver, error, phase = 'startup', sampling = false, stopping = false, timer, abortedForDisk = false;
const contexts = [], endpoints = [], memory = [], resources = [], errors = [], cleanupErrors = [], events = [], browserVersions = [];
const profilers = [], cpuCaptures = [];
const progress = await open(root + '/evidence/progress.log', 'wx');
const note = async (event, extra = {}) => { const row = { at: new Date().toISOString(), event, ...extra }; events.push(row); await progress.write(JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); };
const snapshot=mixedBrowserSnapshot;
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
        await installNativeMixedCounters(context,()=>{if(role==='sender')phase='receive-and-verify';});
        const page = await context.newPage();
        page.on('pageerror', e => errors.push(role + ': ' + e.message));
        await page.goto(url);
        if (cpuProfile.enabled) {
            const client = await context.newCDPSession(page), capture = { role, startedAt: Date.now(), started: false };
            profilers.push({ client, capture });
            await client.send('Profiler.enable');
            await client.send('Profiler.setSamplingInterval', { interval: cpuProfile.intervalMicros });
            await client.send('Profiler.start');
            capture.started = true;
        }
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
    const inputBinding=await bindNativeMixedSource(sender,fixture);
    await note('native-input-bound',inputBinding);
    await receiver.evaluate(() => { window.showDirectoryPicker = async () => { window.__nativeMixed.pickerCalls++; return (await navigator.storage.getDirectory()).getDirectoryHandle('native-destination', { create: true }); }; });
    phase = 'preparing-and-pairing';
    const selectionBegin=Date.now();
    await sender.getByRole('button',{name:'Choose folder',exact:true}).click();
    await expect(sender.getByRole('button',{name:'Get pairing code',exact:true})).toBeEnabled();
    await note('source-selected',{elapsedMs:Date.now()-selectionBegin,scope:'UI folder action to pairing enabled, including enumeration/readiness; directory handles injected.'});
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
    await receiver.evaluate(() => { window.__nativeMixed.preserve = true; });
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
    assert.equal(Object.keys(source.snapshots).length,fixture.files.length);
    assert(Object.values(source.snapshots).every(n=>n===2));
    assert.equal(source.pickerCalls, 1);
    assert.equal(destination.pickerCalls, 1);
    assert.equal(destination.preservationAttempts, 1);
    assert.equal(destination.ackIndices.length, source.binaryFrames);
    assert.deepEqual([...destination.ackIndices].sort((a, b) => a - b), Array.from({ length: source.binaryFrames }, (_, i) => i));
    await note('saved-and-verified', { elapsedMs: Date.now() - begin, source, destination });
    await receiver.screenshot({ path: root + '/evidence/saved-verified.png', fullPage: true });
    const descriptors=await receiver.evaluate(async()=>{
      const stores=await(await navigator.storage.getDirectory()).getDirectoryHandle('qr-air-gap-block-store-v1'),rows=[];
      for await(const[name,h]of stores.entries())if(h.kind==='directory')rows.push({name,size:(await(await h.getFileHandle('payload.bin')).getFile()).size});
      return rows;
    });
    assert.equal(descriptors.length,1);assert.equal(descriptors[0].size,source.manifest.totalBytes);
    assert.equal(source.manifest.totalBytes,sourceAudit.streamBytes);assert.equal(source.manifest.streamSha256,sourceAudit.streamSha256);
    await writeFile(root+'/evidence/BROWSER-COPIES.json',JSON.stringify(descriptors,null,2)+'\n',{flag:'wx'});
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
    for (const { client, capture } of profilers) {
        try {
            if (!capture.started) throw Error('CPU profiler did not start.');
            const { profile } = await client.send('Profiler.stop');
            capture.stoppedAt = Date.now();
            const path = root + '/evidence/cpu-' + capture.role + '.cpuprofile';
            await writeFile(path, JSON.stringify(profile) + '\n', { flag: 'wx' });
            capture.path = path;
            capture.summary = summarizeCpuProfile(profile);
            capture.valid = true;
        } catch (e) { capture.error = String(e); capture.valid = false; }
        finally {
            cpuCaptures.push(capture);
            try { await client.detach(); } catch (e) { cleanupErrors.push(String(e)); }
        }
    }
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
try{
 if(!error){
  phase='independent-saved-audit';
  const reopened=await chromium.launchPersistentContext(root+'/receiver-profile',{channel:process.env.QRFT_TEST_BROWSER_CHANNEL,headless:true});
  const comparator=createNativeMixedComparator(fixture);let auditCdp;
  try{
   browserVersions.push({role:'receiver-audit',version:reopened.browser().version(),channel:process.env.QRFT_TEST_BROWSER_CHANNEL??'bundled'});
   await reopened.route(url+'/native-independent-audit',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Independent filesystem audit</title><link rel="icon" href="data:,">'}));
   await reopened.exposeFunction('__compareNativeMixed',comparator.compare);
   const page=await reopened.newPage();page.on('pageerror',e=>errors.push('audit: '+e.message));await page.goto(url+'/native-independent-audit');
   auditCdp=await reopened.browser().newBrowserCDPSession();endpoints.length=0;endpoints.push({role:'receiver-audit',cdp:auditCdp});
   stopping=false;await checkpointSample();timer=setInterval(()=>void sample(),2000);
   const saved=await auditSavedMixedBrowser(page,fixture),bytes=comparator.finish();
   assert.equal(saved.everyByteCompared,FILE_BYTES);assert.equal(saved.files,fixture.files.length);assert.equal(saved.directories,fixture.directories.length);
   await checkpointSample();independent={saved,bytes};
  }finally{
   stopping=true;clearInterval(timer);while(sampling)await new Promise(r=>setTimeout(r,20));
   await closeMixedAudit([()=>comparator.close(),async()=>{if(auditCdp)await auditCdp.detach();},()=>reopened.close()],cleanupErrors);
  }
  phase='independent-physical-payload';
  const payload=await auditNativeMixedPayload(root+'/receiver-profile',fixture,sourceAudit);
  independent={...independent,payload,passed:true};
 }
}catch(e){error??={message:e.message,stack:e.stack};}
const sourceAfter=await auditNativeMixedSource(fixture,plan.mode);
assert.equal(sourceAfter.streamSha256,sourceBefore.streamSha256);
for (const f of p.inputs)
    assert.equal(sha(await readFile(work + '/' + f.path)), f.sha256);
for (const f of p.builtAssets)
    assert.equal(sha(await readFile(work + '/' + f.path)), f.sha256);
const fs1 = await statfs(root);
resources.push({ at: new Date().toISOString(), phase: 'closed', free: fs1.bavail * fs1.bsize });
const nativeComplete = memory.length > 0 && memory.every(stableMixedNativeSample) && ['sender','receiver','receiver-audit'].every(role=>memory.some(x=>x.role===role)), functionalPassed = !error && !!independent?.passed && errors.length === 0 && cleanupErrors.length === 0, record = { at: new Date().toISOString(), recordedUtcDate: new Date().toISOString().slice(0, 10), root, plan, browserVersions, sourceCommit: p.sourceCommit, currentAssets: p.builtAssets, fixture, error, errors, cleanupErrors, functionalPassed, nativeComplete, sampledReserveMet: resources.every(x => x.free >= RESERVE), sourceBefore, sourceAfter, independent, events, memory, resources, serverOutput, releaseReady: false, scope: 'Fixed native FileList source with injected folder/destination handles; real same-host production UI/RTC/OPFS. Independent fresh-profile saved-tree byte comparison and closed-profile payload/footer audit. Native rows include sender/receiver/auditor; periodic samples miss peaks. Intentional cleanup denial retains receive copy. No physical LAN/native permissions/GUI/general resource or throughput acceptance.' };
record.performanceAccepted = false;
record.cpuProfile = { ...cpuProfile, captures: cpuCaptures };
record.cpuProfileComplete = cpuProfile.enabled ? cpuCaptures.length === 2 && ['sender', 'receiver'].every(role => cpuCaptures.some(c => c.role === role && c.valid)) : null;
record.resourceMatrixAccepted = false;
record.smokeOnly = plan.smokeOnly;
record.payloadRetention = 'Source and both copies kept on this runner; workflow artifacts exclude payload/profile binaries. Hosted copies unavailable after VM teardown; deterministic fixture and complete byte/hash audit metadata retained.';
await writeFile(root + '/evidence/RAW.json', JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ root, functionalPassed, nativeComplete, reserveMet: record.sampledReserveMet, error, errors, cleanupErrors, memorySamples: memory.length }));
process.exitCode = functionalPassed && nativeComplete && record.sampledReserveMet && errors.length === 0 && (!cpuProfile.enabled || record.cpuProfileComplete) ? 0 : 1;
