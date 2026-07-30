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

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const distributionDirectory = resolve(projectDirectory, "dist");
const rawPort = process.env.QRFT_PORT ?? "4173";
const port = Number(rawPort);
const host = "127.0.0.1";

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

createServer((request, response) => {
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

  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const realCandidate = realpathSync(candidate);
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
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
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
}).listen(port, host, () => {
  console.log(`AirGap QR is running at http://${host}:${port}`);
  console.log("Press Ctrl+C to stop.");
});
