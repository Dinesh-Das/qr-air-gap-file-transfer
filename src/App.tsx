import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Fingerprint,
  QrCode,
  ShieldCheck,
  HardDrive,
} from "lucide-react";
import { Receiver } from "./components/Receiver";
import { Sender } from "./components/Sender";
import { LargeReceiver } from "./components/LargeReceiver";
import { LargeSender } from "./components/LargeSender";

type Mode = "sender" | "receiver";
type TransferEngine = "large" | "classic";

export default function App() {
  const [mode, setMode] = useState<Mode>("sender");
  const [engine, setEngine] = useState<TransferEngine>("large");

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

        <div className="mode-switch" role="group" aria-label="Transfer mode">
          <button
            type="button"
            aria-pressed={mode === "sender"}
            aria-controls="sender-workspace"
            className={mode === "sender" ? "active" : ""}
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
            onClick={() => setMode("receiver")}
          >
            <ArrowDownToLine size={16} />
            Receiver
          </button>
        </div>

        <div className="header-trust">
          <ShieldCheck size={17} />
          <span>Local only</span>
        </div>
      </header>

      <main>
        <div className="engine-switch" role="group" aria-label="Transfer engine">
          <button type="button" className={engine === "large" ? "active" : ""} aria-pressed={engine === "large"} onClick={() => setEngine("large")}><HardDrive size={16} />Large QRF3</button>
          <button type="button" className={engine === "classic" ? "active" : ""} aria-pressed={engine === "classic"} onClick={() => setEngine("classic")}><QrCode size={16} />Classic QRF2</button>
        </div>
        <div id="sender-workspace" hidden={mode !== "sender"}>
          {engine === "large" ? <LargeSender active={mode === "sender"} /> : <Sender active={mode === "sender"} />}
        </div>
        <div id="receiver-workspace" hidden={mode !== "receiver"}>
          {engine === "large" ? <LargeReceiver active={mode === "receiver"} /> : <Receiver active={mode === "receiver"} />}
        </div>
      </main>

      <footer className="site-footer">
        <p>
          No network transport. No cloud upload. Your data remains in this
          browser and in the QR stream.
        </p>
        <span className="footer-protocol">
          <Fingerprint size={17} />
          SHA-256 integrity checks
        </span>
      </footer>
    </div>
  );
}
