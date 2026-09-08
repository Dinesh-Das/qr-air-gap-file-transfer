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
  Zap,
} from "lucide-react";
import { Receiver } from "./components/Receiver";
import { Sender } from "./components/Sender";
import { LargeReceiver } from "./components/LargeReceiver";
import { LargeSender } from "./components/LargeSender";
import { WebRtcReceiver } from "./components/WebRtcReceiver";
import { WebRtcSender } from "./components/WebRtcSender";

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
            Sender
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
            Receiver
          </button>
        </div>}

        <div className="header-trust">
          <ShieldCheck size={17} />
          <span>{transport === "webrtc" ? "Local network" : "Local only"}</span>
        </div>
      </header>

      <main>
        {!transport && <TransportHome onChoose={setTransport} />}
        {transport && <div className="engine-switch transport-toolbar" role="group" aria-label="Transfer engine">
          <button type="button" disabled={transport === "webrtc" && webrtcBusy} onClick={() => setTransport(null)}><ChevronLeft size={16} />Methods</button>
          {transport === "qr" && <>
            <button type="button" className={engine === "large" ? "active" : ""} aria-pressed={engine === "large"} onClick={() => setEngine("large")}><HardDrive size={16} />Large QRF3</button>
            <button type="button" className={engine === "classic" ? "active" : ""} aria-pressed={engine === "classic"} onClick={() => setEngine("classic")}><QrCode size={16} />Classic QRF2</button>
          </>}
          {transport === "webrtc" && <span className="transport-label"><Wifi size={16} />Offline WebRTC</span>}
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
          <div id="sender-workspace" hidden={mode !== "sender"}>{mode === "sender" && <WebRtcSender onBusyChange={setWebrtcBusy} />}</div>
          <div id="receiver-workspace" hidden={mode !== "receiver"}>{mode === "receiver" && <WebRtcReceiver onBusyChange={setWebrtcBusy} />}</div>
        </>}
      </main>

      <footer className="site-footer">
        <p>
          {transport === "webrtc"
            ? "No internet service or cloud upload. WebRTC sends directly over your existing local network."
            : transport === "qr"
              ? "QR mode uses no network transport or cloud upload. File data remains in the optical stream."
              : "No cloud upload. Choose optical isolation or direct transfer over your existing local network."}
        </p>
        <span className="footer-protocol">
          <Fingerprint size={17} />
          SHA-256 integrity checks
        </span>
      </footer>
    </div>
  );
}

function TransportHome({ onChoose }: { onChoose: (transport: Transport) => void }) {
  return (
    <section className="transport-home">
      <div className="page-heading">
        <span className="eyebrow">Choose a transfer path</span>
        <h1>Move files without the cloud.</h1>
        <p>Use optical QR for a true network air gap, or use direct browser-to-browser transfer for much higher speed on an authorized offline local network.</p>
      </div>
      <div className="transport-options">
        <button type="button" className="transport-option" onClick={() => onChoose("qr")}>
          <span className="transport-option-icon"><QrCode size={30} /></span>
          <span className="transport-option-copy"><span className="option-kicker">No network</span><strong>QR file transfer</strong><small>Keep the existing QRF3 and QRF2 optical modes. Best when the devices must remain network-isolated.</small><span className="option-facts"><span>Air-gap compatible</span><span>Slow for GBs</span></span></span>
          <ArrowRight className="option-arrow" size={21} />
        </button>
        <button type="button" className="transport-option recommended" onClick={() => onChoose("webrtc")}>
          <span className="recommended-badge"><Zap size={12} /> Faster</span>
          <span className="transport-option-icon"><Wifi size={30} /></span>
          <span className="transport-option-copy"><span className="option-kicker">Same offline Wi-Fi</span><strong>WebRTC file transfer</strong><small>Pair with a six-digit code, then send encrypted file blocks directly over the local network with resume.</small><span className="option-facts"><span>LAN-only pairing</span><span>SHA-256 verified</span></span></span>
          <ArrowRight className="option-arrow" size={21} />
        </button>
      </div>
      <div className="home-boundary"><ShieldCheck size={18} /><span><strong>Security boundary:</strong> WebRTC is local-only but is not an air gap. Follow your organization’s data-transfer policy and use only authorized devices and files.</span></div>
    </section>
  );
}
