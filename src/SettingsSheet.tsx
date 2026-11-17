import { useState } from "react";
import { DEFAULT_WS, REGIONS, type AiConfig, type ConnSource, clearConfig, loadConfig, saveConfig, testKey } from "./lib";

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
    setStatus({ ok: true, detail: "Removed from this browser." });
    onChanged();
  }
  // format sanity guard for the browser-paste path
  function onBlur() {
    if (!key.trim()) return;
    if (!looksValid) setHint("This doesn't look like a Model Studio key (expected sk-…). Double-check it.");
    else if (/\s/.test(key)) setHint("Remove spaces / newlines from the pasted key.");
    else setHint(null);
  }

  const serverMode = conn === "env";

  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="API connection" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>🔐 API connection</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {serverMode ? (
          <p className="mstat ok" style={{ marginBottom: 12 }}>
            ✓ Connected via server — the Page environment key is active. Live call, translate and
            document tools work for every visitor of this build; nothing to paste.
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
            <label className="fld"><span>Model Studio API key</span>
              <div className="keyrow">
                <input type={show ? "text" : "password"} value={key}
                  onChange={(e) => setKey(e.target.value)} onBlur={onBlur}
                  placeholder="sk-…" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                <button className="icon-btn" onClick={() => setShow((s) => !s)} aria-label="Show key">{show ? "🙈" : "👁"}</button>
              </div>
            </label>
            <p className="dnote" style={{ marginTop: 0 }}>
              Your key looks valid ✓ — keep it here or on your own server. Do not share this
              screen or its URL. This stores the key only in <b>this browser</b>. For a build every
              visitor can use, keep the key as a Page env var instead (owner-controlled).
            </p>
          </>
        )}

        {status && <p className={`mstat ${status.ok ? "ok" : "bad"}`}>{status.ok ? "✓ " : "✕ "}{status.detail}</p>}

        <div className="modal-actions">
          <button className="mab" onClick={forget}>Forget key</button>
          {!serverMode && <button className="mab" onClick={test} disabled={busy || !key.trim()}>{busy ? "Testing…" : "Test"}</button>}
          {!serverMode && <button className="mab solid" onClick={save}>Save</button>}
        </div>
        <p className="modal-note">
          Precedence: Page server key &gt; browser key &gt; none (voice disabled until a key exists).
          Rotate keys anytime in the Model Studio console.
        </p>
      </div>
    </div>
  );
}
