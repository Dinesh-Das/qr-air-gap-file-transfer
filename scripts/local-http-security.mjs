export class LocalHttpError extends Error {
  constructor(message, status = 403) { super(message); this.status = status; }
}

/** Validate the actual socket authority; never trust forwarded host headers. */
export function assertLocalRequest(request, { mutation = false } = {}) {
  const address = request.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address)) {
    throw new LocalHttpError("Open the application on this laptop's local address.");
  }
  const host = request.headers.host;
  const match = typeof host === "string" && /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
  if (!match || Number(match[2] ?? 80) !== request.socket.localPort) {
    throw new LocalHttpError("Invalid local application address.");
  }
  if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
    throw new LocalHttpError("Invalid request target.", 400);
  }
  const origin = `http://${host}`;
  // An Origin cannot contain credentials, paths, multiple values or an opaque
  // 'null' origin. Compare the browser's serialization with this socket's host.
  const expectedOrigin = new URL(origin).origin;
  if (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin) {
    throw new LocalHttpError("Only the locally served application may access this endpoint.");
  }
  const site = request.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    throw new LocalHttpError("Cross-site requests are not allowed.");
  }
  if (mutation) {
    if (request.headers.origin !== expectedOrigin) {
      throw new LocalHttpError("A same-origin application request is required.");
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      throw new LocalHttpError("Pairing requests must use application/json.", 415);
    }
    if (request.headers["content-encoding"] !== undefined) {
      throw new LocalHttpError("Encoded request bodies are not supported.", 415);
    }
  }
}

export function configureLocalHttpServer(server) {
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.setTimeout(20_000);
  server.maxHeadersCount = 32;
  server.maxConnections = 64;
  server.maxRequestsPerSocket = 100;
  return server;
}
