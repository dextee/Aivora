import type { ConnSource } from "./lib";
import { useEffect, useState } from "react";
import { getAccessToken } from "./auth";

export type View = "appointment" | "talk" | "myshop" | "commercial" | "leads" | "docs" | "inbox" | "contacts" | "purchases" | "orders" | "intelligence" | "action" | "testlab" | "bizlab" | "storyboard";

const NAV: { id: View; icon: string; label: string; sub: string; section?: string; children?: { id: View; label: string; sub: string }[] }[] = [
  { id: "talk", icon: "🎙", label: "Talk to AIVORA", sub: "voice partner — interprets & routes itself" },
  { id: "appointment", icon: "AI", label: "Appointment", sub: "local organizer · Calendly booking" },
  { id: "inbox", icon: "AI", label: "Inbox", sub: "stored messages · approvals · security" },
  { id: "myshop", icon: "🛍", label: "My Shop", sub: "dropshipping catalog · live setup" },
  { id: "commercial", icon: "🎞", label: "Commercial Studio", sub: "your photo + product → 15s ad (provider render)" },
  { id: "contacts", icon: "AI", label: "Customer", sub: "contacts · purchase records · orders · intelligence", children: [
    { id: "orders", label: "Purchase Orders", sub: "sandbox procurement review" },
    { id: "purchases", label: "Purchase History", sub: "original records and validation" },
  ] },
  { id: "intelligence", icon: "AI", label: "Business Intelligence", sub: "validated 30-day comparisons", children: [
    { id: "action", label: "Business Action", sub: "decision plan · who to contact" },
  ] },
  { id: "docs", icon: "📄", label: "Document Translation", sub: "text, photos & voice notes" },
  { id: "testlab", icon: "🧪", label: "Inbox Test Lab", sub: "MGMT · 20-case acceptance testing", section: "TESTING" },
];

export function Menu({ open, view, conn, onClose, onGo, onSettings, onAbout }: {
  open: boolean; view: View; conn: ConnSource;
  onClose(): void; onGo(v: View): void; onSettings(): void; onAbout(): void;
}) {
  const [unread, setUnread] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const token = getAccessToken();
    void fetch(`/api/odai/inbox?_t=${Date.now()}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(async (r) => r.ok ? r.json() : null).then((j) => { if (active) setUnread(typeof j?.counts?.unread === "number" ? j.counts.unread : null); }).catch(() => { if (active) setUnread(null); });
    return () => { active = false; };
  }, [open]);
  return (
    <>
      <div className={`scrim${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`drawer${open ? " open" : ""}`} aria-hidden={!open}>
        <div className="drawer-head">
          <img src="/logo.png" alt="AIVORA logo" />
          <b>AIVORA ODAI V0.9BETA</b>
          <small>Objective-Driven Autonomous Intelligence</small>
        </div>
        <nav>
          <div className="dsec">SERVICES</div>
          {NAV.map((n) => (
            <div key={n.id}>
              {n.section && <div className="dsec">{n.section}</div>}
              <button className={`ditem${view === n.id ? " sel" : ""}`} onClick={() => onGo(n.id)}>
                <span className="dic">{n.icon}</span>
                <span style={{ flex: 1 }}>{n.label}{n.id === "inbox" && unread !== null ? ` (${unread})` : ""}<small>{n.sub}</small></span>
              </button>
              {n.children?.map((ch) => (
                <button key={ch.id} className={`ditem sub${view === ch.id ? " sel" : ""}`} onClick={() => onGo(ch.id)} style={{ paddingLeft: 38 }}>
                  <span className="dic">↳</span>
                  <span style={{ flex: 1 }}>{ch.label}<small>{ch.sub}</small></span>
                </button>
              ))}
            </div>
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
            <span style={{ flex: 1 }}>About AIVORA<small>V0.9BETA · Model Studio realtime</small></span>
          </button>
        </nav>
        <div className="drawer-foot">Powered by qwen-audio-3.1-realtime-flash · livetranslate · omni-flash</div>
      </aside>
    </>
  );
}
