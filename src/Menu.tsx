import { useEffect, useState } from "react";
import { getAccessToken } from "./auth";
import type { ConnSource } from "./lib";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceIcon, type WorkspaceIconName } from "./WorkspaceIcon";

export type View = "appointment" | "talk" | "myshop" | "commercial" | "leads" | "docs" | "inbox" | "contacts" | "purchases" | "orders" | "intelligence" | "action" | "testlab" | "bizlab" | "storyboard";

type Destination = { id: View; icon: WorkspaceIconName; label: string; description: string };

const groups: { title: string; items: Destination[] }[] = [
  { title: "Workspace", items: [
    { id: "talk", icon: "mic", label: "Assistant", description: "Voice and typed requests" },
    { id: "inbox", icon: "inbox", label: "Inbox", description: "Messages and approvals" },
    { id: "appointment", icon: "calendar", label: "Appointments", description: "Schedule and manage meetings" },
  ] },
  { title: "Business", items: [
    { id: "contacts", icon: "customers", label: "Customer Contacts", description: "Find customer records" },
    { id: "purchases", icon: "doc", label: "Purchase History", description: "Review customer purchases" },
    { id: "orders", icon: "box", label: "Procurement", description: "Review purchase orders" },
    { id: "intelligence", icon: "chart", label: "Business Intelligence", description: "Compare activity and results" },
    { id: "action", icon: "chart", label: "Business Action", description: "Plan decisions and follow-ups" },
  ] },
  { title: "Tools", items: [
    { id: "myshop", icon: "shop", label: "My Shop", description: "Set up a dropshipping catalog" },
    { id: "commercial", icon: "studio", label: "Commercial Studio", description: "Create a video ad" },
    { id: "docs", icon: "doc", label: "Document Translation", description: "Translate text, images, or audio" },
    { id: "testlab", icon: "inbox", label: "Inbox Test Lab", description: "Verify inbox workflows" },
  ] },
];

export function Menu({ open, view, conn, onClose, onGo, onSettings, onAbout }: {
  open: boolean; view: View | null; conn: ConnSource;
  onClose(): void; onGo(view: View): void; onSettings(): void; onAbout(): void;
}) {
  const [unread, setUnread] = useState<number | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) { setQuery(""); return; }
    const request = new AbortController();
    const token = getAccessToken();
    void fetch(`/api/odai/inbox?_t=${Date.now()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: request.signal,
    }).then(async (response) => response.ok ? response.json() : null).then((data) => {
      if (!request.signal.aborted) setUnread(typeof data?.counts?.unread === "number" ? data.counts.unread : null);
    }).catch(() => { if (!request.signal.aborted) setUnread(null); });
    return () => request.abort();
  }, [open]);

  const term = query.trim().toLowerCase();
  const visible = groups.map(({ title, items }) => ({
    title,
    items: items.filter(({ label, description }) => `${label} ${description}`.toLowerCase().includes(term)),
  })).filter(({ items }) => items.length);
  const connection = conn === "env" ? "Connected through server"
    : conn === "browser" ? "Connected through browser"
    : conn === "checking" ? "Checking connection" : "Setup required";

  return (
    <WorkspaceDialog id="workspace-menu" label="workspace-menu-title" className="workspace-drawer"
      open={open} onClose={onClose}>
      <div className="workspace-drawer-head">
        <img src="/logo.png" alt="" width="36" height="36" />
        <h2 id="workspace-menu-title">AIVORA menu</h2>
        <button type="button" className="workspace-icon-button" onClick={onClose} aria-label="Close menu">
          <WorkspaceIcon name="close" />
        </button>
      </div>
      <label className="workspace-search">
        <WorkspaceIcon name="search" size={17} />
        <input type="search" placeholder="Find a tool…" aria-label="Find a tool"
          value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <nav className="workspace-drawer-nav" aria-label="Tools">
        {visible.map(({ title, items }) => (
          <section key={title}>
            <h3>{title}</h3>
            {items.map(({ id, label, description, icon }) => (
              <button key={id} type="button" className="workspace-nav-item"
                aria-current={view === id ? "page" : undefined} onClick={() => onGo(id)}>
                <span className="workspace-nav-icon"><WorkspaceIcon name={icon} size={18} /></span>
                <span className="workspace-nav-copy"><strong>{label}</strong><small>{description}</small></span>
                {id === "inbox" && unread !== null && unread > 0
                  ? <span className="workspace-unread" aria-label={`${unread} unread`}>{unread > 99 ? "99+" : unread}</span>
                  : <WorkspaceIcon name="arrow" size={16} />}
              </button>
            ))}
          </section>
        ))}
        {visible.length === 0 && <p className="workspace-no-results" role="status">No matching tools.</p>}
      </nav>
      <footer className="workspace-drawer-footer">
        <button className="workspace-nav-item" type="button" onClick={onSettings}>
          <span className="workspace-nav-icon"><WorkspaceIcon name="key" size={18} /></span>
          <span className="workspace-nav-copy"><strong>API connection</strong><small>{connection}</small></span>
          <WorkspaceIcon name="arrow" size={16} />
        </button>
        <button className="workspace-nav-item" type="button" onClick={onAbout}>
          <span className="workspace-nav-icon"><WorkspaceIcon name="info" size={18} /></span>
          <span className="workspace-nav-copy"><strong>About AIVORA</strong></span>
          <WorkspaceIcon name="arrow" size={16} />
        </button>
      </footer>
    </WorkspaceDialog>
  );
}
