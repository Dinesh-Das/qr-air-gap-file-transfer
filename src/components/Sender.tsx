import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import QRCode from "qrcode";
import {
  AlertTriangle,
  ChevronRight,
  CircleStop,
  FileArchive,
  Folder,
  FolderOpen,
  Pause,
  Play,
  QrCode as QrCodeIcon,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";
import {
  collectDirectoryHandle,
  collectInputFiles,
  createArchive,
  extractArchive,
  validatePortableRootName,
  verifyEntryCollections,
  type SelectedEntry,
} from "../lib/archive";
import {
  prepareTransfer,
  type PreparedLoopFrame,
  type PreparedTransfer,
} from "../lib/transfer";
import {
  estimateTransferSeconds,
  formatBytes,
  formatClock,
  formatDuration,
} from "../lib/format";

const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

type ErrorCorrectionLevel = "L" | "M" | "Q";

interface FolderSelection {
  rootName: string;
  entries: SelectedEntry[];
  capturesEmptyDirectories: boolean;
}

interface SenderSettings {
  chunkSize: number;
  framesPerSecond: number;
  errorCorrectionLevel: ErrorCorrectionLevel;
}

export function Sender() {
  const [selection, setSelection] = useState<FolderSelection | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [settings, setSettings] = useState<SenderSettings>({
    chunkSize: 700,
    framesPerSecond: 6,
    errorCorrectionLevel: "M",
  });
  const [prepared, setPrepared] = useState<PreparedTransfer | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [framePosition, setFramePosition] = useState(0);
  const [loopCount, setLoopCount] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderGenerationRef = useRef(0);
  const selectionGenerationRef = useRef(0);
  const buildGenerationRef = useRef(0);

  const fileEntries = useMemo(
    () => selection?.entries.filter((entry) => !entry.directory) ?? [],
    [selection],
  );
  const directoryCount = useMemo(
    () => selection?.entries.filter((entry) => entry.directory).length ?? 0,
    [selection],
  );
  const totalBytes = useMemo(
    () => fileEntries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    [fileEntries],
  );
  const estimatedSeconds = estimateTransferSeconds(
    prepared?.archiveBytes.length ?? totalBytes,
    settings.chunkSize,
    settings.framesPerSecond,
  );
  const activeFrame = prepared?.loopFrames[framePosition];

  const clearTransfer = useCallback(() => {
    buildGenerationRef.current += 1;
    renderGenerationRef.current += 1;
    setPreparing(false);
    setPrepared(null);
    setPlaying(false);
    setPaused(false);
    setFramePosition(0);
    setLoopCount(0);
    setStartedAt(null);
    setElapsedSeconds(0);
  }, []);

  const useSelection = useCallback(
    (next: FolderSelection) => {
      clearTransfer();
      setError(null);
      const selectedBytes = next.entries.reduce(
        (sum, entry) => sum + (entry.directory ? 0 : entry.bytes.length),
        0,
      );
      if (selectedBytes > MAX_SOURCE_BYTES) {
        setSelection(null);
        setError(
          `This folder is ${formatBytes(selectedBytes)}. The v1 in-memory safety limit is ${formatBytes(MAX_SOURCE_BYTES)}.`,
        );
        return;
      }
      setSelection(next);
    },
    [clearTransfer],
  );

  const pickFolder = useCallback(async () => {
    const generation = ++selectionGenerationRef.current;
    setCollecting(true);
    setError(null);
    try {
      if (window.showDirectoryPicker) {
        const handle = await window.showDirectoryPicker({
          id: "qr-air-gap-sender",
          mode: "read",
        });
        const entries = await collectDirectoryHandle(handle, MAX_SOURCE_BYTES);
        if (generation !== selectionGenerationRef.current) return;
        useSelection({
          rootName: handle.name,
          entries,
          capturesEmptyDirectories: true,
        });
        return;
      }
      inputRef.current?.click();
    } catch (caught) {
      if (generation !== selectionGenerationRef.current) return;
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(toMessage(caught, "The folder could not be read."));
    } finally {
      if (generation === selectionGenerationRef.current) setCollecting(false);
    }
  }, [useSelection]);

  const onInputChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      const generation = ++selectionGenerationRef.current;
      setCollecting(true);
      setError(null);
      try {
        const pickerPath = files[0].webkitRelativePath;
        const rootName = pickerPath
          ? pickerPath.split("/")[0]
          : "Transferred folder";
        const entries = await collectInputFiles(files, MAX_SOURCE_BYTES);
        if (generation !== selectionGenerationRef.current) return;
        useSelection({
          rootName,
          entries,
          capturesEmptyDirectories: false,
        });
      } catch (caught) {
        if (generation !== selectionGenerationRef.current) return;
        setError(toMessage(caught, "The selected folder could not be read."));
      } finally {
        event.target.value = "";
        if (generation === selectionGenerationRef.current) setCollecting(false);
      }
    },
    [useSelection],
  );

  const buildStream = useCallback(async () => {
    if (!selection) return;
    clearTransfer();
    const generation = buildGenerationRef.current;
    setPreparing(true);
    setError(null);
    try {
      // Files are kept as raw Uint8Arrays; no text decoding or re-encoding
      // occurs anywhere in the sender pipeline.
      validatePortableRootName(selection.rootName);
      const archiveBytes = createArchive(selection.entries);
      if (archiveBytes.length > MAX_ARCHIVE_BYTES) {
        throw new Error(
          `The ZIP is ${formatBytes(archiveBytes.length)}, above the receiver’s ${formatBytes(MAX_ARCHIVE_BYTES)} safety limit.`,
        );
      }
      const sourceRoundTrip = await verifyEntryCollections(
        selection.entries,
        extractArchive(archiveBytes),
        selection.rootName,
      );
      if (!sourceRoundTrip.ok) {
        throw new Error(
          "ZIP round-trip verification failed; the QR stream was not started.",
        );
      }
      if (generation !== buildGenerationRef.current) return;
      const nextPrepared = await prepareTransfer(archiveBytes, {
        rootName: selection.rootName,
        chunkSize: settings.chunkSize,
      });
      if (generation !== buildGenerationRef.current) return;
      setPrepared(nextPrepared);
      setFramePosition(0);
      setLoopCount(0);
      setPlaying(true);
      setPaused(false);
      setStartedAt(Date.now());
    } catch (caught) {
      if (generation !== buildGenerationRef.current) return;
      setError(toMessage(caught, "The QR stream could not be prepared."));
    } finally {
      if (generation === buildGenerationRef.current) setPreparing(false);
    }
  }, [clearTransfer, selection, settings.chunkSize]);

  const stopStream = useCallback(() => {
    renderGenerationRef.current += 1;
    setPlaying(false);
    setPaused(false);
  }, []);

  useEffect(() => {
    if (!playing || paused || !prepared || prepared.loopFrames.length === 0) {
      return;
    }

    let cancelled = false;
    const generation = ++renderGenerationRef.current;
    let timeoutId: number | undefined;

    const drawAndSchedule = async () => {
      const frame = prepared.loopFrames[framePosition];
      const canvas = canvasRef.current;
      if (!frame || !canvas || cancelled || generation !== renderGenerationRef.current) {
        return;
      }
      try {
        await QRCode.toCanvas(canvas, frame.encoded, {
          errorCorrectionLevel: settings.errorCorrectionLevel,
          margin: 2,
          width: 720,
          color: {
            dark: "#132019",
            light: "#ffffff",
          },
        });
      } catch (caught) {
        setError(
          toMessage(
            caught,
            "This frame does not fit at the selected chunk size and error-correction level.",
          ),
        );
        setPlaying(false);
        return;
      }

      timeoutId = window.setTimeout(() => {
        if (cancelled || generation !== renderGenerationRef.current) return;
        setFramePosition((current) => {
          const next = current + 1;
          if (next >= prepared.loopFrames.length) {
            setLoopCount((count) => count + 1);
            return 0;
          }
          return next;
        });
      }, 1000 / settings.framesPerSecond);
    };

    void drawAndSchedule();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [
    framePosition,
    paused,
    playing,
    prepared,
    settings.errorCorrectionLevel,
    settings.framesPerSecond,
  ]);

  useEffect(() => {
    if (!startedAt || !playing) return;
    const updateElapsed = () =>
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [playing, startedAt]);

  const updateNumberSetting = (
    key: "chunkSize" | "framesPerSecond",
    value: string,
  ) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    const [minimum, maximum] =
      key === "chunkSize" ? [200, 900] : [1, 12];
    const bounded = Math.min(maximum, Math.max(minimum, Math.round(parsed)));
    setSettings((current) => ({ ...current, [key]: bounded }));
  };

  return (
    <section className="workspace" aria-labelledby="sender-title">
      <div className="page-heading">
        <span className="eyebrow">Optical sender</span>
        <h1 id="sender-title">Turn a folder into a verified QR stream.</h1>
        <p>
          Choose a small folder. AirGap QR packages every file as raw bytes and
          loops the complete transfer until you stop it.
        </p>
      </div>

      <div className="transfer-card sender-layout">
        <div className="panel">
          <div className="panel-kicker">
            <FolderOpen size={14} />
            Source
          </div>
          <h2>Select a folder</h2>
          <p className="panel-description">
            Nested paths, Unicode names, binary files, and zero-byte files are
            kept intact.
          </p>

          {!selection ? (
            <div className="drop-zone">
              <div className="drop-zone-content">
                <span className="upload-icon">
                  <Upload size={25} />
                </span>
                <h3>Choose the folder to transfer</h3>
                <p>Recommended: under 10 MB · Hard limit: 25 MB</p>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={collecting}
                  onClick={() => void pickFolder()}
                >
                  {collecting ? (
                    <>
                      <span className="spinner" />
                      Reading folder…
                    </>
                  ) : (
                    <>
                      <FolderOpen size={16} />
                      Browse folder
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="selection-card">
              <div className="selection-header">
                <div className="folder-identity">
                  <span className="folder-icon">
                    <Folder size={21} />
                  </span>
                  <span>
                    <strong title={selection.rootName}>
                      {selection.rootName}
                    </strong>
                    <span>Ready to package</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear selected folder"
                  onClick={() => {
                    selectionGenerationRef.current += 1;
                    setSelection(null);
                    clearTransfer();
                    setError(null);
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div className="metric-grid">
                <div className="metric">
                  <span>Files</span>
                  <strong>{fileEntries.length.toLocaleString()}</strong>
                </div>
                <div className="metric">
                  <span>Source size</span>
                  <strong>{formatBytes(totalBytes)}</strong>
                </div>
                <div className="metric">
                  <span>Est. time</span>
                  <strong>{formatDuration(estimatedSeconds)}</strong>
                </div>
              </div>

              {directoryCount > 0 && (
                <p className="microcopy" style={{ marginTop: 10 }}>
                  {directoryCount.toLocaleString()} explicit folder
                  {directoryCount === 1 ? "" : "s"} included, including empty
                  folders.
                </p>
              )}

              {!selection.capturesEmptyDirectories && (
                <div className="status-box" style={{ marginTop: 12 }}>
                  <AlertTriangle size={16} />
                  <span>
                    This browser’s compatibility picker cannot expose empty
                    folders. File paths and bytes are still preserved exactly.
                  </span>
                </div>
              )}

              <details className="advanced">
                <summary>
                  <ChevronRight size={14} />
                  <Settings2 size={14} />
                  Advanced transfer settings
                </summary>
                <div className="setting-grid">
                  <div className="field">
                    <label htmlFor="chunk-size">Chunk bytes</label>
                    <input
                      id="chunk-size"
                      type="number"
                      min={200}
                      max={900}
                      step={25}
                      value={settings.chunkSize}
                      disabled={playing || preparing}
                      onChange={(event) =>
                        updateNumberSetting("chunkSize", event.target.value)
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="frame-rate">Frames / sec</label>
                    <input
                      id="frame-rate"
                      type="number"
                      min={1}
                      max={12}
                      step={1}
                      value={settings.framesPerSecond}
                      disabled={playing || preparing}
                      onChange={(event) =>
                        updateNumberSetting(
                          "framesPerSecond",
                          event.target.value,
                        )
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="error-level">QR recovery</label>
                    <select
                      id="error-level"
                      value={settings.errorCorrectionLevel}
                      disabled={playing || preparing}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          errorCorrectionLevel: event.target
                            .value as ErrorCorrectionLevel,
                        }))
                      }
                    >
                      <option value="L">Low</option>
                      <option value="M">Medium</option>
                      <option value="Q">Quartile</option>
                    </select>
                  </div>
                </div>
              </details>
            </div>
          )}

          {error && (
            <div className="status-box error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}

          <div className="sender-actions">
            <button
              className="button button-primary button-wide"
              type="button"
              disabled={!selection || preparing || playing}
              onClick={() => void buildStream()}
            >
              {preparing ? (
                <>
                  <span className="spinner" />
                  Packaging &amp; hashing…
                </>
              ) : (
                <>
                  <QrCodeIcon size={17} />
                  Build QR stream
                </>
              )}
            </button>
            <p className="microcopy">
              Keep this page open. Stop only after the receiver reports verified
              completion.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="qr-stage">
            {!prepared ? (
              <div className="qr-placeholder" aria-label="QR preview">
                <div className="qr-placeholder-inner">
                  <QrCodeIcon size={57} strokeWidth={1.4} />
                  <strong>Your QR stream will appear here</strong>
                  <span>
                    Select a folder and build the stream to begin the continuous
                    loop.
                  </span>
                </div>
              </div>
            ) : (
              <div className="qr-live">
                <div className="qr-canvas-wrap">
                  <canvas ref={canvasRef} aria-label="Current transfer QR code" />
                </div>
                <div className="qr-meta">
                  <span className="live-dot">
                    {playing ? (paused ? "Paused" : "Broadcasting") : "Stopped"}
                  </span>
                  <span>{describeFrame(activeFrame)}</span>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${
                        ((framePosition + 1) / prepared.loopFrames.length) * 100
                      }%`,
                    }}
                  />
                </div>
                <div className="metric-grid">
                  <div className="metric">
                    <span>Data chunks</span>
                    <strong>{prepared.totalChunks.toLocaleString()}</strong>
                  </div>
                  <div className="metric">
                    <span>Loop</span>
                    <strong>{loopCount + 1}</strong>
                  </div>
                  <div className="metric">
                    <span>Elapsed</span>
                    <strong>{formatClock(elapsedSeconds)}</strong>
                  </div>
                </div>
                <div className="playback-controls">
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={!playing}
                    onClick={() => setPaused((value) => !value)}
                  >
                    {paused ? <Play size={16} /> : <Pause size={16} />}
                    {paused ? "Resume" : "Pause"}
                  </button>
                  <button
                    type="button"
                    className="button button-danger"
                    disabled={!playing}
                    onClick={stopStream}
                  >
                    <CircleStop size={16} />
                    Stop
                  </button>
                </div>
                <div className="notice-strip">
                  <FileArchive size={16} />
                  <span>
                    Archive {formatBytes(prepared.archiveBytes.length)} ·
                    transfer ID {prepared.transferId.toString(16).toUpperCase()}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="notice-strip">
        <AlertTriangle size={16} />
        <span>
          Only transfer data you are authorized to move. A camera-visible QR
          stream is still a data transfer channel and may be restricted by your
          organization.
        </span>
      </div>

      <input
        ref={inputRef}
        hidden
        type="file"
        multiple
        onChange={(event) => void onInputChange(event)}
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
    </section>
  );
}

function describeFrame(frame: PreparedLoopFrame | undefined): string {
  if (!frame) return "Preparing";
  if (frame.kind === "manifest") return "Manifest";
  return `Frame ${(frame.chunkIndex ?? 0) + 1} / ${frame.totalChunks}`;
}

function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
