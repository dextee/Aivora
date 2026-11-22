import { useEffect, useState } from "react";
import { Menu, type View } from "./Menu";
import { SettingsSheet } from "./SettingsSheet";
import { TalkView, type AppointmentDraft } from "./TalkView";
import { DocsView } from "./DocsView";
import { AppointmentView } from "./AppointmentView";
import { LeadsView } from "./LeadsView";
import { MyShopView } from "./MyShopView";
import { InboxView } from "./InboxView";
import { BusinessView, type BusinessPage } from "./BusinessView";
import { TestLabView } from "./TestLabView";
import { BusinessTestLabView } from "./BusinessTestLabView";
import { StoryboardView } from "./StoryboardView";
import { ManagementView } from "./ManagementView";
import { SecurityView } from "./SecurityView";
import { probeKey, type ConnSource } from "./lib";
import { initAuth, isSupabaseConfigured, getAccessToken, onAuth, signOut } from "./auth";
import { Login } from "./Login";

const TITLES: Record<View, { t: string; s: string }> = {
  appointment: { t: "AIVORA Appointment", s: "local organizer · Calendly" },
  contacts: { t: "Customer Contacts", s: "AIVORA ODAI V0.9BETA" },
  purchases: { t: "Purchase History", s: "AIVORA ODAI V0.9BETA" },
  orders: { t: "Purchase Orders", s: "AIVORA ODAI V0.9BETA" },
  intelligence: { t: "Business Intelligence", s: "AIVORA ODAI V0.9BETA" },
  talk: { t: "AIVORA ODAI V0.9BETA", s: "Objective-Driven Autonomous Intelligence" },
  docs: { t: "Document Translation", s: "text · photo · voice note" },
  myshop: { t: "My Shop", s: "dropshipping catalog · live setup" },
  leads: { t: "Leads", s: "enquiries · follow-up drafts" },
  inbox: { t: "My Inbox", s: "AIVORA ODAI V0.9BETA" },
  testlab: { t: "Inbox Test Lab", s: "MGMT · acceptance testing" },
  bizlab: { t: "Business Test Lab", s: "MGMT · 45-case integration verification" },
  storyboard: { t: "Storyboard", s: "judge demo · 14 scenes in order" },
};

