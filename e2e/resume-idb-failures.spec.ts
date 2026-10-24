import { test, expect } from "@playwright/test";
import { build } from "vite";
import { resolve } from "node:path";

let sourceModule: string;
test.beforeAll(async () => {
  const output = await build({
    configFile: false, logLevel: "silent",
    build: { write: false, minify: false, target: "es2022",
      lib: { entry: resolve("e2e/fixtures/resume-idb-probe.ts"), formats: ["es"] } },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!("output" in result)) throw Error("Missing browser probe output");
  const entry = result.output.find(item => item.type === "chunk" && item.isEntry);
  if (!entry || entry.type !== "chunk") throw Error("Missing browser probe entry");
  sourceModule = entry.code;
});

const stores = [
  { method: "listResumeCheckpoints", database: "qr-air-gap-resume", empty: [] },
  { method: "loadSenderSession", database: "qr-air-gap-sender-resume", empty: null },
  { method: "loadLargeSenderSession", database: "qr-air-gap-large-sender-resume", empty: null },
  { method: "loadWebRtcSource", database: "airgap-webrtc-sender", empty: null },
];

for (const store of stores) for (const boundary of ["pending-request", "successful-request"] as const) {
  test(`${store.method} reports ${boundary} transaction abort without an unhandled rejection and can retry`, async ({ page }, testInfo) => {
    await page.route("**/__resume-idb-probe", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Resume transaction probe</title>" }));
    await page.route("**/__resume-idb-probe.js", route => route.fulfill({ contentType: "text/javascript", body: sourceModule }));
    await page.goto("/__resume-idb-probe");
    const result = await page.evaluate(async ({ method, database, boundary }) => {
      const moduleUrl = "/__resume-idb-probe.js";
      const api = await import(/* @vite-ignore */ moduleUrl);
      const load = () => api[method]();
      await load(); // Create the actual native database before injecting one abort.
      const unhandled: { name: string; message: string }[] = [];
      const observe = (event: PromiseRejectionEvent) => {
        unhandled.push({ name: event.reason?.name, message: String(event.reason?.message ?? event.reason) });
        event.preventDefault();
      };
      window.addEventListener("unhandledrejection", observe);
      let injected = 0, caught: { name: string; message: string } | null = null;
      const transaction = IDBDatabase.prototype.transaction;
      const getAll = IDBObjectStore.prototype.getAll, openCursor = IDBIndex.prototype.openCursor;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = Reflect.apply(transaction, this, args);
        if (this.name === database && boundary === "pending-request" && injected++ === 0) queueMicrotask(() => tx.abort());
        return tx;
      };
      const abortAfterRead = (request: IDBRequest) => {
        if (request.transaction?.db.name === database && boundary === "successful-request" && injected++ === 0)
          request.addEventListener("success", () => request.transaction!.abort(), { once: true });
        return request;
      };
      IDBObjectStore.prototype.getAll = function (...args) { return abortAfterRead(Reflect.apply(getAll, this, args)) as IDBRequest<unknown[]>; };
      IDBIndex.prototype.openCursor = function (...args) { return abortAfterRead(Reflect.apply(openCursor, this, args)) as IDBRequest<IDBCursorWithValue | null>; };
      try {
        try { await load(); } catch (error) {
          const e = error as Error; caught = { name: e.name, message: e.message };
        }
        // Native request/transaction events and rejection reporting use separate tasks.
        await new Promise(resolve => setTimeout(resolve, 50));
      } finally {
        IDBDatabase.prototype.transaction = transaction;
        IDBObjectStore.prototype.getAll = getAll;
        IDBIndex.prototype.openCursor = openCursor;
        window.removeEventListener("unhandledrejection", observe);
      }
      const retry = await load();
      return { method, database, boundary, injected, caught, unhandled, retry };
    }, { ...store, boundary });
    await testInfo.attach("native-idb-observation", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
    expect(result.injected).toBe(1);
    if (boundary === "pending-request") expect(result.caught?.name).toBe("AbortError");
    else {
      expect(result.caught?.name).toBe("Error");
      expect(result.caught?.message).toMatch(/transaction|not committed/i);
    }
    expect(result.unhandled).toEqual([]);
    expect(result.retry).toEqual(store.empty);
  });
}
