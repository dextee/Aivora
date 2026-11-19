import type { ConnSource } from "./lib";

export type View = "talk" | "docs";

const NAV: { id: View; icon: string; label: string; sub: string }[] = [
  { id: "talk", icon: "🎙", label: "Talk to AIVORA", sub: "Minnan-tuned ASR ears · spoken replies" },
  { id: "docs", icon: "📄", label: "Document Translation", sub: "text, photos & voice notes" },
];

export function Menu({ open, view, conn, onClose, onGo, onSettings, onAbout }: {
  open: boolean; view: View; conn: ConnSource;
  onClose(): void; onGo(v: View): void; onSettings(): void; onAbout(): void;
}) {
  return (
    <>
      <div className={`scrim${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`drawer${open ? " open" : ""}`} aria-hidden={!open}>
        <div className="drawer-head">
          <img src="/logo.png" alt="AIVORA logo" />
          <b>AIVORA ODAI™ 6.0</b>
          <small>Objective-Driven Autonomous Intelligence</small>
        </div>
        <nav>
          <div className="dsec">SERVICES</div>
          {NAV.map((n) => (
            <button key={n.id} className={`ditem${view === n.id ? " sel" : ""}`} onClick={() => onGo(n.id)}>
              <span className="dic">{n.icon}</span>
              <span style={{ flex: 1 }}>{n.label}<small>{n.sub}</small></span>
            </button>
          ))}
          <div className="dsec">SETTINGS</div>
          <button className="ditem" onClick={onSettings}>
            <span className="dic">🔐</span>
            <span style={{ flex: 1 }}>API connection<small>
              {conn === "env" ? "Stored on the Page server (recommended)"
                : conn === "browser" ? "Browser key connected ✓" : "No key yet — add one"}
            </small></span>
          </button>
          <button className="ditem" onClick={onAbout}>
            <span className="dic">ℹ️</span>
            <span style={{ flex: 1 }}>About AIVORA<small>ODAI 6.0 · Model Studio realtime</small></span>
          </button>
        </nav>
        <div className="drawer-foot">Powered by qwen-audio-3.1-realtime-flash · livetranslate · omni-flash</div>
      </aside>
    </>
  );
}
