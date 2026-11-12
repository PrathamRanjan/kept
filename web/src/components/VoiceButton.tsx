import { useRef, useState } from "react";
import { Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/i18n";

/**
 * Spec A7: push-to-talk on the main text boxes. Press to start, press again to stop. The browser opens a
 * gpt-live-1 realtime session over WebRTC with a two-minute secret from Kept's server, streams the microphone, and
 * shows the words as they are heard; on stop the final words go into the box. Typing always works. Nothing is
 * sent anywhere until the person presses the button and allows the microphone.
 */
interface Session { secret: string; callsUrl: string; model: string; transcribe: string }
type State = "idle" | "connecting" | "listening" | "finishing";

export function VoiceButton({ onText, memberRef, label }: { onText: (t: string) => void; memberRef?: string; label?: string }) {
  const { t } = useT();
  label ??= t("v.speak");
  const [state, setState] = useState<State>("idle");
  const [live, setLive] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const dc = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const text = useRef("");

  const stopAll = () => {
    mic.current?.getTracks().forEach((t) => t.stop());
    dc.current?.close();
    pc.current?.close();
    pc.current = dc.current = mic.current = null;
  };

  async function start() {
    setNote(null);
    setLive("");
    text.current = "";
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") return setNote(t("v.cant"));
    if (!navigator.onLine) return setNote(t("v.offline"));
    setState("connecting");
    try {
      const s = await api.post<Session>("/ui/voice/session", memberRef ? { ref: memberRef } : {});
      mic.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      const peer = new RTCPeerConnection();
      pc.current = peer;
      mic.current.getTracks().forEach((t) => peer.addTrack(t, mic.current!));
      const ch = peer.createDataChannel("oai-events");
      dc.current = ch;
      ch.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === "conversation.item.input_audio_transcription.delta") setLive((x) => x + (ev.delta ?? ""));
        if (ev.type === "conversation.item.input_audio_transcription.completed") {
          text.current = String(ev.transcript ?? "").trim();
          if (text.current) onText(text.current);
          setLive(text.current);
          setNote(text.current ? t("v.heard", { model: s.model, tx: s.transcribe }) : t("v.nothing"));
          setState("idle");
          stopAll();
        }
        if (ev.type === "error") {
          setNote(`Voice stopped: ${ev.error?.message ?? "an error"}. Typing works as usual.`);
          setState("idle");
          stopAll();
        }
      };
      ch.onopen = () => {
        ch.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        setState("listening");
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const r = await fetch(s.callsUrl, { method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${s.secret}`, "content-type": "application/sdp" } });
      if (!r.ok) throw new Error(`the voice service said ${r.status}`);
      await peer.setRemoteDescription({ type: "answer", sdp: await r.text() });
    } catch (e) {
      stopAll();
      setState("idle");
      setNote(e instanceof ApiError ? e.message : (e as Error).name === "NotAllowedError" ? t("v.denied") : `Voice isn't working here (${(e as Error).message}). Typing works as usual.`);
    }
  }

  function stop() {
    if (!dc.current || dc.current.readyState !== "open") {
      stopAll();
      return setState("idle");
    }
    setState("finishing");
    dc.current.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    // If no words come back in 15 seconds, give up politely.
    setTimeout(() => {
      if (pc.current) {
        stopAll();
        setState("idle");
        setNote(t("v.none"));
      }
    }, 15_000);
  }

  const on = state === "listening" || state === "finishing";
  return (
    <span className="inline-flex flex-col">
      <Button type="button" variant={on ? "default" : "outline"} size="icon" className="size-11" aria-pressed={on} aria-label={on ? t("v.stop") : label} title={on ? t("v.stopShort") : label} disabled={state === "connecting" || state === "finishing"} onClick={() => (on ? stop() : start())}>
        {on ? <Square aria-hidden="true" /> : <Mic aria-hidden="true" />}
      </Button>
      <span className="sr-only" aria-live="polite">{state === "listening" ? t("v.listening") : state === "connecting" ? t("v.starting") : ""}</span>
      {(live || note) && <span className="mt-1 max-w-[18rem] text-xs text-ink-2" aria-live="polite">{state === "listening" && live ? t("v.hearing", { t: live }) : note}</span>}
    </span>
  );
}
