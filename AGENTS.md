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
