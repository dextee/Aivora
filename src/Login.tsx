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
  const [showPassword, setShowPassword] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null); setNote(null); setBusy(true);
    try {
      if (mode === "in") await signIn(email.trim(), pw);
      else {
        const data = await signUp(email.trim(), pw);
        if (!data.session) {
          setMode("in");
          setPw("");
          setShowPassword(false);
          setNote("Check your email to confirm your account, then sign in.");
        }
      }
    } catch (x) { setErr(x instanceof Error ? x.message : String(x)); }
    finally { setBusy(false); }
  }

  return (
    <main className="login-wrap">
      <form className="login-card workspace-login" onSubmit={submit} aria-busy={busy}>
        <img src="/logo.png" alt="" width="54" height="54" />
        <h1>{mode === "in" ? "Sign in to AIVORA" : "Create your AIVORA account"}</h1>
        <label className="workspace-login-field">
          <span>Email address</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required />
        </label>
        <div className="workspace-login-field">
          <label htmlFor="login-password">Password</label>
          <div className="workspace-login-password">
            <input id="login-password" value={pw} onChange={(e) => setPw(e.target.value)}
              type={showPassword ? "text" : "password"} autoComplete={mode === "in" ? "current-password" : "new-password"} required />
            <button type="button" onClick={() => setShowPassword((visible) => !visible)}>{showPassword ? "Hide" : "Show"}</button>
          </div>
        </div>
        {err && <p className="login-err" role="alert">{err}</p>}
        {note && <p className="login-note" role="status">{note}</p>}
        <button type="submit" className="gobtn" disabled={busy || !email.trim() || !pw}>
          {busy ? (mode === "in" ? "Signing in…" : "Creating account…") : mode === "in" ? "Sign in" : "Create account"}
        </button>
        <button type="button" className="login-alt" disabled={busy}
          onClick={() => { setMode((m) => (m === "in" ? "up" : "in")); setErr(null); setNote(null); setShowPassword(false); }}>
          {mode === "in" ? "Create an account" : "Already have an account? Sign in"}
        </button>
        <a className="login-alt" href="/">Project overview</a>
      </form>
    </main>
  );
}
