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
- BLOCKERS: (B1) The Good Doctor Organization profile absent from pack — awaiting owner data; Lumen Studio used only as declared synthetic demo. (B2) X03-X12 ruleset absent. (B3) TGDO/HASHMETA/FNY credentials — connectors stay UNVERIFIED/OFF. (B4) UI rebuild to three approved screenshots = increment 2; (B5) database attach + migrations + seeds = increment 3; live call inside beat1 requires the owner Model Studio key on Page env.
- Existing functionality preserved: voice/interpreter/docs/store-builder routes + tests untouched and green.