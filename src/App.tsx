import { useEffect, useState } from "react";
import { Chats } from "./Chats";
import { Menu, type View } from "./Menu";
import { SettingsSheet } from "./SettingsSheet";
import { CallView } from "./CallView";
import { TranslateView } from "./TranslateView";
import { DocsView } from "./DocsView";
import { probeKey, loadConfig, type ConnSource } from "./lib";

const TITLES: Record<View, { t: string; s: (c: ConnSource) => string }> = {
  chats: { t: "AIVORA", s: () => "Objective-Driven Autonomous Intelligence" },
  call: { t: "AIVORA Live Call", s: () => "voice partner · realtime" },
  translate: { t: "Real-time Interpreter", s: () => "speech-to-speech translation" },
  docs: { t: "Document Translation", s: () => "text · photo · voice note" },
};

export function App() {
  const [view, setView] = useState<View>("chats");
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [about, setAbout] = useState(false);
  const [conn, setConn] = useState<ConnSource>("checking");

  const refreshConn = () => { void probeKey().then(setConn); };

  useEffect(() => { void probeKey().then(setConn); }, []);
  useEffect(() => { setMenu(false); }, [view]);

  const live = conn === "env" || (conn === "browser" && !!loadConfig());
  const connLine = conn === "env" ? "connected via server"
    : conn === "browser" ? "connected with browser key ✓"
    : conn === "none" ? "demo mode — no key" : "checking…";

  return (
    <div className="app">
      <header className="topbar">
        <button className="tb-btn burger" onClick={() => setMenu((m) => !m)} aria-label="Menu">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" /></svg>
          <i className={live ? "on" : "off"} />
        </button>
        {view === "chats"
          ? <img className="logo" src="/logo.png" alt="AIVORA" />
          : <button className="tb-btn" onClick={() => setView("chats")} aria-label="Back"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
        <span className="who">
          <b>{TITLES[view].t}</b>
          <small><span className={`st-dot ${live ? "ok" : conn === "checking" ? "warn" : "off"}`} />{TITLES[view].s(conn)} · {connLine}</small>
        </span>
        <button className="tb-btn" onClick={() => setSettings(true)} aria-label="API connection" title="API connection">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none"><circle cx="8" cy="12" r="4" stroke="currentColor" strokeWidth="1.9" /><path d="M11.5 12H21M17 12v3.5M20 12v2.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" /></svg>
        </button>
      </header>

      {view === "chats" && <Chats conn={conn} onGo={setView} />}
      {view === "call" && <CallView live={live} />}
      {view === "translate" && <TranslateView live={live} />}
      {view === "docs" && <DocsView live={live} />}

      <Menu open={menu} view={view} conn={conn}
        onClose={() => setMenu(false)}
        onGo={setView}
        onSettings={() => { setMenu(false); setSettings(true); }}
        onAbout={() => { setMenu(false); setAbout(true); }} />

      {settings && <SettingsSheet conn={conn} onClose={() => setSettings(false)} onChanged={() => refreshConn()} />}

      {about && (
        <div className="modal-wrap" onClick={() => setAbout(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>ℹ️ About AIVORA</h3><button className="icon-btn" onClick={() => setAbout(false)}>✕</button></div>
            <div style={{ textAlign: "center", padding: "6px 0 10px" }}>
              <img src="/logo.png" alt="" style={{ width: 84, height: 84, borderRadius: 24 }} />
              <h4 style={{ font: "800 16px var(--display)", marginTop: 8 }}>AIVORA™ · ODAI 6.0</h4>
              <p style={{ fontSize: 11, color: "var(--ink2)" }}>Objective-Driven Autonomous Intelligence</p>
            </div>
            <p style={{ fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.65 }}>
              Voice-first business partner powered by Alibaba Cloud Model Studio:
              <b> qwen3.8-omni-flash-realtime</b> (dialect voice calls with objective capture),
              <b> qwen3.8-livetranslate-flash-realtime</b> (live interpreter) and
              <b> qwen3.8-omni-flash</b> (documents, photos, voice notes).
              Your Model Studio key is held only on the Page server.
            </p>
            <button className="gobtn" style={{ marginTop: 12 }} onClick={() => setAbout(false)}>Back to chats</button>
          </div>
        </div>
      )}
    </div>
  );
}
