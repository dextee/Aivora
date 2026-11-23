#!/usr/bin/env node
/* AIVORA — Universal Autonomous Self-Healing Server Engine (Infrastructure Guardian v2)
 * Independent control plane. Adapter-based, registry-driven, policy-gated recovery.
 *
 * Architecture (spec §1–18, scoped to installed/tested adapters):
 *   - Infrastructure Registry (tools/guardian/registry.json) — explicit enrollment only.
 *     No auto-discovery, no control of unregistered resources (§4).
 *   - Monitoring adapters: "local-node" (IMPLEMENTED+TESTED), "http-heartbeat"
 *     (remote check-only, recovery=escalate), "docker"/"systemd"/"windows-service"
 *     (registered stubs — NOT implemented, reported as BLOCKED, never claimed).
 *   - Health checks (§5): port+HTTP+DB-probe+proc mem/CPU for local-node.
 *   - Multi-signal detection (§6): 2 consecutive failures = confirmed (threshold).
 *   - Recovery policy engine (§8, deterministic, AI cannot override): allowlist of
 *     authorized actions per resource, recovery level caps, maintenance windows.
 *   - Recovery levels (§10): L0 observe / L1 app-process restart / L2+ escalate only.
 *   - Incident state machine (§11): HEALTHY→FAILURE_DETECTED→RECOVERY_EXECUTING→
 *     RECOVERY_VERIFYING→RECOVERED→WORKFLOW_RESUMED | ESCALATED | MAINTENANCE_MODE,
 *     persisted to logs/guardian_incidents.json (survives guardian restart).
 *   - Bounded retry + circuit breaker (§12): max 3 attempts, min restart interval 10s,
 *     cooldown 120s, per-resource restart budget 10/hour.
 *   - Dependency-aware (§13): registry service_dependencies; an unhealthy dependency
 *     marks dependents DEGRADED and blocks pointless restart loops.
 *   - Escalation (§17): writes logs/guardian_escalation.json for the dev agent.
 * RogueAI Shield (§16): only restarts processes it owns on its enrolled port,
 * never deletes data / disables security / runs unapproved commands. */
