import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import {
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { createRendezvousRuntime } from "./rendezvous.mjs";
import { assertLocalRequest, configureLocalHttpServer } from "./local-http-security.mjs";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const distributionDirectory = resolve(projectDirectory, "dist");
const rawPort = process.env.QRFT_PORT ?? "4173";
const port = Number(rawPort);
const host = "127.0.0.1";
const rendezvous = createRendezvousRuntime();

if (!existsSync(join(distributionDirectory, "index.html"))) {
  console.error('No production build found. Run "npm run build" first.');
  process.exit(1);
}
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error("QRFT_PORT must be an integer from 1 to 65535.");
  process.exit(1);
}

const realDistributionDirectory = realpathSync(distributionDirectory);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

const securityHeaders = {
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const server = configureLocalHttpServer(createServer(async (request, response) => {
  for (const [name, value] of Object.entries(securityHeaders)) {
    response.setHeader(name, value);
  }
  try { assertLocalRequest(request); } catch (error) {
    response.writeHead(error.status ?? 403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error.message);
    return;
  }
  if (await rendezvous.handleHttp(request, response)) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  let requestPath;
  try {
    requestPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
  } catch {
    response.writeHead(400);
    response.end("Invalid URL encoding");
    return;
  }

  const relativePath = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const normalizedPath = normalize(relativePath);
  const candidate = resolve(distributionDirectory, normalizedPath);
  const pathFromDistribution = relative(distributionDirectory, candidate);

  if (
    pathFromDistribution === ".." ||
    pathFromDistribution.startsWith(`..${sep}`) ||
    isAbsolute(pathFromDistribution)
  ) {
    response.writeHead(400);
    response.end("Invalid path");
    return;
  }

  let realCandidate;
  try {
    if (!statSync(candidate).isFile()) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    realCandidate = realpathSync(candidate);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
    response.writeHead(code === "ENOENT" || code === "ENOTDIR" ? 404 : 500);
    response.end(code === "ENOENT" || code === "ENOTDIR"
      ? "Not found"
      : "Unable to resolve asset");
    return;
  }

  const realCandidateRelative = relative(realDistributionDirectory, realCandidate);
  if (
    realCandidateRelative === ".." ||
    realCandidateRelative.startsWith(`..${sep}`) ||
    isAbsolute(realCandidateRelative)
  ) {
    response.writeHead(400);
    response.end("Invalid path");
    return;
  }

  const filePath = realCandidate;
  const contentType =
    contentTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";

  response.writeHead(200, {
    "Content-Type": contentType,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500);
    response.end("Unable to read asset");
  });
  stream.pipe(response);
}));
server.on("error", (error) => {
  console.error(error.code === "EADDRINUSE"
    ? "The application is already open, or its local address is in use. Close the other runtime and launch again."
    : `Unable to start the local application: ${error.message}`);
  process.exitCode = 1;
  void shutdown().catch((shutdownError) => {
    console.error(`Unable to finish shutdown: ${shutdownError.message}`);
    if (process.connected) process.disconnect();
  });
});
server.listen(port, host, () => {
  console.log(`AirGap QR is running at http://${host}:${port}`);
  console.log("Choose Send or Receive to check the local connection service.");
  console.log("Press Ctrl+C to stop.");
  process.send?.({ type: "qrft-runtime-ready", url: `http://${host}:${port}` });
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await rendezvous.stop();
  await closed;
  if (process.connected) process.disconnect();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void shutdown().catch((error) => {
    console.error(`Unable to finish shutdown: ${error.message}`);
    process.exitCode = 1;
  }); });
}

// A launcher controls only its own child over a private IPC channel. Closing
// the launcher also closes this runtime instead of leaving occupied ports.
if (process.send) {
  const stopFromLauncher = () => { void shutdown().catch((error) => {
    console.error(`Unable to finish shutdown: ${error.message}`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }); };
  process.on("message", (message) => {
    if (message?.type === "qrft-runtime-stop") stopFromLauncher();
  });
  process.once("disconnect", stopFromLauncher);
}
