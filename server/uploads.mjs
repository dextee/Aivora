/* AIVORA — composer attachment store (feat/composer-attachments).
 * A LOCAL, per-instance upload sink. Bytes stay on this server (in-memory map +
 * an on-disk mirror under odai/uploads/) and are NEVER forwarded to an external
 * provider, so this does not violate the "no external-upload sink" invariant
 * (server/odai/awa_eval.mjs external_writes_enabled=false).
 *
 * Ingestion is honest: only text-extractable files (txt/md, and best-effort docx)
 * are handed to the Qwen4-Max text brain. pdf/image/mp3/mp4 are stored and
 * acknowledged, never fabricated as "analyzed" — the text model cannot read them.
 *
 * node builtins only. Paths use fileURLToPath (Windows-safe). Owner env is read at
 * CALL time, never at import.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";
import { randomUUID } from "node:crypto";

/* ---- limits ---- */
export const MAX_BYTES = 25 * 1024 * 1024;          // decoded file size
export const MAX_TEXT_CHARS = 200_000;              // extracted text handed to the model

/* ---- allowed kinds (exact allowlist; "all image types" via image/ mime prefix) ---- */
const EXT_KIND = new Map([
  ["mp4", "video"], ["m4v", "video"],
  ["mp3", "audio"], ["m4a", "audio"],
  ["png", "image"], ["jpg", "image"], ["jpeg", "image"], ["gif", "image"],
  ["webp", "image"], ["bmp", "image"], ["svg", "image"], ["tiff", "image"], ["tif", "image"], ["heic", "image"],
  ["pdf", "pdf"],
  ["docx", "docx"],
  ["txt", "text"], ["md", "text"], ["markdown", "text"], ["csv", "text"],
]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv"]);
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/* uploads dir: <repo>/odai/uploads  (override with AIVORA_UPLOAD_DIR at call time) */
function uploadsDir() {
  const override = process.env.AIVORA_UPLOAD_DIR;
  if (override) return path.resolve(override);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return path.join(repoRoot, "odai", "uploads");
}

/* in-memory cache: id -> meta */
const store = new Map();

const extOf = (name) => {
  const i = String(name || "").lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};

/** Classify a {name, mime} pair. Returns a kind string or null when disallowed. */
export function classify(name, mime) {
  const m = String(mime || "").toLowerCase();
  const e = extOf(name);
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m === DOCX_MIME) return "docx";
  if (TEXT_MIMES.has(m)) return "text";
  return EXT_KIND.get(e) || null;
}

/* ---- text extraction ---- */
function extractText(kind, buf) {
  if (kind === "text") {
    let t = buf.toString("utf8");
    const truncated = t.length > MAX_TEXT_CHARS;
    if (truncated) t = t.slice(0, MAX_TEXT_CHARS);
    return { text: t, truncated };
  }
  if (kind === "docx") {
    try { return docxText(buf); } catch { return { text: null, truncated: false }; }
  }
  return { text: null, truncated: false }; // pdf/image/audio/video: not analyzable by the text model
}

/* Minimal ZIP reader: locate word/document.xml in a .docx and pull its text. */
function docxText(buf) {
  const xml = zipEntry(buf, "word/document.xml");
  if (!xml) return { text: null, truncated: false };
  let s = xml.toString("utf8");
  s = s.replace(/<\/w:p>/g, "\n").replace(/<w:br\s*\/?>/g, "\n").replace(/<w:tab\s*\/?>/g, "\t");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
       .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  const truncated = s.length > MAX_TEXT_CHARS;
  if (truncated) s = s.slice(0, MAX_TEXT_CHARS);
  return { text: s, truncated };
}

