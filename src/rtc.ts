/* AIVORA WebRTC realtime engine — browser ⇄ Model Studio media, server proxies only the SDP.
 * Sequence per https://help.aliyun.com/en/model-studio/omni-realtime-webrtc-access:
 * offer (audio transceiver + "oai-events" channel) → POST /api/webrtc/sdp (key injected
 * server-side) → answer → connected → session.created → session.update → session.updated
 * → attach mic track. Text events on the DataChannel; audio over media tracks.
 */
import { loadConfig, type LiveEvent } from "./lib";

const AIVORA_INSTRUCTIONS =
  "You are AIVORA, an objective-driven business partner on a live voice call. The user may speak " +
  "Hokkien (Southern Min), Cantonese, Mandarin or English; detect automatically. Keep answers SHORT " +
  "and conversational (this is voice). Routing rules: (1) when a measurable business objective is " +
  "stated, call log_call with details and a one-line summary; (2) when the user asks you to " +
  "interpret or translate live speech for them or another person, call start_interpreter with the " +
  "target language (ask by voice first if unclear; default en); (3) when the user wants a document, " +
  "photo or written text translated, call open_document_translator. Reply in the language the user used.";

const ROUTING_TOOLS = [
  { type: "function", function: {
    name: "log_call",
    description: "Summarize/objective captured from this business call.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        growth_pct: { type: "number" },
        horizon_days: { type: "number" },
        language: { type: "string" },
        action_items: { type: "array", items: { type: "string" } },
      },
    },
  } },
  { type: "function", function: {
    name: "start_interpreter",
    description: "Start live speech-to-speech interpretation. Use when asked to interpret a conversation or another speaker.",
    parameters: {
      type: "object",
      properties: { target_language: { type: "string", description: "ISO code: en, zh, yue, ms, th, id, ta" } },
      required: ["target_language"],
    },
  } },
  { type: "function", function: {
    name: "open_document_translator",
    description: "Open the document/photo/text translation screen. Use when the user wants a written document, photo or file translated (not live speech).",
    parameters: { type: "object", properties: {} },
  } },
];

function sessionUpdate(mode: string, target: string) {
  if (mode === "translate")
    // 3.8 livetranslate over WebRTC: media format comes from the track; only the
    // translation semantic fields travel on the event channel.
    return { modalities: ["text", "audio"], voice: "Tina",
      output_modalities: ["text", "audio"],
      turn_detection: { type: "server_vad" },
      translation: { language: target } };
  return { modalities: ["text", "audio"], voice: "Tina", instructions: AIVORA_INSTRUCTIONS,
    turn_detection: { type: "semantic_vad", silence_duration_ms: 800 },
    tools: ROUTING_TOOLS };
}

export type RtcHandle = { stop(): void; setMuted(v: boolean): void };

