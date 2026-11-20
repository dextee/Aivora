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
