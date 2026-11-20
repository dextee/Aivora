# AIVORA ODAI 6.0 — dynamic realtime build

## Project background

- Francis Teo's blueprint app (uploads/Blueprint.jpg, this session): an
  objective-driven AI business partner. Earlier static prototype proved the
  12-scene journey; the owner then supplied his brand logo and requested a
  WhatsApp-style mobile webapp with three live capabilities:
  **Live Call** (dialect voice partner), **Real-time Translate** (speech
  interpreter), **Document Translation** (text/photo/voice note).
- Dialect requirement unchanged: Hokkien (福建話/Southern Min) and Cantonese
  must be understood from the microphone — Model Studio realtime models are the
  only viable ASR path; browser/OS dictation lacks them.
- Owner requirement: **secret key stays inside QwenWork** — Page environment
  variable only, never in source, bundle, or chat echoes.

## Product shape (2026-11-18 single-button redesign)

- **One screen, one action**: TalkView = hero + single big green button
  (press = live WebRTC session with AIVORA; press again = end). No demo modes
  or scripted fallbacks anywhere — no key, clean server error.
- **Partner engine (owner decision 2026-11-18): `qwen-audio-3.1-realtime-flash`**
  — voice longanqian, server_vad (0.5/500) per owner's tested client; WebRTC +
  function calling confirmed on the model page. `src/rtc.ts` sends instructions +
  ROUTING_TOOLS; if the audio engine rejects the session shape it degrades once to
  the bare owner config and TalkView flips to keyword routing (interpret/
document phrases → same actions). qwen3.8-omni-flash-realtime remains available
  on the relay (`mode=omni`) and docs route — swap PARTNER_MODEL to revert.
