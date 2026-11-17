import type { View } from "./Menu";
import type { ConnSource } from "./lib";

/* WhatsApp-style conversation list — each service is a "chat" with AIVORA. */
export function Chats({ conn, onGo }: { conn: ConnSource; onGo(v: View): void }) {
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="view">
      <div className="seclabel" style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span className={`st-dot ${conn === "env" || conn === "browser" ? "ok" : conn === "none" ? "warn" : "off"}`} />
        {conn === "env" ? "AIVORA online · connected via server"
          : conn === "browser" ? "AIVORA online · browser key ✓"
          : conn === "none" ? "DEMO MODE — connect a key under ☰ → 🔐"
          : "Checking Model Studio link…"}
      </div>
      <button className="chatrow" onClick={() => onGo("call")}>
        <span className="av cr-av live">📞</span>
        <span className="mid">
          <b>AIVORA Live Call <time>{stamp}</time></b>
          <p>Lí-hó! Objectives captured in Hokkien & 廣東話 — tap to call</p>
        </span>
        <span className="unread">3</span>
      </button>
      <button className="chatrow" onClick={() => onGo("translate")}>
        <span className="av cr-av trans">🎙</span>
        <span className="mid">
          <b>Real-time Interpreter <time>{stamp}</time></b>
          <p>Speak one language, hear another — supplier calls, meetings</p>
        </span>
        <span className="unread">1</span>
      </button>
      <button className="chatrow" onClick={() => onGo("docs")}>
        <span className="av cr-av docs">📄</span>
        <span className="mid">
          <b>Document Translation <time>Mon</time></b>
          <p>📎 Supplier contract — 3 pages · photo → English</p>
        </span>
      </button>
      <button className="chatrow" onClick={() => onGo("call")}>
        <span className="av cr-av brand"><img src="/logo.png" alt="" /></span>
        <span className="mid">
          <b>AIVORA Team <time>Sun</time></b>
          <p>ODAI 6.0 live: objective-driven calls are now on</p>
        </span>
      </button>
      <div style={{ textAlign: "center", fontSize: 11, color: "var(--ink2)", padding: "18px 12px 26px" }}>
        AIVORA™ · Objective-Driven Autonomous Intelligence<br />qwen3.8-omni-flash-realtime · livetranslate · omni-flash
      </div>
    </div>
  );
}
