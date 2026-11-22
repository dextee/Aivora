/* feat: Supabase Auth client wiring.
 * Reads the client-safe config from GET /api/config/supabase (URL + publishable key only —
 * never the service key). When Supabase is not configured, every helper degrades to a no-op
 * and the app keeps its existing offline/owner-key behavior unchanged. */
import { createClient, type Session } from "@supabase/supabase-js";

type SupaConfig = { configured: boolean; url?: string; publishableKey?: string; instanceId?: string };

let cfg: SupaConfig = { configured: false };
let sb: ReturnType<typeof createClient> | null = null;
let session: Session | null = null;
let ready = false;
const subs = new Set<(s: Session | null) => void>();
const emit = () => { for (const f of subs) { try { f(session); } catch { /* listener */ } } };

export async function initAuth(): Promise<SupaConfig> {
  try {
    const r = await fetch(`/api/config/supabase?_t=${Date.now()}`);
    if (r.ok) cfg = (await r.json()) as SupaConfig;
  } catch { cfg = { configured: false }; }
  if (cfg.configured && cfg.url && cfg.publishableKey) {
    sb = createClient(cfg.url, cfg.publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
    const { data } = await sb.auth.getSession();
    session = data.session ?? null;
    sb.auth.onAuthStateChange((_evt, s) => { session = s ?? null; emit(); });
  }
  ready = true;
  emit();
  return cfg;
}

export const authReady = () => ready;
export const isSupabaseConfigured = () => !!(cfg.configured && sb);
export const isSignedIn = () => !!session;

/** Current Supabase access token, or null (offline / signed out). Sent as Authorization: Bearer. */
export function getAccessToken(): string | null { return session?.access_token ?? null; }

export async function signIn(email: string, password: string) {
  if (!sb) throw new Error("Supabase is not configured");
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  session = data.session; emit();
  return session;
}

export async function signUp(email: string, password: string) {
  if (!sb) throw new Error("Supabase is not configured");
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) throw error;
  session = data.session ?? null; emit();
  return data;
}

export async function signOut() {
  if (sb) { try { await sb.auth.signOut(); } catch { /* ignore */ } }
  session = null; emit();
}

export function onAuth(cb: (s: Session | null) => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
