import { ShieldCheck } from "lucide-react";

export function VerifyDevice({ code, connected, confirmed, onConfirm, onReject }: {
  code: string; connected: boolean; confirmed: boolean;
  onConfirm: () => void; onReject: () => void;
}) {
  return <div className="verification-step">
    <h2>Verify the other laptop</h2>
    <p>Compare this verification code on both laptops. Continue only if the codes match.</p>
    <div className="authentication-card"><ShieldCheck size={22} /><div>
      <span>Device verification code</span><strong aria-label="Device verification code" style={{ fontSize: "clamp(1rem, 2vw, 1.5rem)", overflowWrap: "anywhere" }}>{code.match(/.{1,4}/g)?.join(" ")}</strong>
      <small>This is different from the pairing code.</small>
    </div></div>
    {confirmed ? <p role="status">Waiting for confirmation on the other laptop…</p> :
      <button className="button button-primary button-wide" disabled={!connected} onClick={onConfirm}>Codes match</button>}
    <button className="button button-danger button-wide confirm-button" onClick={onReject}>Codes do not match</button>
  </div>;
}
