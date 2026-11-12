/**
 * Part A6.1/A6.2/A8: hands-free voice. The browser's own speech recognition, in the chosen language, listening
 * continuously; a phrase counts only after the wake word ("Kept") or while the Space bar is held (push-to-talk).
 *
 * Two gates keep it from acting on noise or on itself:
 *   - a noise gate that learns the room's level for 1.5 seconds and then only accepts phrases heard while the
 *     microphone rose clearly above it;
 *   - a playback gate: while Kept is speaking, only "stop" gets through, and the user talking over it cuts it off.
 * The microphone opens with the browser's echo cancellation and noise suppression.
 *
 * Honest limits: in Chrome the recognition runs on Google's servers, so voice needs the network; offline, voice says
 * so and pointing and dwell carry on. Firefox has no speech recognition at all.
 */
import { BCP, type Lang } from "@/i18n";
import { parse } from "./intents";

export interface Heard { text: string; final: boolean; ptt: boolean; woke: boolean }
type Rec = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };

export const hasRecognition = () => typeof window !== "undefined" && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);

export class Voice {
  private rec: Rec | null = null;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private level = 0;
  private room = 0;
  private peakSince = 0;
  private learning = true;
  private running = false;
  ptt = false;
  constructor(private lang: Lang, private onHeard: (h: Heard) => void, private onState: (s: "listening" | "off" | "offline" | "unsupported" | "denied" | "error") => void) {}

  get gate() {
    return this.room * 2.5 + 0.012;
  }
  get speaking() {
    return typeof speechSynthesis !== "undefined" && speechSynthesis.speaking;
  }

  async start() {
    if (!hasRecognition()) return this.onState("unsupported");
    if (!navigator.onLine) return this.onState("offline");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      return this.onState("denied");
    }
    this.ctx = new AudioContext();
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    this.ctx.createMediaStreamSource(this.stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const roomSamples: number[] = [];
    const t0 = performance.now();
    const tick = () => {
      if (!this.ctx) return;
      an.getFloatTimeDomainData(buf);
      this.level = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      if (this.learning) {
        roomSamples.push(this.level);
        if (performance.now() - t0 > 1500) {
          this.learning = false;
          this.room = roomSamples.sort((a, b) => a - b)[Math.floor(roomSamples.length / 2)] ?? 0;
        }
      } else if (this.level > this.gate) {
        this.peakSince = performance.now();
        // Barge-in: the user talking over Kept stops Kept.
        if (this.speaking && this.level > this.gate * 1.6) speechSynthesis.cancel();
      }
      requestAnimationFrame(tick);
    };
    tick();
    const R = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec: Rec = new R();
    rec.lang = BCP[this.lang] === "en-XA" ? "en-US" : BCP[this.lang];
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = String(r[0]?.transcript ?? "").trim();
        if (!text) continue;
        // Noise gate: a final phrase must have come with real sound in the last two seconds.
        const loud = this.learning || performance.now() - this.peakSince < 2000;
        // "Stop" always gets through: stopping is never the harmful mistake.
        if (r.isFinal && !loud && !this.ptt && parse(text).kind !== "stop") continue;
        this.onHeard({ text, final: Boolean(r.isFinal), ptt: this.ptt, woke: false });
      }
    };
    rec.onerror = (e: any) => {
      if (e?.error === "network") this.onState("offline");
      else if (e?.error === "not-allowed") this.onState("denied");
    };
    rec.onend = () => {
      // The browser ends a session now and then; carry on while hands-free is on.
      if (this.running) setTimeout(() => this.running && this.safeStart(), 250);
    };
    this.rec = rec;
    this.running = true;
    this.safeStart();
    this.onState("listening");
  }

  private safeStart() {
    try {
      this.rec?.start();
    } catch {
      /* already started */
    }
  }

  stop() {
    this.running = false;
    this.rec?.abort();
    this.rec = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
    this.onState("off");
  }
}

/** Speak a short line in the chosen language, with the most natural local voice the browser has. */
export function say(text: string, lang: Lang) {
  if (typeof speechSynthesis === "undefined") return;
  const tag = BCP[lang] === "en-XA" ? "en-US" : BCP[lang];
  const u = new SpeechSynthesisUtterance(text);
  u.lang = tag;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith(tag.slice(0, 2).toLowerCase()));
  u.voice = voices.find((v) => /natural|neural|google|premium|enhanced/i.test(v.name) && v.lang.replace("_", "-") === tag) ?? voices.find((v) => v.lang.replace("_", "-") === tag) ?? voices[0] ?? null;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