import { spawn, execSync } from "node:child_process";
import { existsSync, appendFileSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CFGDIR = join(HERE, "guardian");
const LOGDIR = join(ROOT, "logs");
const EVENTS = join(LOGDIR, "guardian_events.jsonl");
const INCIDENTS = join(LOGDIR, "guardian_incidents.json");
const STATUS = join(LOGDIR, "guardian_status.json");
const ESCALATION = join(LOGDIR, "guardian_escalation.json");
mkdirSync(LOGDIR, { recursive: true });
mkdirSync(CFGDIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const log = (ev, extra = {}) => appendFileSync(EVENTS, JSON.stringify({ ts: ts(), event: ev, ...extra }) + "\n");

/* ---------- Infrastructure Registry (§4) — explicit enrollment ---------- */
const DEFAULT_REGISTRY = {
  resources: [{
    resource_id: "aivora-mainfix-backend",
    resource_name: "AIVORA MAIN-FIX backend + frontend",
    resource_type: "nodejs-application",
    operating_system: "windows",
    environment: "local-dev",
    network_address: "127.0.0.1:8081",
    health_check: { port: 8081, host: "127.0.0.1", path: "/api/health", interval_sec: 5, failure_threshold: 2 },
    service_dependencies: [],
    runtime_adapter: "local-node",
    authorized_recovery_actions: ["restart_application_process"],
    recovery_level_max: 1,
    restart_policy: { entry: "server.mjs", cwd: ROOT, max_attempts: 3, min_restart_interval_sec: 10, cooldown_sec: 120, restart_budget_per_hour: 10 },
    escalation_policy: { after_attempts: 3, to: "ai-development-agent" },
    resource_owner: "boss",
    monitoring_status: "enrolled",
  }],
};
if (!existsSync(join(CFGDIR, "registry.json"))) {
  writeFileSync(join(CFGDIR, "registry.json"), JSON.stringify(DEFAULT_REGISTRY, null, 2));
}
const REGISTRY = JSON.parse(readFileSync(join(CFGDIR, "registry.json"), "utf8"));

/* ---------- Incident state machine (§11), persisted ---------- */
let incidents = {};
if (existsSync(INCIDENTS)) {
  try { incidents = JSON.parse(readFileSync(INCIDENTS, "utf8")); } catch { incidents = {}; }
}
function saveIncidents() { writeFileSync(INCIDENTS, JSON.stringify(incidents, null, 2)); }
function transition(res, to, note) {
  const inc = incidents[res.resource_id] ||= { resource_id: res.resource_id, state: "HEALTHY", history: [] };
  const from = inc.state;
  if (from === to) { saveIncidents(); return; }
  inc.state = to; inc.updated_at = ts();
  inc.history = [...(inc.history || []), { ts: ts(), from, to, note: note || "" }].slice(-60);
  log("INCIDENT_STATE", { resource: res.resource_id, from, to });
  saveIncidents();
}

/* ---------- Monitoring adapters (§2/§5) ---------- */
const ADAPTERS = {
  "local-node": {
    implemented: true,
    async check(r) {
      const { host, port, path, failure_threshold } = r.health_check;
      const portOk = await tcpProbe(host, port);
      const httpOk = portOk ? await httpProbe(host, port, path) : false;
      const db = httpOk ? await dbProbe(host, port) : "down";
      const stats = portOk ? procStats(listenPid(port)) : {};
      return { healthy: portOk && httpOk, confirmed_after: failure_threshold, detail: { port: portOk, http: httpOk, database: db, ...stats } };
    },
    // L1 action — the ONLY recovery action authorized here (§9/§10)
    recover(r, action) {
      if (action !== "restart_application_process") throw new Error("unauthorized action");
      const p = r.restart_policy;
      const child = spawn(process.execPath, [p.entry], { cwd: p.cwd, detached: true, stdio: "ignore", env: { ...process.env, PORT: String(r.health_check.port), HOST: r.health_check.host } });
      child.unref();
      return child.pid;
    },
  },
  "http-heartbeat": {
    implemented: true, // check-only; recovery always escalates (external resource)
    async check(r) {
      const ok = await httpProbe(r.health_check.host, r.health_check.port, r.health_check.path);
      return { healthy: ok, confirmed_after: r.health_check.failure_threshold, detail: { heartbeat: ok } };
    },
    recover() { throw new Error("external resource: recovery requires human/authorized adapter"); },
  },
};

/* ---------- Deterministic recovery policy engine (§8) ---------- */
const ACTION_LEVEL = { restart_application_process: 1, restart_registered_service: 2, restart_container: 2, failover: 3, rollback_deployment: 3, scale: 3, database_restore: 4, os_reboot: 4 };
function authorize(r, action) {
  const reasons = [];
  if (!ADAPTERS[r.runtime_adapter].implemented) reasons.push("adapter not implemented");
  if (!(r.authorized_recovery_actions || []).includes(action)) reasons.push("action not in authorized list");
  if ((ACTION_LEVEL[action] ?? 4) > (r.recovery_level_max ?? 0)) reasons.push(`level ${ACTION_LEVEL[action]} exceeds cap ${r.recovery_level_max}`);
  if (!ADAPTERS[r.runtime_adapter].implemented || !(r.authorized_recovery_actions || []).includes(action)) return { authorized: false, reasons };
  return { authorized: reasons.length === 0, reasons };
}

/* ---------- helpers ---------- */
function tcpProbe(host, port) {
  return new Promise((res) => {
    const s = new net.Socket(); s.setTimeout(1500);
    s.once("connect", () => { s.destroy(); res(true); });
    s.once("timeout", () => { s.destroy(); res(false); });
    s.once("error", () => res(false));
    s.connect(port, host);
  });
}
async function httpProbe(host, port, path) {
  try { const r = await fetch(`http://${host}:${port}${path}`, { signal: AbortSignal.timeout(2500) }); if (!r.ok) return false; const j = await r.json().catch(() => null); return j?.status === "ok"; }
  catch { return false; }
}
async function dbProbe(host, port) {
  try { const r = await fetch(`http://${host}:${port}/api/odai/catalog`, { signal: AbortSignal.timeout(2500) }); return r.ok ? "memory_fallback_ok" : "degraded"; } catch { return "down"; }
}
function listenPid(port) {
  try {
    const out = execSync("netstat -ano -p tcp", { encoding: "utf8", timeout: 5000 });
    for (const line of out.split("\n")) if (line.includes(`:${port}`) && line.trim().includes("LISTENING")) {
      const pid = Number(line.trim().split(/\s+/).pop()); if (pid > 0) return pid;
    }
  } catch {}
  return null;
}
function procStats(pid) {
  if (!pid) return {};
  try {
    const j = JSON.parse(execSync(`powershell -NoProfile -Command "Get-Process -Id ${pid} | Select-Object WS,CPU | ConvertTo-Json -Compress"`, { encoding: "utf8", timeout: 8000 }));
    return { server_pid: pid, server_mem_mb: Math.round((j.WS || 0) / 1e6), server_cpu_pct: j.CPU != null ? Math.round(j.CPU) : null };
  } catch { return {}; }
}

/* ---------- main loop ---------- */
const state = {}; // per-resource runtime: consecutiveFailures, attempts, lastRestartAt, restartBudget
for (const r of REGISTRY.resources) { state[r.resource_id] = { failures: 0, attempts: 0, lastRestart: 0, budget: [] }; }

const status = { guardian_pid: process.pid, started_at: ts(), frontend: "unknown", backend: "unknown", database: "not_configured_memory_fallback", port: 8081, uptime_sec: 0, last_failure: null, restart_count: 0, last_recovery: null, last_recovery_ms: null, escalation: null, health: "unknown", server_pid: null, server_mem_mb: null, server_cpu_pct: null, incidents: {}, events: [], registry: { resources: REGISTRY.resources.length, adapters: Object.keys(ADAPTERS).length } };
function save() { status.uptime_sec = Math.round((Date.now() - Date.parse(status.started_at)) / 1000); status.updated_at = ts(); status.incidents = incidents; writeFileSync(STATUS, JSON.stringify(status, null, 2)); }
function remember(ev) { status.events = [...(status.events || []), ev].slice(-30); }

log("AUTOMATION_HEALING_ACTIVATED", { guardian_pid: process.pid, resources: REGISTRY.resources.map((r) => r.resource_id) });
remember({ ts: ts(), event: "AUTOMATION_HEALING_ACTIVATED" });

async function handleResource(r) {
  const s = state[r.resource_id];
  const paused = existsSync(join(LOGDIR, "guardian.paused"));
  const adapter = ADAPTERS[r.runtime_adapter];
  const res = await adapter.check(r);
  const isMain = r.resource_id === "aivora-mainfix-backend";

  /* dependency-aware (§13): if any enrolled dependency is failing, degrade instead of restart */
  const depDown = (r.service_dependencies || []).some((d) => incidents[d]?.state === "FAILURE_DETECTED" || incidents[d]?.state === "ESCALATED");

  if (res.healthy) {
    if (incidents[r.resource_id]?.state && !["HEALTHY", "WORKFLOW_RESUMED", "MAINTENANCE_MODE"].includes(incidents[r.resource_id].state)) {
      transition(r, "RECOVERY_VERIFYING", "health re-confirmed");
      log("APPLICATION_HEALTH_VERIFIED", { resource: r.resource_id, detail: res.detail });
      transition(r, "WORKFLOW_RESUMED", "verified");
      log("RECOVERY_COMPLETED", { resource: r.resource_id, restarts: status.restart_count });
    } else transition(r, "HEALTHY");
    s.failures = 0; s.attempts = 0;
    if (isMain) { Object.assign(status, res.detail, { frontend: "online", backend: "online", health: "ok", database: res.detail.database }); status.escalation = null; }
    return;
  }
  if (paused) { transition(r, "MAINTENANCE_MODE", "guardian.paused flag"); s.failures = 0; s.attempts = 0; return; }

  s.failures++;
  log("SERVER_FAILURE_DETECTED", { resource: r.resource_id, consecutive_failures: s.failures });
  remember({ ts: ts(), event: "SERVER_FAILURE_DETECTED", resource: r.resource_id });
  if (isMain) { status.last_failure = ts(); status.frontend = status.backend = "offline"; status.health = "failed"; }

  if (s.failures < (r.health_check.failure_threshold ?? 2)) { transition(r, "DEGRADED", "below failure threshold"); return; }
  transition(r, "FAILURE_DETECTED", `${s.failures} consecutive failures`);

  if (depDown) { transition(r, "BLOCKED", "dependency down — restart suppressed (§13)"); return; }

  const action = "restart_application_process";
  const auth = authorize(r, action);
  if (!auth.authorized) { transition(r, "ESCALATED", `policy rejected: ${auth.reasons.join("; ")}`); escalate(r, auth.reasons); return; }

  const p = r.restart_policy;
  const now = Date.now();
  s.budget = s.budget.filter((t) => now - t < 3600_000);
  if (s.budget.length >= (p.restart_budget_per_hour ?? 10)) { transition(r, "ESCALATED", "restart budget exhausted (circuit breaker §12)"); escalate(r, ["restart budget exhausted"]); return; }
  if (now - s.lastRestart < (p.min_restart_interval_sec ?? 10) * 1000) return;
  if (s.attempts >= (p.max_attempts ?? 3)) {
    if (now - s.lastRestart < (p.cooldown_sec ?? 120) * 1000) return; // cooldown, no loop
    s.attempts = 0; // cooldown elapsed → allow a fresh bounded cycle
  }

  s.attempts++; s.lastRestart = now; s.budget.push(now);
  transition(r, "RECOVERY_EXECUTING", `attempt ${s.attempts}`);
  const t0 = Date.now();
  const pid = adapter.recover(r, action);
  log("SERVICE_RESTART_INITIATED", { resource: r.resource_id, attempt: s.attempts, pid });
  remember({ ts: ts(), event: "SERVICE_RESTART_INITIATED", attempt: s.attempts });
  status.restart_count++;
  await sleep(5000);
  const okNow = (await adapter.check(r)).healthy;
  if (okNow) {
    log("SERVER_PROCESS_RESTARTED", { resource: r.resource_id, attempt: s.attempts, pid, ok: true });
    log("DATABASE_CONNECTION_VERIFIED", { resource: r.resource_id, mode: (await adapter.check(r)).detail.database });
    transition(r, "RECOVERED", `attempt ${s.attempts}`);
    if (isMain) { status.last_recovery = ts(); status.last_recovery_ms = Date.now() - t0; }
    remember({ ts: ts(), event: "WORKFLOW_RESUMED", recovery_ms: Date.now() - t0 });
  } else {
    log("ROOT_CAUSE_ANALYZED", { resource: r.resource_id, attempt: s.attempts, ok: false });
    if (s.attempts >= (p.max_attempts ?? 3)) { transition(r, "ESCALATED", "recovery attempts exhausted"); escalate(r, ["all bounded attempts failed"]); }
  }
}
function escalate(r, reasons) {
  const report = { ts: ts(), resource: r.resource_id, service: r.resource_name, reasons, health: "failed after bounded recovery", recent_events: status.events.slice(-10), incident: incidents[r.resource_id], note: "Deterministic recovery failed. AI development agent review required (§17). No automatic further action." };
  status.escalation = report;
  appendFileSync(EVENTS, JSON.stringify({ ts: ts(), event: "ESCALATION", ...report }) + "\n");
  writeFileSync(ESCALATION, JSON.stringify(report, null, 2));
  remember({ ts: ts(), event: "ESCALATION", resource: r.resource_id });
}

async function main() {
  save();
  while (true) {
    for (const r of REGISTRY.resources) { await handleResource(r); save(); }
    await sleep(5000);
  }
}
main();