export function openRealtimeRtc(
  mode: "omni" | "translate", target: string, onEvent: (e: LiveEvent) => void,
): RtcHandle {
  let dead = false, sessionCreated = false, updateSent = false, modelReady = false;
  let eventChannel: RTCDataChannel | null = null;
  let local: MediaStream | null = null;
  const audioSender = { current: null as RTCRtpSender | null };
  const emit = (e: LiveEvent) => { if (!dead) onEvent(e); };
  const remoteEl = document.createElement("audio");
  remoteEl.autoplay = true;
  const remoteStream = new MediaStream();

  const pc = new RTCPeerConnection({ iceServers: [] });
  const ctl = new AbortController();

  const tr = pc.addTransceiver("audio", { direction: "sendrecv" });
  audioSender.current = tr.sender;

  const bind = (ch: RTCDataChannel) => {
    ch.onopen = () => tryInit();
    ch.onmessage = ({ data }) => parse(JSON.parse(data as string), ch);
    ch.onerror = () => emit({ kind: "error", msg: "event channel error" });
  };
  const clientCh = pc.createDataChannel("oai-events");
  bind(clientCh);
  pc.ondatachannel = ({ channel }) => bind(channel); // server may push events on "txt"

  pc.ontrack = ({ track }) => {
    if (track.kind === "audio") {
      remoteStream.addTrack(track);
      remoteEl.srcObject = remoteStream;
      remoteEl.play().catch(() => emit({ kind: "error", msg: "🔇 tap the screen to enable audio playback" }));
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") tryInit();
    else if (["failed", "disconnected", "closed"].includes(pc.connectionState) && !dead) {
      emit({ kind: "closed" }); markDead();
    }
  };

  function parse(ev: Record<string, unknown> & { type: string; transcript?: string; delta?: string; error?: { message?: string }; name?: string; arguments?: string }, ch: RTCDataChannel) {
    switch (ev.type) {
      case "session.created": sessionCreated = true; eventChannel = ch; tryInit(); break;
      case "session.updated": if (updateSent) { modelReady = true; void attachTrack(); emit({ kind: "ready" }); } break;
      case "conversation.item.input_audio_transcription.completed": emit({ kind: "user", text: ev.transcript ?? "" }); break;
      case "response.audio_transcript.done":
        emit(mode === "translate" ? { kind: "translated", text: ev.transcript ?? "" } : { kind: "reply", text: ev.transcript ?? "" }); break;
      case "response.text.delta": if (mode === "translate") emit({ kind: "translated", text: ev.delta ?? "" }); break;
      case "response.function_call_arguments.done":
        if (ev.name === "log_call") { try { emit({ kind: "objective", data: JSON.parse(ev.arguments || "{}") }); } catch { /* bad json */ } }
        else if (ev.name === "start_interpreter") { try { emit({ kind: "interpret", target: (JSON.parse(ev.arguments || "{}").target_language) || "en" }); } catch { emit({ kind: "interpret", target: "en" }); } }
        else if (ev.name === "open_document_translator") emit({ kind: "route_docs" });
        break;
      case "error": {
        const m = ev.error?.message ?? "realtime error";
        // one-shot graceful degrade: 3.8 semantic_vad rejected → retry with server_vad
        if (/turn_detection|semantic/i.test(m) && mode === "omni" && !updateSent) { /* leave as error, user retries */ }
        emit({ kind: "error", msg: m }); break;
      }
    }
  }

  function tryInit() {
    if (dead || updateSent || !sessionCreated || pc.connectionState !== "connected" || eventChannel?.readyState !== "open") return;
    eventChannel.send(JSON.stringify({
      event_id: `event_${crypto.randomUUID()}`, type: "session.update",
      session: sessionUpdate(mode, target),
    }));
    updateSent = true;
  }

  async function attachTrack() {
    if (!local) return;
    for (const t of local.getAudioTracks()) await audioSender.current?.replaceTrack(t);
  }

  async function connect() {
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch { emit({ kind: "error", msg: "Microphone permission denied" }); markDead(); return; }
    if (dead) return;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("ICE gathering timed out — network may block WebRTC")), 15000);
      const chk = () => pc.iceGatheringState === "complete" && (clearTimeout(t), res());
      ctl.signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("ended")); }, { once: true });
      pc.addEventListener("icegatheringstatechange", chk);
      chk();
    });
    if (dead) return;
    const c = loadConfig();
    const res = await fetch(`/api/webrtc/sdp?model=${mode === "translate" ? "qwen3.8-livetranslate-flash-realtime" : "qwen3.8-omni-flash-realtime"}`, {
      method: "POST",
      headers: { "content-type": "application/sdp", ...(c ? { "x-aivora-auth": encodeURIComponent(JSON.stringify(c)) } : {}) },
      body: pc.localDescription!.sdp,
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error((await res.text()).slice(0, 160) || `SDP exchange failed ${res.status}`);
    const answer = (await res.text()).trim().replace(/\r?\n/g, "\r\n") + "\r\n";
    if (dead) return;
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  function markDead() {
    dead = true;
    ctl.abort();
    local?.getTracks().forEach((t) => t.stop());
    try { pc.close(); } catch { /* noop */ }
    remoteEl.pause(); remoteEl.srcObject = null;
  }

  connect().catch((e) => { if (!dead) { emit({ kind: "error", msg: e instanceof Error ? e.message : String(e) }); markDead(); } });

  return {
    stop() {
      if (dead) return;
      try { eventChannel?.readyState === "open" && eventChannel.send(JSON.stringify({ type: mode === "translate" ? "session.finish" : "response.cancel" })); } catch { /* noop */ }
      markDead();
      emit({ kind: "closed" });
    },
    setMuted(v: boolean) { local?.getAudioTracks().forEach((t) => (t.enabled = !v)); },
  };
}
