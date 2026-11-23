import { useState } from "react";
import { DEFAULT_WS, REGIONS, type AiConfig, type ConnSource, clearConfig, loadConfig, saveConfig, testKey } from "./lib";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceIcon } from "./WorkspaceIcon";

const KEY_RE = /^(sk|sess|wss|dk|ak)-[A-Za-z0-9._-]{16,}$/;

export function SettingsSheet({ conn, onClose, onChanged }: {
  conn: ConnSource; onClose(): void; onChanged(): void;
}) {
  const saved = loadConfig();
  const [key, setKey] = useState(saved?.key ?? "");
  const [ws, setWs] = useState(saved?.ws ?? DEFAULT_WS);
  const [region, setRegion] = useState(saved?.region ?? REGIONS[0][0]);
  const [show, setShow] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const cfg = (): AiConfig => ({ key: key.trim(), ws: ws.trim(), region });
  const looksValid = KEY_RE.test(key.trim());

  async function test() {
    setBusy(true); setStatus(null);
    setStatus(await testKey(cfg()));
    setBusy(false);
  }
  function save() {
    const c = cfg();
    if (!c.key || !c.ws) { setStatus({ ok: false, detail: "Key and workspace ID are required." }); return; }
    saveConfig(c);
    setStatus({ ok: true, detail: "Saved in this browser only (localStorage). The relay uses it per session and never logs it." });
    onChanged();
    onBlur();
  }
  function forget() {
    clearConfig(); setKey("");
    setHint(null);
    setStatus({ ok: true, detail: "Removed from this browser." });
    onChanged();
  }
  // format sanity guard for the browser-paste path
  function onBlur() {
    if (!key.trim()) { setHint(null); return; }
    if (!looksValid) setHint("This doesn't look like a Model Studio key (expected sk-…). Double-check it.");
    else if (/\s/.test(key)) setHint("Remove spaces / newlines from the pasted key.");
    else setHint(null);
  }

  const serverMode = conn === "env";

  return (
    <WorkspaceDialog open onClose={onClose} label="workspace-settings-title" className="workspace-dialog workspace-settings">
        <div className="workspace-dialog-head">
          <h2 id="workspace-settings-title">API connection</h2>
          <button type="button" className="workspace-icon-button" onClick={onClose} aria-label="Close API connection">
            <WorkspaceIcon name="close" />
          </button>
        </div>

        {serverMode ? (
          <p className="mstat ok">
            Connected through the server. AIVORA uses the server key for voice and translation.
          </p>
        ) : (
          <>
            {hint && <p className="mstat bad" style={{ marginBottom: 8 }}>⚠ {hint}</p>}
            <label className="fld"><span>Region</span>
              <select value={region} onChange={(e) => setRegion(e.target.value)}>
                {REGIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
              </select>
            </label>
            <label className="fld"><span>Workspace ID</span>
              <input value={ws} onChange={(e) => setWs(e.target.value)} placeholder="ws-…" spellCheck={false} autoComplete="off" />
            </label>
            <div className="fld">
              <label htmlFor="workspace-model-key">Model Studio API key</label>
              <div className="keyrow">
                <input id="workspace-model-key" type={show ? "text" : "password"} value={key}
                  onChange={(e) => setKey(e.target.value)} onBlur={onBlur}
                  placeholder="sk-…" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  aria-describedby="workspace-key-storage" />
                <button type="button" className="workspace-key-toggle" onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Show"}</button>
              </div>
            </div>
            <p className="dnote" id="workspace-key-storage">
              A key saved here is stored in this browser. A configured server key takes precedence.
            </p>
          </>
        )}

        {status && <p role={status.ok ? "status" : "alert"} className={`mstat ${status.ok ? "ok" : "bad"}`}>{status.detail}</p>}

        <div className="modal-actions">
          {saved?.key && <button className="mab" type="button" onClick={forget}>Forget browser key</button>}
          {!serverMode && <button className="mab" type="button" onClick={test} disabled={busy || !key.trim()}>{busy ? "Testing…" : "Test connection"}</button>}
          {!serverMode && <button className="mab solid" type="button" onClick={save} disabled={busy || !key.trim() || !ws.trim()}>Save key</button>}
        </div>
    </WorkspaceDialog>
  );
}