- **Intelligent routing lives in the model**: session.update registers three
  tools (rtc.ts ROUTING_TOOLS): log_call (objective card),
  start_interpreter (target_language (app tears down the omni session and
  reconnects to qwen3.8-livetranslate-flash-realtime until user presses stop;
  heard/translated bubble pairs stream on the data channel),
  open_document_translator (app navigates to DocsView). DocsView translates
  text/photo/voice-note content via POST /api/analyze (qwen3.8-omni-flash,
  voice notes client-downmixed to 16 kHz WAV — the format omni-flash accepts).
- **Transport**: WebRTC only (the Pages gateway does not proxy WebSocket
  upgrades; the /realtime WS relay remains for localhost dev). SDP offer/answer
  is proxied by POST /api/webrtc/sdp (model allowlist; key injected
  server-side; answer returned unmodified), media tracks run browser ⇄
  Model Studio directly. session.create → session.update → session.updated
  before replaceTrack; handle server-created datachannel too (label "txt").
- **Chrome**: top bar (status: connected via server / browser key ✓ / add a key
  to go live), hamburger drawer (Talk, Document Translation, 🔐 API connection,
  About). Word "demo" must never appear in UI strings.
- **Key precedence** (Phase 2b): Page env DASHSCOPE_API_KEY > browser 🔐 key
  (__auth WS frame / x-aivora-auth header, per-request, never logged) > none.
- Owner logo: public/logo.png (AIVORA ODAI 6.0, compressed 512 px) + favicon.

## Constraints / decisions (summary)

- WhatsApp look per owner; drawer menu per owner; 520 px max width keeps it
  webapp-like on desktop.
- Demo fallbacks everywhere so a published page is never dead without a key.
- Model names may change per snapshot — server keeps them in one MODELS map.
- `npm run typecheck && npm test` must pass before publish; test boots the
  staged bundle (health check) — never bypass the publisher gate.
- **Route 4 (dev reference)**: `qwen-audio-3.1-realtime-flash` — WS `/realtime?mode=audio` (voice longanqian, server_vad); the Pages gateway still blocks browser WS, so this route serves native clients, server-side legs and A/B testing; owner's Python reference client lives in the template skill's INTEGRATION.md. Same DASHSCOPE_API_KEY.
- **Minnan ear upgrade (V5, owner directive 2026-11-19**: green button is now two-stage — local WAV turn capture → `POST /api/asr` (`qwen-audio-3.1-asr-flash`, DashScope native format, workspace `ws-1r19x1m4e2fa144f` via `ASR_WORKSPACE_ID` env default, same `DASHSCOPE_API_KEY`) → transcript drives routing (goal regex incl. 三成/百分之 parsing, interpreter/docs keywords, log_call dedupe) and is fed as `input_text` turn to the audio-realtime partner for spoken reply. Hold 0.5 s = hang up. ASR output parsing is a lenient cascade pending live schema confirmation.)
- **ASR workspace corrected (owner note 2026-11-19)**: qwen-audio-3.1-asr-flash lives on the SAME API + workspace ws-lj7gmtttiltwjlyv (Singapore) as the realtime/analyze models — ws-1r19x1m4e2fa144f from the sample curl was someone else's and produced Endpoint.AccessDenied; default now derives from WORKSPACE_ID, ASR_WORKSPACE_ID only as override.
- **V7 reply-path rebuild (owner symptom report 2026-11-19: transcription slow + no voice back)**: the browser-RTC reply leg (input_text item + remote track) was fragile → replaced by POST /api/talk — server-side realtime WS session (qwen-audio-3.1-realtime-flash, longanqian, manual response.create) returning {text, 24kHz audio b64, log_call tool} in one JSON; TalkView plays it via a gesture-unlocked AudioContext(24k). WAV uploads now silence-trimmed (±80 ms pad, TH 0.02) before /api/asr for speed; turn cap 45 s. Interpreter remains the only browser-WebRTC consumer. State machine now idle|recording|processing|interpreter.

- **V8**: Pages edge was observed caching POST/GET responses by exact path+method (stale 405 for /api/talk right after V7). All client API calls now carry a per-request `_t=Date.now()` query. Owner key IS in Page env (keyinfo reports source=env) and /api/talk proven end-to-end (transcript reply + 24kHz PCM base64).- **V9 REVERT (owner decision 2026-11-19)**: green button restored to continuous WebRTC on qwen-audio-3.1-realtime-flash (model listens directly; Min Nan handled by the realtime voice model itself). qwen-audio-3.1-asr-flash + /api/talk RPC pipeline RETIRED (/api/asr & /api/talk remain dormant for diagnostics). Routing tools + degrade + keyword fallback as in V4. blobsToWav kept (Docs voice notes).
- **V10 copy scrub (owner request)**: all Min Nan/Hokkien/福建話 references removed from user-facing surfaces — hero, About, model instructions sent by the client; built bundle greps clean (0 hits). Language auto-detection unaffected; dialects are heard, just no longer advertised. Dev comments retain the history.
- **V11 (owner directive 2026-11-19)**: batch ASR fully REMOVED — /api/asr & /api/talk routes, asr()/talk() server fns, MODELS.asr, ASR_WORKSPACE const. Realtime voice = WebRTC only: qwen-audio-3.1-realtime-flash (partner, direct listening) + qwen3.8-livetranslate-flash-realtime (interpreter) + /api/analyze (docs, request/response by design). Also now shipping Malay (Bahasa Melayu) + Tamil (தமிழ்) in hero list, interpreter keyword routing, docs targets, LNAME map.

## ODAI 9.0 upgrade — increment 1 COMPLETE, V23 staged (2026-11-20)

Pack extracted (work/pack9); contracts/config/FNY catalog vendored into repo `odai/` (catalog wrapped as QUARANTINE_REVIEW_REQUIRED).
- `server/odai/policy.mjs` (M08 pattern): loads R01-R19 VERBATIM from pack policy corpus; precedence BLOCK>HOLD>ALLOW; unknown actions fail CLOSED; connector readiness (external writes OFF) OUTRANKS rule table; X03-X12 recorded unavailable — nothing invented. modeAccess = server-authorized navigation, read grants only, no escalation (ui contract).
- `server/odai/workflow.mjs`: canonical 10 beats with receipts (run id, policy version, TEST labels, evidence). Human spend gate binds owner confirmation (R12) to governed resume (drafts+simulation) — real supplier order/emails/payments stay connector-NEVER; beat7 injects the synthetic invalid-product fixture and removes it before drafts (watch BLOCK); beat9 TEST order, handoff PREPARED, sent_to_supplier=false; beat10 profit per DB spec: actual vs TEST separated, UNKNOWN where COGS unverified, MYR per-currency separation. userView/managementView/securityView = three projections of ONE backend; decision summaries only, never CoT.
- `server/odai/store.mjs`: in-memory tenant-scoped (FC ephemeral), demo tenant + second isolation-test tenant; Supabase attach = planned increment (publish adds --with-database; entities per DB spec 3).
- Routes: /api/odai/modes | view?mode= | demo/start | demo/approve | catalog. prepare-publish now ships odai/ assets; runtime test manifest updated.
- Tests: 11/11 (pack contract pytest parity mirrored in node: 3; policy table; HTTP flow incl decline/watch-block/UNKNOWN-profit/two-tenant isolation/nav rejection + existing-route regression). Pack's own pytest: 3/3.
- Staging E2E on clupxd6g.qwenwork.page: gate→approve→resume; never-block watch; un-sent order; UNKNOWN profit; 6 shields + SIMULATED incidents; old routes regression fine.
- Existing functionality preserved: voice/interpreter/docs/store-builder routes + tests untouched and green.
## Increment 2 — three-mode UI (this commit)
- App chrome: USER|MGMT|SHIELD segmented control; switching is server-authorized via GET /api/odai/view?mode= (403 → surfaced, no local override; matches ui-mode contract §4). Topbar recolour per mode (purple navy chrome classes).
- USER mode rebuilt on approved screenshot: dark forest-green radial theme, "Hello, Boss!", six open-ended example chips (tapping sends the utterance as a text turn to the live session via sendTextTurn with pending-flush on ready), Today's Business card polling /api/odai/view?mode=user (sales/customer tiles = TEST fixtures WITH visible TEST badge, honest fineprint), What's Done list live from receipts + owner-approval pending hint. All prior talk/interpreter/docs/store behaviour preserved underneath.
- MANAGEMENT mode: purple QwenWork hub card w/ mission+6 specialist nodes+progress; live AI Execution Trace (2.5s poll, phase chips, decision colours ALLOW/HOLD/NEVER); beat-5 human spend gate as first-class UI (cap input, Approve/Decline → /api/odai/demo/approve, binding note printed); run bar for the 10-beat TEST demo. No CoT ever rendered.
- SECURITY mode (SHIELD): navy; hero labelled SIMULATION, threat→shield→blocked flow, six defence tiles (Monitor/Check/Filter/Contain/Recover/Audit), mono Real-Time Security Log (4s poll; populated by real governed-run decisions incl. the beat-7 NEVER), incident counter + heartbeat EKG with 'protection state — simulation only', explicit fineprint that no effectiveness % / certification claim is shown (9.0 governance).
- Verified: tsc strict clean; suite 11/11; bundle ships. Manual staging click-through of beats = demo step for owner (or next increment with browser automation).

## Increment 3 — database (this commit; V26)
- Page database provisioned (PolarDB/Supabase-compatible, per-page schema; state=ready). Migration odai/migrations/001_init.sql = 22 IF-NOT-EXISTS tables incl. all DB-spec entities (supplier→profit_snapshot) + odai_run/odai_trace/odai_receipt; applied via control API; anon CRUD granted by platform. App never runs DDL.
- server/odai/db.mjs: lazy dual-mode client (Broker v2 in prod / SUPABASE_* external view for local verify), safe diagnostics only (category/code/status/operation), availability probe cached. Browser sees no DB credentials; server-only path unchanged.
- workflow.mjs: ensureDb(t) shared by startRun AND views (cold-start reads DB without needing a prior write); best-effort mirror writes (run/receipts/trace/approval/order/handoff/ledger/profit) never block the demo; setRunState update (fixed objective-clobbering upsert); catalog seeds once per fresh DB (write-once per data-safety, then app-managed).
- Verified in sandbox against the REAL page DB: start→approve→restart→views still show source=database, receipts 10, trace 24, user 8/10 beats; memory fallback untouched for no-DB contexts (10/10 flow tests pass without vars too).
- Publishing with --with-database (broker contract auto).- **B1 partially unblocked (owner): 'invent Lumen Wellness' — done as declared synthetic stand-in.** odai/config/company_profile.json (is_synthetic=true, slot=the-good-doctor-organization, figures policy TEST). Surfaced: USER hello chip · MGMT mission bar · GET /api/odai/company · userView/managementView payload. New test: 11th assertion group (brand present + synthetic flag). Reverting to real TGDO = swap this one file + human review per import_rules (profile_review_required_before_real_publication). No real-endentity claims anywhere.
- **V29 owner typography rule**: all text on light surfaces = TRUE BLACK (--ink #000, secondaries #333-#374151); fixed V28 white-on-white USER-mode bubble bug (inherit override removed). Dark-approved screens keep near-white copy; whole-light-theme flip offered, pending owner. Contract screenshots remain reference for MGMT/SEC.
- **V30 (owner directive — final, 2026-11-20)**: USER mode is now a full LIGHT THEME with black text — `.app.usermode` gets a light mint→sage gradient background and the owner-supplied `USER PAGE: LIGHT THEME, BLACK TEXT` stylesheet block at the end of `src/styles.css` re-skins hello/chips/bizcards/todo list/bubbles/compose for light surfaces. MGMT (purple) and SHIELD (navy) screens unchanged; dark-surface copy stays near-white. Marker comment `LIGHT THEME, BLACK TEXT` in `src/styles.css` survives minification via the off-screen `content: "LIGHT THEME, BLACK TEXT"` rule on `.usermode::before` — that string in the served CSS asset is the deploy-verification hook.
- **V31 qwen4-max text composer (2026-11-20)**: USER-mode TalkView gained a bottom text bar ("Ask Qwen4-Max anything..." + round green send) that streams replies from **qwen4-max** through the page server — independent of the voice session (WebRTC untouched). `server/qwen4.mjs` `chatQ4(messages, env, onDelta)` mirrors the owner's MultiModalConversation sample (base `https://ws-1r19x1m4e2fa144f.ap-southeast-1.maas.aliyuncs.com/api/v1`; answer at `output.choices[0].message.content[0].text`): tries native multimodal-generation SSE (`X-DashScope-SSE: enable`, ws = `Q4_WORKSPACE_ID` else `WORKSPACE_ID`, body `{model, input:{messages}}`, handles cumulative or incremental frames), then OpenAI-compatible `compatible-mode/v1/chat/completions` (ws = `WORKSPACE_ID`, `{model, messages, stream:true}`); first OK streaming route is cached per process. `parseDelta` named export = concatenated text of native data: frames ("" on anything else). Route `POST /api/q4/chat` (before the generic method guard): key = DASHSCOPE_API_KEY env else url-encoded x-aivora-auth `key` field; no key → 503 JSON asking to add one; body {messages:[{role,content string}]} capped 64 KB, last 30 kept, system prompt "AIVORA's Qwen4-Max text brain…" prepended, string content → parts array [{text}]; replies as `data:{"delta":…}` lines + 4 s `: hb` comments, ends `data: [DONE]`; upstream failures emit one scrubbed `data:{"error":…}` frame (key never logged/echoed). Client keeps a rolling in-memory history (last 12 exchanges), tags the reply bubble "Qwen4-Max", ignores sends while streaming. `Q4_MODEL` env overrides the model name. Tests: `tests/q4.test.mjs` (parseDelta units; keyless 503; health 200) — suite now 16/16.

## V32 — Objective-to-Task Engine (D03 interpretation + durable task projection)

- `server/odai/objectives.mjs`: strict-reuse layer ON TOP of the 10-beat workflow — NEVER re-executes beats.
  interpret() → validated measurable criterion (units_sold / growth % over days), fixed 11-task D03 graph +
  3 owner gates projected from beat receipts; approve(scope) delegates spend to `wf.decideSpend` (D04 resume)
  and records publish/comms approvals as `approved_held_EXTERNAL_NEVER` (9.0 connector readiness: external
  writes stay DISABLED — the engine never publishes/spends/sends on its own). resume() re-projects without
  re-running; classify()/finalReport() answer completed/simulated/awaiting/failed/not-reached with honest
  durable note (in-memory graph authoritative per instance; row mirroring to odai_objective = V33 slot).
- Routes (odai router): `POST /api/odai/objectives`, `POST|GET /api/odai/objectives/{id}` (GET = resume),
  `POST /{id}/approve {scope,cap}`, `POST /{id}/resume`, `POST /{id}/report`. Existing 9.0 routes unchanged.
- DB: migration 002 applied via control API — `odai_objective`, `odai_gate_decision` tables exist (idempotent);
  app does not write them yet (honest note above). Demo transcript: `odai/docs/objective-engine-demo-V32.txt`.
- Tests: `tests/objectives.test.mjs` (6; memory path, no keys, boots server on :8309) added to `npm test`.
- Packaging honesty: the V32 tar arrived with a bad gzip CRC; deliverables were applied with the damage
  repaired (indent-space mangling, one route-segment destructuring fix, quantity regex widened so
  "100 Good Doctor wellness products" parses — verified by the shipped suite).

## V33 — objectives route wire-up verified (2026-11-20)

- Wiring is LIVE in `server.mjs`: the objectives import (line 21) plus the four routes (create / approve /
  resume / report + GET resume) are present and idempotent — `patchV33.py` reported `IMPORT PRESENT`,
  `ROUTES PRESENT`; `package.json` `test` script already runs `tests/objectives.test.mjs`. No anchor drift.
- `server/odai/objectives.mjs` re-supplied from the V33 package, then the same packaging damage was repaired
  (4 lines only, behaviour identical to the proven V32 module): `view` re-exported (server imports it),
  `classify()` maps `x.id` (tasks have no `task_id`), quantity regex widened again, and beat-receipt decision
  defaulted `(r.decision || "ALLOW")` because `workflow.receipt()` stores the default only on DB rows.
  Still a projection-driven scheduler over `workflow.mjs` — no second engine, no gate bypass.
- DB: migration 002 re-posted to the control API `database/migrate` (idempotent, `code: ok`); schema readback
  `code: ok`); schema readback confirms `odai_objective` + `odai_gate_decision` columns/PKs match the DDL.
  App still mirrors objective rows only best-effort — row writes remain the documented open slot.
- Verified: `npm test` 22/22 green (runtime + odai + q4 + objectives). Demo: `docs/objective-engine-demo-v33.txt`.

## V34 — USER-mode business-intent chips (2026-11-20) — SUPERSEDED by WO-10
> **WO-10 (2026-11-20) supersedes the entire V34 chip wall.** The ten intents no longer live as
> client prose (`BIZ_INTENTS`) or a `.exrow/.exchip` grid. They moved into the engine
> (`odai/config/intents_registry.json`, served by `GET /api/odai/intents` + scored by
> `POST /api/odai/intents/match`). USER idle keeps only hero + composer + big mic plus ONE subtle
> text affordance "What can you run for me?". The descriptions below are retained for history only.
- TalkView idle hero: EXAMPLES replaced by `BIZ_INTENTS` — ten [label, utterance] pairs (Start My Business → Protect My Business); tap sends the UTTERANCE via sayExample. Rendered as a compact 2-column grid, bold label + em dash + phrase (V34 block appended to `src/styles.css`, usermode + plain fallbacks).
- sayExample intercepts: dashboard test extended with track|spending|profit (Manage My Money → Today's Business bubble); new pre-check `protect.*(safe)|keep my (money|business).*safe` → SHIELD sys row (widened `.*` so the chip phrase "keep my money and business safe" actually triggers).
- No tryline element existed in the hero (CSS-only leftovers); no other behaviour touched.

- V34 note: ten business-intent chips shipped + verified live on clupxd6g.qwenwork.page (V36 deploy; bundle contains "Run My Business Automatically", "Find new customers" gone).

## WO-10 — intents to engine, minimal USER (2026-11-20, no publish)
- **`odai/config/intents_registry.json`** is the single source of truth for the ten owner-approved
  intents (Start My Business … Protect My Business): `{id,label,utterance,engine,objective_template|null}`
  plus INTERNAL `keywords` (scoring only; stripped from every server response). Engines: Manage My
  Money → `dashboard`, Protect My Business → `shield-note`, the other eight → `objective`. Every
  objective_template is a measurable framing and MUST pass D03 `interpret()` — enforced by
  `npm test` on every run (the shipped eight all pass; two growth-% templates, six units+FNYGlobal).
- **`server/odai/intents.mjs`** — structural token scoring only, zero intent prose in code:
  exact-utterance match scores 100; otherwise overlap of content-word tokens against the entry's
  label/utterance/keywords vocabulary (+2 per multi-word phrase hit); MIN_SCORE 2, so "hello" or
  "weather today" fall through unmatched. Read fresh from the registry file per call.
- **Routes** (`odaiRoute`): `GET /api/odai/intents` → `{tenant_id,intents}` (public fields only);
  `POST /api/odai/intents/match {utterance}` → `{launch:"match-only",intent,score}` with NO side
  effects; ONLY `?autocreate=true` AND engine `objective` calls `createObjective(template)` →
  `{launch:"autocreate",objective}`. The client never passes autocreate (WO-09 owner gate stays
  closed); even autocreated objectives halt at AWAITING_SPEND_APPROVAL like every other path.
- **src/TalkView.tsx** — `BIZ_INTENTS`, the ten-button grid and `sayExample` (regex intercepts)
  are GONE (zero `.exrow/.exchip` references remain in src, test-enforced; the CSS rules were
  deleted with the V30 `LIGHT THEME, BLACK TEXT` marker untouched). Idle = hero + ONE underlined
  text affordance "What can you run for me?" → asks the engine and renders the intents as a plain
  assistant chat bubble (text `<ul>`, no buttons). Typed (composer `askQ4`) and heard (voice
  "user" turns) utterances probe `/intents/match` first: `objective` → chat line "Ready to run:
  <label> — say the word in MGMT" and the Q4 call is skipped; `dashboard` → ready line + Today's
  Business card; `shield-note` → ready line + SHIELD note. Unmatched text streams from Qwen4-Max
  as before. V34's regex intercepts were replaced by this registry-driven flow.
- **Tests** (`tests/objectives.test.mjs`, 6 new — suite 37→43, all green): registry JSON validity +
  exact ten labels + engine/template rules; template pass via direct `interpret()` import; GET
  strips internal fields; 3 probe utterances expect find-customers/find-products/make-advertisements
  without side effects; autocreate gating (dashboard never spawns; objective spawn keeps gates
  closed); USER-bundle audit — built JS must NOT contain "Run My Business Automatically"/"Help me
  start earning", MUST contain "What can you run for me"; src grep zero exrow/exchip.
- Evidence (append-only blocks): `odai/dev_docs/recovery-verification.txt`.

## Standing Guardrails (DEV-12) — enforced by tools/guardrails_preflight.mjs
- G1 single-server/single-policy/single-dispatcher
- G2 diff-before-migrate
- G3 never replace src with compiled
- G4 lockfile-authoritative deps reconciliation
- G5 provenance JSON never imported
- WO-01 (2026-11-20): F-1 provenance audit of V36→V38 committed to odai/dev_docs/f1-provenance-report.md — verdict RUNTIME-CLEAN; V37/V38 carried zero runtime-file change, so the pilot should not have published them at all.
- WO-02 (2026-11-20): approve() now runs tools/guardrails_preflight.mjs (npm run precheck) before wf.decideSpend — non-zero exit blocks dispatch with GATE/PREFLIGHT_FAILED + PREFLIGHT_BLOCKED (additive only; 9.0 external-write NEVER unchanged); suite 24/24; published as V39 staging (deployment 305e4d13), /api/health + /api/odai/modes 200.
- WO-04 (2026-11-20): tools/release_evidence.mjs records dist sha256 manifest + HEAD OID + TAP summary into odai/dev_docs/evidence/<version>.json; V39 evidence captured (24/24 green); docs-only — no republish.
- WO-05 (2026-11-20, tranche B): tools/guardrail_harness.mjs + tests/guardrails-harness.test.mjs — deterministic enforcement drills (A duplicate policy evaluator, B provenance-import injection, C missing-tool fail-closed, D allowlist simulation freezing src/, index.html, package.json for security-class WOs, E self-modification refusal unless DEV-08-ordered-work-order, F runtime inertness); branch-local, zero runtime imports, wired into npm test; suite 32/32.
- WO-06 (2026-11-20, tranche B): tools/watchd.mjs + tests/watchd.test.mjs — DEV-13 AI-watching-AI daemon: SELECT-only reads of odai_trace/odai_receipt via the page database control API (token via curl config, never argv/logs), redacted view (kind/beat/actor/decision/rule/note≤120), five detectors, incidents are containment REQUESTS only (odai/dev_docs/watch/incidents/) — self-approval rejection encoded + tested; live sample: 7 DISPATCH_NON_ALLOW signals (governed TEST decisions), 0 hard signals; suite 37/37.
- WO-07 (2026-11-20, tranche B): full-source tar + git bundle + sha256 manifest stored OUTSIDE the repo; secret audit zero hits; isolated restore drill PASS (HEAD match, manifest check, node --check, preflight); artifacts delivered via Drive share links in odai/dev_docs/wo07-backup-report.md; NO publish, NO production touch.
- WO-08 (2026-11-20, tranche B recovery verification): verdict **WO-08 VERIFIED** — recorded only in `odai/dev_docs/recovery-verification.txt` (single rolling evidence log). WO-07 outputs + the tranche STEP-0 four-gate PASS confirmed from that run; refreshed authoritative material for HEAD `bead5b6c` (tar 443,420 B / 62 files == `git ls-files`; bundle 524,078 B, complete history; sha256 manifest); isolated drill in /tmp replayed identical HEAD + byte-identical tracked tree and passed `node --check`, preflight, `npm ci`, build, `npm test` 37/37 OFF the live repo; rollback confirmed available via one Publish call against sealed immutable Artifacts (ledger V1..V39, online V39 `060d225b`; rollback targets V38 `e076db65`, V37 `c777a2b8`, V36 `9b828eae`). NO publish, NO rollback executed.

## WO-09A — pre-exec authorization leases + integrity watchdog (2026-11-20, no publish)

- **`tools/authz.mjs`** — deterministic authorization BEFORE an action, not after. `issue <WO-ID>
  --paths <csv> --minutes N [--ops check,commit] [--budget 12] [--single-use]` · `touch <WO-ID>` ·
  `check <WO-ID> --op <op> [--path <p>]` · `revoke <WO-ID> <why>` · `status`. Store
  `odai/dev_docs/leases.json` `{id:{issued_at,expires_at,minutes,paths,ops,budget,single_use,used_by_op,revoked}}`.
  EVERY protected action must call `check` first; a denial exits **2** with one machine reason —
  `EXPIRED | REVOKED | OVER_BUDGET (op count > budget, default 12) | PATH_NOT_ALLOWED | OP_NOT_ALLOWED |
  CONSUMED_RESUME (single-use lease already spent) | HALTED (`odai/dev_docs/HALT` present) | NO_LEASE |
  INTEGRITY_FAILED`. Grants are recorded in the lease's `used_by_op`, never in the audit log.
  `publish` is grantable only while `ODAI_OWNER_TOKEN` is present in the environment (presence only, value
  never read/logged/stored) — tokenless, publish cannot be issued and can never pass check. Re-issue after
  revoke is the only resume path; there is no resume without authorization.
- **Halt sentinel**: `odai/dev_docs/HALT` (file existence = the same guard pattern as the dispatch
  sentinel). While present, every `issue`/`check`/`touch` is denied `HALTED`; `status` (read) and `revoke`
  (emergency close) stay available.
- **Audit log**: `odai/dev_docs/authz-ledger.txt`, append-only, one pipe-delimited line per
  `ISSUE` / `DENY` / `REVOKE` — the single live evidence log now.
- **`tools/verify_integrity.mjs`** — watchdog over the six security files
  (`tools/authz.mjs`, `tools/verify_integrity.mjs`, `tools/guardrails_preflight.mjs`,
  `tools/guardrail_harness.mjs`, `tests/authz.test.mjs`, and its own seal `tools/SECURITY-FILES.sha256`).
  `seal` writes the sha256 list; `check` exits **1** on ANY mismatch, missing/unreadable protected file,
  stale/unparsable row, or **missing seal** — fail-closed, never "no news". `authz check` runs the watchdog
  before granting and before consuming budget, so a disabled watchdog ⇒ `NO-GRANT`. Convention (watchman
  audits externally, WO-06 harness/`watchd` wiring): these six files are never edited without an owner token.
- **Wiring**: `npm run authz`, `npm run integrity` (check), `npm run integrity:seal`; `tests/authz.test.mjs`
  (12 proofs = the six failure scenarios + halt/hygiene/decision-table/seal/inertness) joins the `npm test`
  chain; `SELF_FILES` in `tools/guardrail_harness.mjs` now also covers `tools/authz.mjs` +
  `tools/verify_integrity.mjs`. Runtime surfaces (`src/`, `server.mjs`, `server/`) untouched — no architecture
  redesign; suite 55/55 green (43 baseline + 12 WO-09A).
