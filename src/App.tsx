import { useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Fingerprint,
  QrCode,
  ShieldCheck,
} from "lucide-react";
import { Receiver } from "./components/Receiver";
import { Sender } from "./components/Sender";

type Mode = "sender" | "receiver";

export default function App() {
  const [mode, setMode] = useState<Mode>("sender");

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
        <div id="sender-workspace" hidden={mode !== "sender"}>
          <Sender active={mode === "sender"} />
        </div>
        <div id="receiver-workspace" hidden={mode !== "receiver"}>
          <Receiver active={mode === "receiver"} />
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
