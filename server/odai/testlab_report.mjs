/* Test Lab report exporters: a dependency-free PDF and an exceljs workbook.
 * Both render the ACTUAL consolidated report (no fabricated results). */
import ExcelJS from "exceljs";

/* ---- minimal valid PDF (Helvetica, multi-page) ---- */
function esc(s) { return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)"); }
export function reportPdf(report) {
  const lines = [];
  lines.push(report.title || "AIVORA Inbox / Voice-to-Email Acceptance Report");
  lines.push("Run " + report.run_id + "  |  build " + report.build + "  |  " + report.generated_at);
  lines.push("");
  lines.push(`TOTAL ${report.total}   PASS ${report.passed}   FAIL ${report.failed}   BLOCKED ${report.blocked}`);
  lines.push("Live Gmail: " + report.live_gmail);
  lines.push("Sandbox adapter: " + report.sandbox_adapter);
  lines.push("Voice transcription accuracy: " + report.voice_transcription_accuracy);
  lines.push("");
  lines.push("CASE RESULTS");
  for (const c of report.cases) {
    lines.push(`[${c.status}] ${c.case_id} (${c.scope}) - ${c.description}`);
    lines.push("   observed: " + String(c.observed || "").slice(0, 160));
    if (c.reason) lines.push("   reason: " + String(c.reason).slice(0, 160));
    if (c.gmail_message_id) lines.push("   gmail_message_id: " + c.gmail_message_id);
    lines.push("   skills: " + (c.skills || []).join(", ") + "  |  " + c.duration_ms + "ms  |  " + (c.verifier || ""));
  }
  lines.push("");
  lines.push("INDEPENDENT DEV-11 VERIFICATION");
  for (const v of report.independent_verification || []) lines.push(`${v.case_id}: claimed ${v.claimed} -> ${v.verdict}${v.note ? " (" + v.note + ")" : ""}`);
  lines.push("");
  lines.push("REMAINING LIMITATIONS");
  for (const l of report.remaining_limitations || []) lines.push("- " + l);

  /* paginate ~48 lines/page */
  const pages = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  const objects = [];
  const pageRefs = [];
  const fontRef = 3;
  let next = 4;
  const contentRefs = [];
  for (const page of pages) {
    const stream = "BT /F1 9 Tf 40 780 Td 12 TL\n" + page.map((l) => `(${esc(l).slice(0, 110)}) Tj T*`).join("\n") + "\nET";
    const contentRef = next++;
    contentRefs.push({ ref: contentRef, stream });
    pageRefs.push(next++);
  }
  const pagesRef = next++;
  const catalogRef = next++;
  objects.push({ ref: 1, body: `<< /Type /Catalog /Pages ${pagesRef} 0 R >>` });
  objects.push({ ref: 2, body: `<< /Type /Pages /Kids [${pageRefs.map((r) => r + " 0 R").join(" ")}] /Count ${pageRefs.length} >>` });
  objects.push({ ref: fontRef, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" });
  pages.forEach((page, i) => {
    objects.push({ ref: pageRefs[i], body: `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontRef} 0 R >> >> /Contents ${contentRefs[i].ref} 0 R >>` });
    objects.push({ ref: contentRefs[i].ref, body: `<< /Length ${contentRefs[i].stream.length} >>\nstream\n${contentRefs[i].stream}\nendstream` });
  });
  objects.sort((a, b) => a.ref - b.ref);
  let pdf = "%PDF-1.4\n";
  const offsets = {};
  for (const o of objects) { offsets[o.ref] = pdf.length; pdf += `${o.ref} 0 obj\n${o.body}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let r = 1; r < next; r++) pdf += String(offsets[r]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

/* ---- exceljs workbook ---- */
export async function reportXlsx(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AIVORA Test Lab";
  const summary = wb.addWorksheet("Summary");
  summary.addRow([report.title || "AIVORA Inbox / Voice-to-Email Acceptance Report"]);
  summary.addRow(["Run", report.run_id]);
  summary.addRow(["Build", report.build]);
  summary.addRow(["Generated", report.generated_at]);
  summary.addRow(["Total", report.total]);
  summary.addRow(["Pass", report.passed]);
  summary.addRow(["Fail", report.failed]);
  summary.addRow(["Blocked", report.blocked]);
  summary.addRow(["Live Gmail", report.live_gmail]);
  summary.addRow(["Sandbox", report.sandbox_adapter]);
  summary.addRow(["Voice accuracy", report.voice_transcription_accuracy]);
  const ws = wb.addWorksheet("Results");
  ws.columns = [
    { header: "Case", key: "id", width: 10 },
    { header: "Category", key: "cat", width: 30 },
    { header: "Description", key: "desc", width: 34 },
    { header: "Scope", key: "scope", width: 10 },
    { header: "Status", key: "status", width: 10 },
    { header: "Observed", key: "obs", width: 60 },
    { header: "Reason", key: "reason", width: 50 },
    { header: "Skills", key: "skills", width: 40 },
    { header: "Gmail message ID", key: "mid", width: 28 },
    { header: "Duration ms", key: "dur", width: 12 },
    { header: "DEV-11", key: "ver", width: 30 },
  ];
  for (const c of report.cases) ws.addRow({ id: c.case_id, cat: c.category, desc: c.description, scope: c.scope, status: c.status, obs: c.observed, reason: c.reason || "", skills: (c.skills || []).join(", "), mid: c.gmail_message_id || "", dur: c.duration_ms, ver: c.verifier || "" });
  const ver = wb.addWorksheet("DEV-11 Verification");
  ver.columns = [{ header: "Case", key: "id", width: 10 }, { header: "Claimed", key: "claimed", width: 10 }, { header: "Verdict", key: "verdict", width: 20 }, { header: "Note", key: "note", width: 60 }];
  for (const v of report.independent_verification || []) ver.addRow(v);
  return Buffer.from(await wb.xlsx.writeBuffer());
}