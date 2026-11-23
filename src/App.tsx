import { useEffect, useRef, useState } from "react";
import { AppointmentView } from "./AppointmentView";
import { getAccessToken, initAuth, onAuth, signOut } from "./auth";
import { BusinessActionView } from "./BusinessActionView";
import { BusinessTestLabView } from "./BusinessTestLabView";
import { BusinessView } from "./BusinessView";
import { CommercialView } from "./CommercialView";
import { DocsView } from "./DocsView";
import { InboxView } from "./InboxView";
import { LeadsView } from "./LeadsView";
import { probeKey, type ConnSource } from "./lib";
import { Login } from "./Login";
import { ManagementView } from "./ManagementView";
import { Menu, type View } from "./Menu";
import { MyShopView } from "./MyShopView";
import { SecurityView } from "./SecurityView";
import { SettingsSheet } from "./SettingsSheet";
import { StoryboardView } from "./StoryboardView";
import { TalkView, type AppointmentDraft } from "./TalkView";
import { TestLabView } from "./TestLabView";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceIcon } from "./WorkspaceIcon";

const titles: Record<View, string> = {
  appointment: "Appointments",
  contacts: "Customer Contacts",
  purchases: "Purchase History",
  orders: "Procurement",
  intelligence: "Business Intelligence",
  action: "Business Action",
  talk: "AIVORA",
  docs: "Document Translation",
  myshop: "My Shop",
  commercial: "Commercial Studio",
  leads: "Leads",
  inbox: "Inbox",
  testlab: "Inbox Test Lab",
  bizlab: "Business Test Lab",
  storyboard: "Storyboard",
};

const connectionLabels: Record<ConnSource, string> = {
  env: "Server connected",
  browser: "Browser connected",
  none: "Connection setup",
  checking: "Checking connection",
};

type Mode = "user" | "management" | "security";

