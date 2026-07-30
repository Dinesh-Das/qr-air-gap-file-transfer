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
        <a className="brand" href="#" aria-label="AirGap QR home">
          <span className="brand-mark" aria-hidden="true">
            <QrCode size={22} strokeWidth={2.4} />
          </span>
          <span>
            <strong>AirGap</strong>
            <span>QR</span>
          </span>
        </a>

        <div className="mode-switch" role="tablist" aria-label="Transfer mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "sender"}
            className={mode === "sender" ? "active" : ""}
            onClick={() => setMode("sender")}
          >
            <ArrowUpFromLine size={16} />
            Sender
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "receiver"}
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
        {mode === "sender" ? <Sender /> : <Receiver />}
      </main>

      <footer className="site-footer">
        <p>
          No network transport. No cloud upload. Your data remains in this
          browser and in the QR stream.
        </p>
        <span className="footer-protocol">
          <Fingerprint size={17} />
          SHA-256 verified
        </span>
      </footer>
    </div>
  );
}
