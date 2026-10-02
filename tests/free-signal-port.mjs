import { randomInt } from "node:crypto";
import { createServer } from "node:http";
import dgram from "node:dgram";

// TCP and UDP dynamic/excluded ranges differ on Windows. Probe both transports
// on the actual wildcard bind address, outside the usual dynamic client range.
export async function freeSignalPort() {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = randomInt(20000, 45000);
    const tcp = createServer();
    const udp = dgram.createSocket("udp4");
    let udpBound = false;
    try {
      await new Promise((resolve, reject) => { tcp.once("error", reject); tcp.listen(port, "0.0.0.0", resolve); });
      await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(port, "0.0.0.0", resolve); });
      udpBound = true;
      return port;
    } catch (error) {
      if (error.code !== "EACCES" && error.code !== "EADDRINUSE") throw error;
    } finally {
      if (udpBound) await new Promise((resolve) => udp.close(resolve));
      if (tcp.listening) await new Promise((resolve) => tcp.close(resolve));
    }
  }
  throw new Error("Could not allocate a TCP/UDP test port.");
}
