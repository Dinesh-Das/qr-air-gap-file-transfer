import { describe, expect, it } from "vitest";
import { assertLocalSignalCandidates, PeerCandidatePolicyError, createAuthenticationDigest } from "../src/lib/webrtc-signaling";
const sdp = (address: string, kind = "host") => `v=0\r\na=candidate:1 1 UDP 2113937151 ${address} 5000 typ ${kind}\r\n`;
describe("incoming peer candidate policy", () => {
  it.each(["10.1.2.3", "172.16.0.1", "192.168.1.2", "169.254.1.2", "127.0.0.1", "::1", "fd00::1", "fe80::1", "peer.local"])("accepts local host %s without altering transcript", address => {
    const value = sdp(address);
    const before = createAuthenticationDigest("a".repeat(32), value, value);
    expect(() => assertLocalSignalCandidates(value)).not.toThrow();
    expect(createAuthenticationDigest("a".repeat(32), value, value)).toEqual(before);
  });
  it.each(["203.0.113.1", "8.8.8.8", "172.32.0.1", "2001:db8::1", "peer.example"])("rejects non-local host %s", address => {
    expect(() => assertLocalSignalCandidates(sdp(address))).toThrow(PeerCandidatePolicyError);
  });
  it.each(["relay", "srflx", "prflx"])("rejects private-address %s candidates", kind => {
    expect(() => assertLocalSignalCandidates(sdp("192.168.1.2", kind))).toThrow(PeerCandidatePolicyError);
  });
  it("rejects a mixed local/public description rather than sanitizing it", () => {
    expect(() => assertLocalSignalCandidates(sdp("192.168.1.2") + sdp("203.0.113.1"))).toThrow(PeerCandidatePolicyError);
  });
  it.each(["", "v=0\r\n", "x".repeat(128 * 1024 + 1), "v=0\r\na=candidate:bad\r\n"])("rejects missing/oversized/malformed candidates %#", value => {
    expect(() => assertLocalSignalCandidates(value)).toThrow(PeerCandidatePolicyError);
  });
});