export function App() {
  const [view, setView] = useState<View>("talk");
  const [mode, setMode] = useState<Mode>("user");
  const [modeError, setModeError] = useState<string | null>(null);
  const [checkingMode, setCheckingMode] = useState(false);
  const [overlay, setOverlay] = useState<"menu" | "settings" | "about" | null>(null);
  const overlayOpener = useRef<HTMLButtonElement | null>(null);
  const [conn, setConn] = useState<ConnSource>("checking");
  const [supaOn, setSupaOn] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [authCheck, setAuthCheck] = useState<"loading" | "ready" | "error">("loading");
  const [authRetry, setAuthRetry] = useState(0);
  const [appointmentDraft, setAppointmentDraft] = useState<AppointmentDraft | null>(null);
  const [talkNonce, setTalkNonce] = useState(0);
  const [talkAutoStart, setTalkAutoStart] = useState(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void initAuth().then(({ configured }) => {
      if (!active) return;
      setSupaOn(configured);
      setAuthed(!!getAccessToken());
      setAuthCheck("ready");
      unsubscribe = onAuth((session) => setAuthed(!!session));
    }).catch(() => { if (active) setAuthCheck("error"); });
    return () => { active = false; unsubscribe?.(); };
  }, [authRetry]);

  useEffect(() => { void probeKey().then(setConn); }, []);

  async function switchMode(next: Mode) {
    if (checkingMode) return;
    setModeError(null);
    if (next === mode) {
      if (next === "user") goTo("talk");
      return;
    }
    setCheckingMode(true);
    try {
      const token = getAccessToken();
      const response = await fetch(`/api/odai/view?mode=${next}&_t=${Date.now()}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        setModeError(response.status === 401 || response.status === 403
          ? "Your account does not have access to this view."
          : "This view is unavailable right now. Try again.");
        return;
      }
      if (next === "user") goTo("talk");
      else setMode(next);
    } catch {
      setModeError("Could not check access. Try again.");
    } finally {
      setCheckingMode(false);
    }
  }

  function closeOverlay() {
    setOverlay(null);
    requestAnimationFrame(() => overlayOpener.current?.focus());
  }

  function goTo(next: View) {
    if (overlay) closeOverlay();
    setModeError(null);
    setMode("user");
    setTalkAutoStart(false);
    setView(next);
  }

  function startTalking() {
    setTalkAutoStart(true);
    setTalkNonce((previous) => previous + 1);
    setView("talk");
  }

  const assistant = mode === "user" && view === "talk";
  const title = mode === "user" ? titles[view] : mode === "management" ? "Orchestration" : "AIVORA Shield";

  if (authCheck !== "ready") return (
    <main className="login-wrap">
      <div className="login-card workspace-loading">
        <img src="/logo.png" alt="AIVORA" width="52" height="52" />
        {authCheck === "loading" ? <p role="status">Opening AIVORA…</p> : <>
          <p role="alert">Could not check your sign-in status.</p>
          <button className="gobtn" onClick={() => { setAuthCheck("loading"); setAuthRetry((n) => n + 1); }}>Try again</button>
        </>}
      </div>
    </main>
  );
  if (supaOn && !authed) return <Login />;

  return (
    <div className={`app aivora-workspace${assistant ? " usermode" : ""}${mode === "management" ? " darkchrome" : ""}${mode === "security" ? " darkchrome-s" : ""}`}>
      <a className="workspace-skip" href="#workspace-content">Skip to content</a>
      <header className="workspace-topbar">
        <button type="button" className="workspace-icon-button" onClick={(event) => {
          overlayOpener.current = event.currentTarget;
          setOverlay("menu");
        }} aria-label="Open menu" aria-haspopup="dialog" aria-controls="workspace-menu"
          aria-expanded={overlay === "menu"} disabled={checkingMode}>
          <WorkspaceIcon name="menu" />
        </button>
        <div className="workspace-name">
          <strong>{title}</strong>
          {mode === "user" && (
            <button type="button" className="workspace-connection" aria-haspopup="dialog" onClick={(event) => {
              overlayOpener.current = event.currentTarget;
              setOverlay("settings");
            }}>
              <span className="workspace-connection-dot" data-connection={conn} />
              {connectionLabels[conn]}
            </button>
          )}
        </div>
        <nav className="workspace-modes" aria-label="Workspace mode">
          <button type="button" aria-pressed={mode === "user"} disabled={checkingMode}
            onClick={() => void switchMode("user")}>Assistant</button>
          <button type="button" aria-pressed={mode === "security"} disabled={checkingMode} onClick={() => void switchMode("security")}>
            <WorkspaceIcon name="shield" size={15} />Shield
          </button>
        </nav>
        {supaOn && <button type="button" className="workspace-icon-button" onClick={() => void signOut()} aria-label="Sign out">
          <WorkspaceIcon name="logout" />
        </button>}
      </header>
      {checkingMode && <p className="workspace-notice" role="status">Checking access…</p>}
      {modeError && <p className="workspace-notice workspace-notice-error" role="alert">{modeError}</p>}

      <main className="workspace-main" id="workspace-content" tabIndex={-1} aria-label={title}>
        {mode === "user" && <>
          {view === "talk" && (
            <TalkView key={talkNonce} autoStart={talkAutoStart} onOpenBusiness={() => goTo("intelligence")}
              onOpenInbox={() => goTo("inbox")} onOpenDocs={() => goTo("docs")} onOpenStore={() => goTo("myshop")}
              onOpenCommercial={() => goTo("commercial")} onOpenAppointment={(draft) => {
                setAppointmentDraft(draft);
                goTo("appointment");
              }} />
          )}
          {(view === "contacts" || view === "purchases" || view === "orders" || view === "intelligence") &&
            <BusinessView key={view} page={view} onTalk={() => goTo("talk")} />}
          {view === "docs" && <DocsView />}
          {view === "appointment" && (
            <AppointmentView key={appointmentDraft ? "draft" : "plain"} draft={appointmentDraft}
              onTalk={() => goTo("talk")} onSpeak={() => { setAppointmentDraft(null); startTalking(); }} />
          )}
          {view === "leads" && <LeadsView />}
          {view === "myshop" && <MyShopView />}
          {view === "commercial" && <CommercialView />}
          {view === "inbox" && <InboxView onSpeak={startTalking} onOpen={(target) => {
            if (target === "security" || target === "management") void switchMode(target);
            else if (target === "myshop" || target === "talk") goTo(target);
          }} />}
          {view === "testlab" && <TestLabView />}
          {view === "bizlab" && <BusinessTestLabView />}
          {view === "storyboard" && <StoryboardView />}
          {view === "action" && <BusinessActionView />}
        </>}
        {mode === "management" && <ManagementView />}
        {mode === "security" && <SecurityView />}
      </main>

      <Menu open={overlay === "menu"} view={mode === "user" ? view : null} conn={conn}
        onClose={closeOverlay} onGo={goTo} onSettings={() => setOverlay("settings")} onAbout={() => setOverlay("about")} />
      {overlay === "settings" && <SettingsSheet conn={conn} onClose={closeOverlay} onChanged={() => { void probeKey().then(setConn); }} />}
      <WorkspaceDialog open={overlay === "about"} label="workspace-about-title" className="workspace-dialog" onClose={closeOverlay}>
        <div className="workspace-dialog-head">
          <h2 id="workspace-about-title">About AIVORA</h2>
          <button className="workspace-icon-button" type="button" onClick={closeOverlay} aria-label="Close about">
            <WorkspaceIcon name="close" />
          </button>
        </div>
        <p>AIVORA is your voice-first business assistant. Use a live conversation to give instructions or interpret speech, and Document Translation for text, images, and audio.</p>
        <p>Version 0.9 beta · Objective-Driven Autonomous Intelligence</p>
      </WorkspaceDialog>
    </div>
  );
}