function zipEntry(buf, want) {
  // End of Central Directory record (sig 0x06054b50) sits near the tail.
  let eocd = -1;
  const min = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const fnLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const fname = buf.toString("utf8", off + 46, off + 46 + fnLen);
    if (fname === want) {
      // local header (sig 0x04034b50): its own name/extra lengths may differ.
      if (buf.readUInt32LE(lho) !== 0x04034b50) return null;
      const lfn = buf.readUInt16LE(lho + 26);
      const lex = buf.readUInt16LE(lho + 28);
      const dataStart = lho + 30 + lfn + lex;
      const data = buf.subarray(dataStart, dataStart + csize);
      return method === 8 ? inflateRawSync(data) : method === 0 ? Buffer.from(data) : null;
    }
    off += 46 + fnLen + extraLen + commentLen;
  }
  return null;
}

/* ---- disk mirror (restart-safe) ---- */
function safeWrite(id, meta, buf) {
  try {
    const dir = uploadsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, id + ".json"), JSON.stringify(meta, null, 2));
    if (buf) writeFileSync(path.join(dir, id + ".bin"), buf);
  } catch { /* mirror is best-effort; memory copy still authoritative for this instance */ }
}

function loadFromDisk(id) {
  try {
    const p = path.join(uploadsDir(), id + ".json");
    if (!existsSync(p)) return null;
    const meta = JSON.parse(readFileSync(p, "utf8"));
    if (meta && meta.id === id) { store.set(id, meta); return meta; }
  } catch { /* ignore */ }
  return null;
}

/* ---- public API ---- */

/** Validate + store one base64 file. Returns {ok:true, meta} or {ok:false, error, status}. */
export function storeUpload({ name, mime, data }) {
  const cleanName = String(name || "file").split(/[\\/]/).pop().slice(0, 200) || "file";
  const kind = classify(cleanName, mime);
  if (!kind) return { ok: false, status: 415, error: `unsupported file type (${extOf(cleanName) || mime || "unknown"})` };

  let buf;
  try { buf = Buffer.from(String(data || ""), "base64"); }
  catch { return { ok: false, status: 400, error: "invalid base64 payload" }; }
  if (!buf || buf.length === 0) return { ok: false, status: 400, error: "empty file" };
  if (buf.length > MAX_BYTES) return { ok: false, status: 413, error: `file exceeds ${Math.floor(MAX_BYTES / (1024 * 1024))} MB limit` };

  const id = randomUUID();
  const { text, truncated } = extractText(kind, buf);
  const analyzable = text !== null;
  const meta = {
    id, name: cleanName, mime: String(mime || ""), kind,
    size: buf.length, analyzable, truncated: !!truncated,
    text: analyzable ? text : null,
    created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  store.set(id, meta);
  safeWrite(id, meta, buf);
  return { ok: true, meta: publicMeta(meta) };
}

/** Metadata only (never the bytes or full text) for HTTP responses. */
export function publicMeta(meta) {
  return {
    id: meta.id, name: meta.name, mime: meta.mime, kind: meta.kind,
    size: meta.size, analyzable: meta.analyzable, truncated: meta.truncated,
    text_chars: meta.analyzable && typeof meta.text === "string" ? meta.text.length : 0,
    created_at: meta.created_at,
  };
}

export function getUploadMeta(id) {
  const meta = store.get(id) || loadFromDisk(id);
  return meta || null;
}

/** Build an honest context block for the model from a list of attachment ids. */
export function contextForAttachments(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return "";
  const blocks = [];
  for (const rawId of ids.slice(0, 8)) {
    const id = String(rawId || "");
    const meta = store.get(id) || loadFromDisk(id);
    if (!meta) { blocks.push(`[attachment ${id.slice(0, 8)} not found]`); continue; }
    const label = `${meta.name} (${meta.kind}, ${(meta.size / 1024).toFixed(0)} KB)`;
    if (meta.analyzable && typeof meta.text === "string" && meta.text.length) {
      blocks.push(`Attached file ${label}${meta.truncated ? ", text truncated" : ""}:\n"""\n${meta.text}\n"""`);
    } else {
      blocks.push(`Attached file ${label} — stored for the user, but not readable by the text model (no analysis of its contents).`);
    }
  }
  return blocks.join("\n\n");
}
