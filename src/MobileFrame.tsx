import { useEffect, useState } from "react";

/* Owner instruction 2026-11-23: the Hashmeta storefront and the campaign landing page are shown
 * INSIDE AIVORA at the app's mobile size (528 px column), not as a full-desktop page, with a
 * back button that returns to AIVORA. The remote site sends no X-Frame-Options and no CSP
 * frame-ancestors (verified 2026-11-23), so embedding is permitted; "Open externally" stays as
 * the honest fallback if a browser or network blocks the frame. */
export function MobileFrame({ url, title, onClose, note }: { url: string; title: string; onClose(): void; note?: string }) {
  const [state, setState] = useState<"loading" | "loaded">("loading");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <section role="dialog" aria-modal="true" aria-label={title}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(16,24,40,.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: 12 }}>
      <div style={{ width: "min(528px, 100%)", height: "min(88vh, 900px)", background: "#fff", borderRadius: 18, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,.28)" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "var(--green, #0e6b57)", color: "#fff" }}>
          <button autoFocus onClick={onClose} aria-label="Back to AIVORA"
            style={{ padding: "8px 12px", borderRadius: 8, border: 0, background: "rgba(255,255,255,.18)", color: "#fff", fontWeight: 800, fontSize: 12, cursor: "pointer" }}>← Back to AIVORA</button>
          <strong style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</strong>
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "#fff", fontSize: 11, whiteSpace: "nowrap" }}>Open externally</a>
        </header>
        <div style={{ padding: "6px 12px", fontSize: 11, color: "#8a93a3", borderBottom: "1px solid #eef0f4", display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontWeight: 700 }}>mobile view · 528 px</span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{url}</span>
          {state === "loading" && <span>loading…</span>}
        </div>
        {note && <p style={{ margin: 0, padding: "6px 12px", fontSize: 11, color: "#b54708", background: "#fffbf5" }}>{note}</p>}
        <iframe title={title} src={url} onLoad={() => setState("loaded")} referrerPolicy="strict-origin-when-cross-origin"
          style={{ flex: 1, width: "100%", border: 0, background: "#fff" }} />
      </div>
    </section>
  );
}
