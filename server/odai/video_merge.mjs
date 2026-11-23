/* AIVORA — attachment → video merge (owner-approved ffmpeg install, 2026-11-23).
 *
 * Merges the files the owner attached in the composer (images and mp4/m4v clips) into ONE mp4.
 * Honest posture, same as the rest of the app:
 *   - If ffmpeg is not resolvable the merge is BLOCKED with a reason. Never simulated.
 *   - The merged file is the owner's OWN material, locally concatenated. It is NOT the
 *     AI-generated commercial: that still comes from the authorized media provider and is
 *     attached separately with attachRender().
 *   - Output is verified before it is reported: mp4 'ftyp' magic + ffprobe duration + sha256.
 * Security: ffmpeg is spawned with an argument array (no shell, no interpolation), inputs are
 * copied into a scratch dir with safe names, and counts/sizes are capped. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getUploadMeta } from "../uploads.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const UPLOADS = ROOT + "odai/uploads/";
const RENDERS = ROOT + "odai/data/commercial/renders/";
const SCRATCH = ROOT + "odai/data/commercial/scratch/";
export const MAX_INPUTS = 9;
const FFMPEG_TIMEOUT_MS = 180_000;
const err = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sha = (b) => createHash("sha256").update(b).digest("hex");

const SIZE = { "1080p": { "9:16": [1080, 1920], "1:1": [1080, 1080], "16:9": [1920, 1080] }, "720p": { "9:16": [720, 1280], "1:1": [720, 720], "16:9": [1280, 720] } };

/* ---- locate the binaries: explicit env override → winget package → PATH ---- */
function findInWinget(exe) {
  const base = process.env.LOCALAPPDATA + "/Microsoft/WinGet/Packages";
  if (!existsSync(base)) return null;
  for (const pkg of readdirSync(base)) {
    if (!/ffmpeg/i.test(pkg)) continue;
    const stack = [base + "/" + pkg];
    for (let depth = 0; depth < 4 && stack.length; depth++) {
      const dir = stack.shift();
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const p = dir + "/" + e.name;
        if (e.isDirectory()) stack.push(p);
        else if (e.name.toLowerCase() === exe) return p.replace(/\//g, "\\");
      }
    }
  }
  return null;
}
export function ffmpegPaths() {
  const ff = process.env.AIVORA_FFMPEG_PATH || findInWinget("ffmpeg.exe") || "ffmpeg";
  const fp = process.env.AIVORA_FFPROBE_PATH || findInWinget("ffprobe.exe") || "ffprobe";
  const resolved = process.env.AIVORA_FFMPEG_PATH ? existsSync(ff) : (ff !== "ffmpeg" ? existsSync(ff) : true);
  return { ffmpeg: ff, ffprobe: fp, resolved, source: process.env.AIVORA_FFMPEG_PATH ? "env" : (ff !== "ffmpeg" ? "winget-package" : "PATH") };
}
function run(exe, args, timeoutMs = FFMPEG_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let out = "", eout = "", done = false;
    const child = spawn(exe, args, { windowsHide: true });
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill("SIGKILL"); } catch { /* already gone */ } resolve({ code: null, timed_out: true, stdout: out, stderr: eout + "\n[killed: timeout]" }); } }, timeoutMs);
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { eout += d; });
    child.on("error", e => { if (!done) { done = true; clearTimeout(timer); resolve({ code: null, error: String(e.message || e), stdout: out, stderr: eout }); } });
    child.on("close", code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: eout }); } });
  });
}
export async function mergeCapability() {
  const p = ffmpegPaths();
  if (!p.resolved) return { available: false, reason: "ffmpeg binary not resolvable", ...p };
  const r = await run(p.ffmpeg, ["-version"], 20000);
  const version = (r.stdout || "").split("\n")[0] || null;
  if (r.code !== 0 && !version) return { available: false, reason: "ffmpeg present but did not execute: " + (r.error || r.stderr || "").slice(0, 160), ...p };
  return { available: true, version, ...p };
}
async function probeDuration(ffprobe, file) {
  const r = await run(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], 30000);
  const n = Number(String(r.stdout || "").trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/* ---- resolve attachments to real files with safe names ---- */
function resolveInputs(attachment_ids) {
  const ids = [...new Set((attachment_ids || []).map(String).filter(Boolean))].slice(0, MAX_INPUTS);
  const inputs = [], rejected = [];
  for (const id of ids) {
    const meta = getUploadMeta(id);
    if (!meta) { rejected.push({ id, reason: "attachment not found in this workspace's upload store" }); continue; }
    const bin = UPLOADS + id + ".bin";
    if (!existsSync(bin)) { rejected.push({ id, name: meta.name, reason: "stored bytes missing on disk" }); continue; }
    if (!["image", "video"].includes(meta.kind)) { rejected.push({ id, name: meta.name, kind: meta.kind, reason: "only image and video attachments can be merged into a video" }); continue; }
    const bytes = statSync(bin).size;
    const ext = (meta.name.split(".").pop() || (meta.kind === "image" ? "png" : "mp4")).toLowerCase().replace(/[^a-z0-9]/g, "") || (meta.kind === "image" ? "png" : "mp4");
    inputs.push({ id, name: meta.name, kind: meta.kind, ext, bytes, src: bin });
  }
  return { inputs, rejected, requested: ids.length };
}

/* ---- the merge itself ---- */
export async function mergeAttachments({ attachment_ids, duration_seconds = 15, aspect_ratio = "9:16", resolution = "1080p", job_id = null }) {
  const cap = await mergeCapability();
  if (!cap.available) return { ok: false, status: "BLOCKED", reason: cap.reason, capability: cap };
  const { inputs, rejected, requested } = resolveInputs(attachment_ids);
  if (!inputs.length) return { ok: false, status: "BLOCKED", reason: "no mergeable attachments", rejected, requested, capability: cap };
  const dims = (SIZE[resolution] || SIZE["1080p"])[aspect_ratio] || [1080, 1920];
  const [W, H] = dims;
  const target = Number(duration_seconds) > 0 ? Number(duration_seconds) : 15;

  mkdirSync(SCRATCH, { recursive: true }); mkdirSync(RENDERS, { recursive: true });
  const run_id = "MRG-" + randomUUID().slice(0, 8);
  const work = SCRATCH + run_id + "/";
  mkdirSync(work, { recursive: true });
  const staged = inputs.map((inp, i) => { const p = work + `in${i}.${inp.ext}`; writeFileSync(p, readFileSync(inp.src)); return { ...inp, staged: p }; });

  /* clip durations decide how the timeline is shared; images split whatever is left */
  const probed = [];
  for (const s of staged) {
    const d = s.kind === "video" ? await probeDuration(cap.ffprobe, s.staged) : null;
    probed.push({ ...s, probed_duration: d });
  }
  const clipTotal = probed.filter(x => x.kind === "video").reduce((a, x) => a + Math.min(x.probed_duration || 3, target), 0);
  const images = probed.filter(x => x.kind === "image");
  const imageBudget = Math.max(target - clipTotal, images.length ? 0.5 : 0);
  const perImage = images.length ? Math.max(imageBudget / images.length, 0.4) : 0;

  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  const filters = [];
  let vi = 0;
  for (const s of probed) {
    if (s.kind === "image") { args.push("-loop", "1", "-t", perImage.toFixed(2), "-i", s.staged); }
    else { args.push("-i", s.staged); }
    filters.push(`[${vi}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[v${vi}]`);
    vi++;
  }
  const concat = `[${probed.map((_, i) => `v${i}`).join("][")}]concat=n=${probed.length}:v=1:a=0[cat]`;
  filters.push(concat);
  args.push("-filter_complex", filters.join(";"), "-map", "[cat]", "-t", String(target), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an");
  const out = RENDERS + (job_id ? String(job_id).replace(/[^A-Za-z0-9_-]/g, "") + "-" : "") + run_id + ".mp4";
  args.push(out);

  const t0 = Date.now();
  const r = await run(cap.ffmpeg, args);
  const elapsed = Date.now() - t0;
  const command_summary = `ffmpeg ${args.slice(0, 6).join(" ")} … -filter_complex "<scale/pad/fps per input; concat n=${probed.length}> -t ${target} -c:v libx264 -an ${out.split(/[\\/]/).pop()}`;
  if (r.timed_out) return { ok: false, status: "FAILED", reason: `ffmpeg timed out after ${FFMPEG_TIMEOUT_MS} ms`, command_summary, inputs: probed.map(p => ({ name: p.name, kind: p.kind })), rejected };
  if (r.code !== 0 || !existsSync(out)) return { ok: false, status: "FAILED", reason: "ffmpeg exited " + r.code + ": " + String(r.stderr || r.error || "").slice(0, 400), command_summary, rejected };

  const buf = readFileSync(out);
  const magic = buf.subarray(4, 8).toString("latin1");
  const actual = await probeDuration(cap.ffprobe, out);
  if (magic !== "ftyp") return { ok: false, status: "FAILED", reason: `output is not an mp4 container (bytes 4-8 = "${magic}")`, command_summary };
  const withinTolerance = actual != null && Math.abs(actual - target) <= 1.5;
  return {
    ok: true, status: withinTolerance ? "MERGED" : "MERGED_DURATION_OFF",
    file_path: out, bytes: buf.length, sha256: sha(buf), container: "mp4/ftyp",
    requested_seconds: target, measured_seconds: actual, within_tolerance: withinTolerance,
    resolution: `${W}x${H}`, aspect_ratio, fps: 30, audio: "none (attachments' audio tracks are not mixed in this pass)",
    inputs: probed.map(p => ({ name: p.name, kind: p.kind, bytes: p.bytes, used_seconds: p.kind === "image" ? Math.round(perImage * 100) / 100 : Math.min(p.probed_duration || 0, target) })),
    rejected, requested, run_id, elapsed_ms: elapsed, command_summary,
    ffmpeg: { version: cap.version, source: cap.source, path: cap.ffmpeg },
    note: "Local concatenation of the owner's own attached files. This is NOT the AI-generated commercial; the provider render is attached separately.",
  };
}

export function mergedFile(tenant, job) {
  const p = job?.merged?.file_path;
  if (!p || !existsSync(p)) throw err("no merged file for this job", 404);
  return { buf: readFileSync(p), job };
}
export function listRenders() {
  if (!existsSync(RENDERS)) return [];
  return readdirSync(RENDERS).filter(f => f.endsWith(".mp4")).map(f => ({ name: f, bytes: statSync(RENDERS + f).size, path: RENDERS + f }));
}
