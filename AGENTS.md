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

## Product shape

- **Page category: dynamic** (session Page app-1fe44043-4ed153f9; the previous
  static page was deleted by the owner and this session slot was reused).
- **Client** (src/, Vite+React+TS strict):
  - `App.tsx` shell — top bar (back/logo per view), left slide-in **Menu
    drawer** (services/settings/about + connection state), view router;
    header subtitle always shows key state: "connected via server",
    "browser key ✓", or "demo mode".
  - `Chats.tsx` — WhatsApp-style chat list; each service is a conversation.
  - `CallView.tsx` — Live Call: openRealtime("omni"), transcript bubbles,
    call timer/mute/end, **CALL LOG card rendered from the model's
    `log_call` function call** (summary, +growth%, horizon, action items).
    With no key: scripted demo call.
  - `TranslateView.tsx` — interpreter: from/to chips (Cantonese/Hokkien/
    Mandarin/English/Malay…), hold-to-talk, streaming source→target bubbles.
    Model: livetranslate session shape (`translation.language`,
    speaker_detection). Scripted demo fallback.
  - `DocsView.tsx` — mode switch Text | Photo (camera capture, data-URL) |
    Voice note (MediaRecorder → downmixed 16 kHz mono **WAV** client-side,
    because omni-flash rejects webm); POST /api/analyze streams SSE into a
    typed result; voice notes render TRANSCRIPTION + TRANSLATION sections.
  - `SettingsSheet.tsx` — 🔐 browser-key fallback (localStorage only, format
    hint sk-…, masked) and server-mode confirmation notice; `lib.ts` holds
    config, probeKey(), the shared realtime engine (AudioWorklet 16k capture,
    24k playback queue, mute, graceful session.stop) and analyzeStream.
- **Server** (`server.mjs`, extends the scaffold's static/health server):
  `/realtime?mode=omni|translate` WS relay with key precedence
  (DASHSCOPE_API_KEY env → open instantly; else first `__auth` frame from the
  client, per-socket only, never logged; else 10 s error), `/api/analyze`
  proxy (also accepts optional x-aivora-auth browser key), `/api/keyinfo`
  one-bit status. Session payloads verified against Nov 2026 docs;
  livetranslate is 10 RPM → one long-lived socket per session + pings.
- **Secrets/env:** Page env vars `DASHSCOPE_API_KEY`, `WORKSPACE_ID`
  (default ws-lj7gmtttiltwjlyv), `QWEN_REGION` (default ap-southeast-1).
  Import-time reads forbidden; errors happen per-route only.
- **Assets:** public/logo.png = owner's AIVORA ODAI 6.0 logo (compressed
  from 2.4 MB to ~300 K, 512 px) + favicon.png; palette teal #075e54 /
  #25d366 on #efeae2 paper; Manrope + Space Grotesk; fonts from Google.

## Constraints / decisions (summary)

- WhatsApp look per owner; drawer menu per owner; 520 px max width keeps it
  webapp-like on desktop.
- Demo fallbacks everywhere so a published page is never dead without a key.
- Model names may change per snapshot — server keeps them in one MODELS map.
- `npm run typecheck && npm test` must pass before publish; test boots the
  staged bundle (health check) — never bypass the publisher gate.
