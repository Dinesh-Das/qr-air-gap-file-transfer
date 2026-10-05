import { useState } from "react";
import {
  ArrowRight,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronLeft,
  Fingerprint,
  QrCode,
  ShieldCheck,
  HardDrive,
  Wifi,
} from "lucide-react";
import { Receiver } from "./components/Receiver";
import { Sender } from "./components/Sender";
import { LargeReceiver } from "./components/LargeReceiver";
import { LargeSender } from "./components/LargeSender";
import { WebRtcReceiver } from "./components/WebRtcReceiver";
import { WebRtcSender } from "./components/WebRtcSender";
import { TransferWakeLock } from "./components/TransferWakeLock";

type Mode = "sender" | "receiver";
type TransferEngine = "large" | "classic";
type Transport = "qr" | "webrtc";

export default function App() {
  const [mode, setMode] = useState<Mode>("sender");
  const [engine, setEngine] = useState<TransferEngine>("large");
  const [transport, setTransport] = useState<Transport | null>(null);
  const [webrtcBusy, setWebrtcBusy] = useState(false);

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand" aria-label="AirGap QR">
          <span className="brand-mark" aria-hidden="true">
            <QrCode size={22} strokeWidth={2.4} />
          </span>
          <span>
            <strong>AirGap</strong>
            <span>QR</span>
          </span>
        </div>

        {transport && <div className="mode-switch" role="group" aria-label="Transfer mode">
          <button
            type="button"
            aria-pressed={mode === "sender"}
            aria-controls="sender-workspace"
            className={mode === "sender" ? "active" : ""}
            disabled={transport === "webrtc" && webrtcBusy && mode !== "sender"}
            onClick={() => setMode("sender")}
          >
            <ArrowUpFromLine size={16} />
            Send
          </button>
          <button
            type="button"
            aria-pressed={mode === "receiver"}
            aria-controls="receiver-workspace"
            className={mode === "receiver" ? "active" : ""}
            disabled={transport === "webrtc" && webrtcBusy && mode !== "receiver"}
            onClick={() => setMode("receiver")}
          >
            <ArrowDownToLine size={16} />
            Receive
          </button>
        </div>}

        <div className="header-trust">
          <ShieldCheck size={17} />
          <span>{transport === "webrtc" ? "Local network" : "Local only"}</span>
        </div>
      </header>

      <main>
        {!transport && <TransferHome onChoose={(nextMode) => { setMode(nextMode); setTransport("webrtc"); }} onChooseQr={() => { setMode("sender"); setTransport("qr"); }} />}
        {transport && <div className="engine-switch transport-toolbar" role="group" aria-label="Transfer engine">
          <button type="button" disabled={transport === "webrtc" && webrtcBusy} onClick={() => setTransport(null)}><ChevronLeft size={16} />Home</button>
          {transport === "qr" && <>
            <button type="button" className={engine === "large" ? "active" : ""} aria-pressed={engine === "large"} onClick={() => setEngine("large")}><HardDrive size={16} />Large QRF3</button>
            <button type="button" className={engine === "classic" ? "active" : ""} aria-pressed={engine === "classic"} onClick={() => setEngine("classic")}><QrCode size={16} />Classic QRF2</button>
          </>}
          {transport === "webrtc" && <span className="transport-label"><Wifi size={16} />Wi-Fi / local network</span>}
        </div>}
        {transport === "qr" && <>
          <div id="sender-workspace" hidden={mode !== "sender"}>
            {engine === "large" ? <LargeSender active={mode === "sender"} /> : <Sender active={mode === "sender"} />}
          </div>
          <div id="receiver-workspace" hidden={mode !== "receiver"}>
            {engine === "large" ? <LargeReceiver active={mode === "receiver"} /> : <Receiver active={mode === "receiver"} />}
          </div>
        </>}
        {transport === "webrtc" && <>
          {webrtcBusy && <TransferWakeLock />}
          <div id="sender-workspace" hidden={mode !== "sender"}>{mode === "sender" && <WebRtcSender onBusyChange={setWebrtcBusy} />}</div>
          <div id="receiver-workspace" hidden={mode !== "receiver"}>{mode === "receiver" && <WebRtcReceiver onBusyChange={setWebrtcBusy} />}</div>
        </>}
      </main>

      <footer className="site-footer">
        <p>
          {transport === "webrtc"
            ? "Files travel directly between your laptops. No internet service or cloud upload."
            : transport === "qr"
              ? "QR mode uses no network transport or cloud upload. File data remains in the optical stream."
              : "Files travel directly between your laptops. No internet service or cloud upload."}
        </p>
        <span className="footer-protocol">
          <Fingerprint size={17} />
          Files checked for errors
        </span>
      </footer>
    </div>
  );
}

function TransferHome({ onChoose, onChooseQr }: { onChoose: (mode: Mode) => void; onChooseQr: () => void }) {
  return (
    <section className="transport-home">
      <div className="page-heading">
        <span className="eyebrow">Wi-Fi / local network</span>
        <h1>Move files between laptops.</h1>
        <p>Connect both laptops to the same Wi-Fi or local network. Open this app on each, then choose what to do on this laptop.</p>
      </div>
      <div className="transport-options">
        <button type="button" className="transport-option recommended" aria-label="Send" onClick={() => onChoose("sender")}>
          <span className="transport-option-icon"><ArrowUpFromLine size={30} /></span>
          <span className="transport-option-copy"><span className="option-kicker">From this laptop</span><strong>Send</strong><small>Choose files or a folder, then share a pairing code with the other laptop.</small><span className="option-facts"><span>Files and folders</span><span>Resume interrupted transfers</span></span></span>
          <ArrowRight className="option-arrow" size={21} />
        </button>
        <button type="button" className="transport-option" aria-label="Receive" onClick={() => onChoose("receiver")}>
          <span className="transport-option-icon"><ArrowDownToLine size={30} /></span>
          <span className="transport-option-copy"><span className="option-kicker">To this laptop</span><strong>Receive</strong><small>Enter the sender’s pairing code, check the device code, then receive and save your files.</small><span className="option-facts"><span>Encrypted connection</span><span>Verified files</span></span></span>
          <ArrowRight className="option-arrow" size={21} />
        </button>
      </div>
      <details className="other-methods">
        <summary>Other transfer methods</summary>
        <p>Use the screen and camera when the laptops must remain off a shared network.</p>
        <button type="button" className="button button-secondary" onClick={onChooseQr}><QrCode size={18} />Offline QR / Air-gap mode</button>
      </details>
    </section>
  );
}
