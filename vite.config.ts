import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
// The runtime is plain ESM so the production server can run without node_modules.
// @ts-expect-error JavaScript runtime module intentionally has no TypeScript declarations.
import { createRendezvousRuntime } from "./scripts/rendezvous.mjs";
// @ts-expect-error JavaScript runtime module intentionally has no TypeScript declarations.
import { configureLocalHttpServer } from "./scripts/local-http-security.mjs";

const rendezvousPlugin = () => ({
  name: "airgap-local-rendezvous",
  configureServer(server: import("vite").ViteDevServer) {
    if (process.env.VITEST) return;
    if (server.httpServer) configureLocalHttpServer(server.httpServer);
    const rendezvous = createRendezvousRuntime();
    void rendezvous.start().catch((error: unknown) => {
      console.error("Unable to start LAN pairing service:", error);
    });
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/api/rendezvous/")) {
        next();
        return;
      }
      void rendezvous.handleHttp(request, response);
    });
    server.httpServer?.once("close", () => {
      void rendezvous.stop();
    });
  },
});

export default defineConfig({
  plugins: [react(), rendezvousPlugin()],
  build: {
    target: "es2022",
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
  },
  preview: {
    host: "127.0.0.1",
  },
  test: {
    include: ["tests/**/*.test.{ts,mjs}"],
    environment: "node",
  },
});
