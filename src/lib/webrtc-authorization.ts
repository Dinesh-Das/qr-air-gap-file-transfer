import { bytesToHex, type OfflineControlMessage } from "./webrtc-protocol";
import { createAuthenticationCode, createAuthenticationDigest } from "./webrtc-signaling";

type Confirmation = Extract<OfflineControlMessage, { type: "peer-confirmed" }>;

/** One object per connection; never reuse a human decision across sessions. */
export class PeerAuthorization {
  private local = false;
  private remote = false;
  private closed = false;

  private constructor(
    readonly code: string,
    private readonly sessionId: string,
    private readonly transcriptHash: string,
  ) {}

  static async create(sessionId: string, offer: string, answer: string): Promise<PeerAuthorization> {
    return new PeerAuthorization(
      await createAuthenticationCode(sessionId, offer, answer), sessionId,
      bytesToHex(createAuthenticationDigest(sessionId, offer, answer)),
    );
  }

  get locallyConfirmed(): boolean { return !this.closed && this.local; }
  get authorized(): boolean { return !this.closed && this.local && this.remote; }

  confirmLocal(): Confirmation {
    if (this.closed) throw new Error("This device verification has expired. Reconnect.");
    this.local = true;
    return { type: "peer-confirmed", sessionId: this.sessionId, transcriptHash: this.transcriptHash };
  }

  acceptConfirmation(message: Confirmation): void {
    if (this.closed || message.sessionId !== this.sessionId || message.transcriptHash !== this.transcriptHash) {
      this.close();
      throw new Error("Device verification does not match this connection. Reconnect and compare the codes on both laptops.");
    }
    this.remote = true;
  }

  requireAuthorized(): void {
    if (!this.authorized) throw new Error("Transfer data arrived before both devices were verified.");
  }

  close(): void {
    this.closed = true;
    this.local = false;
    this.remote = false;
  }
}
