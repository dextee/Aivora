import { useState, type FormEvent } from "react";
import { signIn, signUp } from "./auth";

/* Minimal Supabase Auth sign-in / sign-up. Rendered only when the server reports Supabase
 * is configured AND there is no session; otherwise the app renders its normal (offline) tree. */
export function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [mode, setMode] = useState<"in" | "up">("in");
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null); setNote(null); setBusy(true);
    try {
      if (mode === "in") { await signIn(email, pw); }
      else { const d = await signUp(email, pw); if (!d.session) setNote("Account created — confirm your email, then sign in."); }
    } catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h3>{mode === "in" ? "Sign in to AIVORA" : "Create an account"}</h3>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="Email" autoComplete="username" />
        <input value={pw} onChange={(e) => setPw(e.target.value)} type="password" placeholder="Password" autoComplete={mode === "in" ? "current-password" : "new-password"} />
        {err && <p className="login-err">{err}</p>}
        {note && <p className="login-note">{note}</p>}
        <button type="submit" className="gobtn" disabled={busy || !email || !pw}>{busy ? "…" : mode === "in" ? "Sign in" : "Create account"}</button>
        <button type="button" className="login-alt" onClick={() => { setMode((m) => (m === "in" ? "up" : "in")); setErr(null); }}>
          {mode === "in" ? "Need an account?" : "Have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
