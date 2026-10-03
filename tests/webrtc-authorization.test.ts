import { describe, expect, it } from "vitest";
import { PeerAuthorization } from "../src/lib/webrtc-authorization";
import { decodeOfflineControl, encodeOfflineControl } from "../src/lib/webrtc-protocol";

const session = "1".repeat(32);
const offer = "v=0\r\na=fingerprint:sha-256 OFFER\r\n";
const answer = "v=0\r\na=fingerprint:sha-256 ANSWER\r\n";

describe("human device authorization", () => {
  it("requires independent local and remote confirmations and binds their transcript", async () => {
    const sender = await PeerAuthorization.create(session, offer, answer);
    const receiver = await PeerAuthorization.create(session, offer, answer);
    expect(sender.code).toBe(receiver.code);
    expect(() => sender.requireAuthorized()).toThrow(/before both/);
    receiver.acceptConfirmation(sender.confirmLocal());
    expect(() => receiver.requireAuthorized()).toThrow(/before both/);
    expect(() => sender.requireAuthorized()).toThrow(/before both/);
    const confirmation = receiver.confirmLocal();
    expect(decodeOfflineControl(encodeOfflineControl(confirmation))).toEqual(confirmation);
    sender.acceptConfirmation(confirmation);
    expect(sender.authorized).toBe(true);
    expect(receiver.authorized).toBe(true);
    sender.acceptConfirmation(confirmation);
    expect(sender.authorized).toBe(true);
  });

  it.each([
    ["altered offer", session, offer + "a=setup:active\r\n", answer],
    ["altered answer", session, offer, answer + "a=setup:passive\r\n"],
    ["stale session", "2".repeat(32), offer, answer],
    ["ambiguous transcript boundary", session, offer + answer, "x"],
  ])("rejects %s and makes the failed authorization terminal", async (_, otherSession, otherOffer, otherAnswer) => {
    const current = await PeerAuthorization.create(session, offer, answer);
    const other = await PeerAuthorization.create(otherSession, otherOffer, otherAnswer);
    current.confirmLocal();
    expect(() => current.acceptConfirmation(other.confirmLocal())).toThrow(/does not match/);
    expect(current.authorized).toBe(false);
    expect(() => current.confirmLocal()).toThrow(/expired/);
  });

  it("does not reuse confirmation after cancellation or reconnect", async () => {
    const first = await PeerAuthorization.create(session, offer, answer);
    first.acceptConfirmation(first.confirmLocal());
    first.close();
    expect(() => first.requireAuthorized()).toThrow();
    const next = await PeerAuthorization.create("3".repeat(32), offer, answer);
    expect(next.authorized).toBe(false);
    expect(next.locallyConfirmed).toBe(false);
  });

  it("rejects legacy unbound and malformed confirmations", () => {
    for (const message of [
      { type: "peer-confirmed" },
      { type: "peer-confirmed", sessionId: session, transcriptHash: "bad" },
      { type: "peer-confirmed", sessionId: "bad", transcriptHash: "a".repeat(64) },
    ]) expect(() => decodeOfflineControl(JSON.stringify(message))).toThrow(/confirmation/);
  });
});