export function App() {
  const [view, setView] = useState<View>("talk");
  const [mode, setMode] = useState<"user" | "management" | "security">("user");
  const [modeErr, setModeErr] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [about, setAbout] = useState(false);
  const [conn, setConn] = useState<ConnSource>("checking");
  const [supaOn, setSupaOn] = useState(false);
  const [authed, setAuthed] = useState(true); // when Supabase is unconfigured the offline demo is treated as signed-in
  const [appointmentDraft, setAppointmentDraft] = useState<AppointmentDraft | null>(null);
  const [talkNonce, setTalkNonce] = useState(0);
  const [talkAutoStart, setTalkAutoStart] = useState(false);

  useEffect(() => {
    let un: () => void = () => {};
    void initAuth().then((c) => {
      const on = !!(c.configured);
      setSupaOn(on);
      setAuthed(!on || !!getAccessToken());
      un = onAuth((s) => setAuthed(!!s));
    });
    return () => un();
  }, []);

  const refreshConn = () => { void probeKey().then(setConn); };
  async function switchMode(m: "user" | "management" | "security") {
    if (m === mode) { setTalkAutoStart(false); setView("talk"); return; }
    try {
      const tok = getAccessToken();
      const r = await fetch(`/api/odai/view?mode=${m}&_t=${Date.now()}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setModeErr(j.error || "mode denied by server"); return; }
      setModeErr(null); setMode(m); if (m === "user") { setTalkAutoStart(false); setView("talk"); }
    } catch { setModeErr("cannot reach authorization endpoint"); }
  }
  const goFeature = (v: View) => { setMode("user"); setTalkAutoStart(false); setView(v); };
  useEffect(() => { void probeKey().then(setConn); }, []);
  useEffect(() => { setMenu(false); }, [view]);

  const connLine = conn === "env" ? "connected via server"
    : conn === "browser" ? "browser key ✓"
    : conn === "none" ? "add a key to go live" : "connecting…";

  // Supabase configured but no session → show the sign-in gate (offline demo skips this).
  if (supaOn && !authed) return <Login />;

  return (
    <div className={`app${mode === "user" && view === "talk" ? " usermode" : ""}${mode === "management" ? " darkchrome" : ""}${mode === "security" ? " darkchrome-s" : ""}`}>
      <header className="topbar">
        <button className="tb-btn burger" onClick={() => setMenu((m) => !m)} aria-label="Menu">
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" /></svg>
          <i className={conn === "env" || conn === "browser" ? "on" : "off"} />
        </button>
        {view === "talk"
          ? <img className="logo" src="/logo.png" alt="AIVORA" />
          : <button className="tb-btn" onClick={() => { setTalkAutoStart(false); setView("talk"); }} aria-label="Back"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
        <span className="who">
          <b>{mode === "user" ? TITLES[view].t : mode === "management" ? "AI Brain · Orchestration" : "AIVORA SHIELD"}</b>
          <small><span className={`st-dot ${conn === "env" || conn === "browser" ? "ok" : conn === "checking" ? "warn" : "off"}`} />{mode === "user" ? `${TITLES[view].s} · ${connLine}` : modeErr ? modeErr : `${mode} mode · server-authorized`}</small>
        </span>
        <nav className="modeseg" aria-label="Mode">
          <button className={mode === "user" ? "on" : ""} onClick={() => switchMode("user")}>USER</button>
          <button className={mode === "security" ? "on s" : ""} onClick={() => switchMode("security")}>SHIELD</button>
        </nav>
        {supaOn && <button className="tb-btn signout" onClick={() => void signOut()} aria-label="Sign out">Sign out</button>}
      </header>

      {mode === "user" && <>
      {view === "talk" && <TalkView key={`talk-${talkNonce}`} autoStart={talkAutoStart} onOpenBusiness={() => setView("intelligence")} onOpenInbox={() => setView("inbox")} onOpenDocs={() => setView("docs")} onOpenStore={() => setView("myshop")} onOpenAppointment={(draft) => { setAppointmentDraft(draft); setTalkAutoStart(false); setView("appointment"); }} />}
      {(["contacts", "purchases", "orders", "intelligence"] as string[]).includes(view) && <BusinessView key={view} page={view as BusinessPage} onTalk={() => setView("talk")} />}
      {view === "docs" && <DocsView />}
      {view === "appointment" && <AppointmentView key={`appt-${appointmentDraft ? "draft" : "plain"}`} draft={appointmentDraft} onTalk={() => { setTalkAutoStart(false); setView("talk"); }} onSpeak={() => { setAppointmentDraft(null); setTalkAutoStart(true); setTalkNonce((n) => n + 1); setView("talk"); }} />}
      {view === "leads" && <LeadsView />}
      {view === "myshop" && <MyShopView />}
      {view === "inbox" && <InboxView onSpeak={() => { setTalkAutoStart(true); setTalkNonce((n) => n + 1); setView("talk"); }} onOpen={(target) => { if (target === "security" || target === "management") void switchMode(target); else if (target === "myshop" || target === "talk") goFeature(target); }} />}
        {view === "testlab" && <TestLabView />}
        {view === "bizlab" && <BusinessTestLabView />}
        {view === "storyboard" && <StoryboardView />}
      </>}
      {mode === "management" && <ManagementView />}
      {mode === "security" && <SecurityView />}

      <Menu open={menu} view={view} conn={conn}
        onClose={() => setMenu(false)}
        onGo={goFeature}
        onSettings={() => { setMenu(false); setSettings(true); }}
        onAbout={() => { setMenu(false); setAbout(true); }} />

      {settings && <SettingsSheet conn={conn} onClose={() => setSettings(false)} onChanged={refreshConn} />}

      {about && (
        <div className="modal-wrap" onClick={() => setAbout(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>ℹ️ About AIVORA</h3><button className="icon-btn" onClick={() => setAbout(false)}>✕</button></div>
            <div style={{ textAlign: "center", padding: "6px 0 10px" }}>
              <img src="/logo.png" alt="" style={{ width: 84, height: 84, borderRadius: 24 }} />
              <h4 style={{ font: "800 16px var(--display)", marginTop: 8 }}>AIVORA ODAI V0.9BETA</h4>
              <p style={{ fontSize: 11, color: "var(--ink2)" }}>Objective-Driven Autonomous Intelligence</p>
            </div>
            <p style={{ fontSize: 12.5, color: "var(--ink2)", lineHeight: 1.65 }}>
              One button, three Model Studio engines that AIVORA switches between by itself:
              <b> qwen-audio-3.1-realtime-flash</b> (hears your voice and answers out loud), <b> qwen3.8-livetranslate-flash-realtime</b> (live interpreter, on
              request) and <b> qwen3.8-omni-flash</b> (documents & photos). Voice is WebRTC; your key
              only lives on the Page server.
            </p>
            <button className="gobtn" style={{ marginTop: 12 }} onClick={() => setAbout(false)}>Back</button>
          </div>
        </div>
      )}
    </div>
  );
}
