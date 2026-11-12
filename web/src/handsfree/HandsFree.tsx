/**
 * Part A: hands-free control by head, eyes and voice ("Look and Say"), Kept's own copy of the cross-app module.
 *
 * What is enforced in code, never by a model: which control is outlined (snap.ts), when a dwell or wink clicks,
 * "stop" in every language, reading a control's state before pressing it, the 10-step cap on a spoken request, and
 * the confirm card. Anything that pays, refunds, cancels, deletes, sends, approves or disputes opens the card, and
 * only a spoken or clicked "yes" goes ahead; anything else cancels.
 *
 * What a model does: nothing here. Free spoken requests go to the member's assistant on the page, which acts
 * through the shop's MCP tools under a signed mandate, exactly as if they had been typed.
 */
import { createPortal } from "react-dom";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Bug, ScanEye, Video, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useT, type Lang, type T } from "@/i18n";
import { CHECK, EYES, HEAD, NINE, POOR_EYES_PX, TOPUP, accuracyPx, fitWithCv, headShifted, medianVec, predict, type Fit, type Sample } from "./calib";
import { DESTRUCTIVE, MAX_STEPS, freeNeedsConfirm, parse, stepsIn, stripWake } from "./intents";
import { OneEuro, Snapper, jitterOf, type Pt, type Target } from "./snap";
import type { Frame } from "./tracker";
import { Voice, hasRecognition, say } from "./voice";

/* ---------------- settings and shared state ---------------- */
type Mode = "head" | "eyes";
type ClickBy = "dwell" | "say" | "wink";
interface Settings { mode: Mode; click: ClickBy; voice: boolean; dwellMs: number }
interface Saved { eyes: Fit | null; head: Fit | null; eyesPx: number | null; headPx: number | null; n: number; ref: { x: number; y: number; size: number }; w: number; h: number; at: string; samples: Sample[] }
interface Confirm { what: string; amount: string | null; to: string | null }
interface State {
  on: boolean;
  panel: boolean;
  camera: "off" | "loading" | "on" | "none" | "denied" | "failed";
  voice: "off" | "listening" | "offline" | "unsupported" | "denied" | "error";
  status: string;
  heard: string;
  debug: { why: string; n: number }[];
  confirm: Confirm | null;
  calibrating: { dots: { x: number; y: number }[]; i: number; kind: "full" | "topup" } | null;
  shifted: boolean;
  settings: Settings;
  saved: Saved | null;
}
const SKEY = "kept-hf";
const CKEY = "kept-hf-cal";
const load = <V,>(k: string, d: V): V => {
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(k) ?? "null") ?? {}) };
  } catch {
    return d;
  }
};
const loadSaved = (): Saved | null => {
  try {
    return JSON.parse(localStorage.getItem(CKEY) ?? "null");
  } catch {
    return null;
  }
};
let state: State = { on: false, panel: false, camera: "off", voice: "off", status: "", heard: "", debug: [], confirm: null, calibrating: null, shifted: false, settings: load<Settings>(SKEY, { mode: "head", click: "dwell", voice: false, dwellMs: 900 }), saved: typeof window === "undefined" ? null : loadSaved() };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  if (p.settings) {
    try {
      localStorage.setItem(SKEY, JSON.stringify(p.settings));
    } catch { /* storage blocked */ }
  }
  subs.forEach((f) => f());
};
const useHF = () => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => state, () => state);
export const handsFree = { get: () => state, set };

/* ---------------- what can be pointed at ---------------- */
const SEL = 'a[href], button, [role="button"], input:not([type="hidden"]), select, textarea, summary, [data-hf-target]';
const ids = new WeakMap<Element, string>();
let nextId = 1;
const idOf = (el: Element) => ids.get(el) ?? (ids.set(el, `t${nextId++}`), ids.get(el)!);
function collect(): { targets: Target[]; byId: Map<string, HTMLElement> } {
  const byId = new Map<string, HTMLElement>();
  const targets: Target[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(SEL)) {
    if (el.closest("[data-hf-ui]") && !el.closest("[data-hf-pointable]")) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
    if (getComputedStyle(el).visibility === "hidden") continue;
    const id = idOf(el);
    byId.set(id, el);
    targets.push({ id, rect: { x: r.left, y: r.top, w: r.width, h: r.height } });
  }
  return { targets, byId };
}
export function nameOf(el: HTMLElement): string {
  const lab = (el as HTMLInputElement).labels?.[0]?.textContent;
  return (el.getAttribute("aria-label") || lab || el.textContent || el.getAttribute("title") || (el as HTMLInputElement).value || el.getAttribute("placeholder") || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Read the control before pressing it (A6.8). Returns why it must not be pressed, or null. */
export function refuseReason(el: HTMLElement, t: T): string | null {
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return t("hf.disabledBtn");
  if (el.getAttribute("aria-selected") === "true" || (el.getAttribute("aria-pressed") === "true" && el.dataset.hfToggle !== "true") || ((el as HTMLInputElement).type === "radio" && (el as HTMLInputElement).checked)) return t("hf.selected");
  return null;
}
export const needsConfirm = (el: HTMLElement) => !el.closest("[data-hf-safe]") && (el.dataset.hfConfirm === "true" || DESTRUCTIVE.test(nameOf(el)));
const isPayPal = (el: HTMLElement) => el.hasAttribute("data-paypal-handoff") || /paypal\.com/.test((el as HTMLAnchorElement).href ?? "");

/* ---------------- the engine (one instance, page-wide) ---------------- */
let confirmResolve: ((ok: boolean) => void) | null = null;
function askConfirm(c: Confirm): Promise<boolean> {
  confirmResolve?.(false);
  set({ confirm: c });
  return new Promise((res) => (confirmResolve = (ok) => {
    confirmResolve = null;
    set({ confirm: null });
    res(ok);
  }));
}
function confirmFor(el: HTMLElement, t: T, verbName?: string): Confirm {
  const shop = document.querySelector("main p.text-ink-2, main p")?.textContent?.trim().slice(0, 60) ?? null;
  return { what: verbName ?? (el.dataset.hfWhat || nameOf(el)), amount: el.dataset.hfAmount ?? null, to: el.dataset.hfTo ?? shop ?? t("hf.what") };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, v: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function HandsFreeRoot() {
  const s = useHF();
  const { lang, t } = useT();
  const video = useRef<HTMLVideoElement>(null);
  const ring = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLDivElement>(null);
  const eng = useRef({ snap: new Snapper(), fx: new OneEuro(0.8, 0.015), fy: new OneEuro(0.8, 0.015), pts: [] as Pt[], raw: null as Pt | null, current: null as string | null, since: 0, clickedAt: 0, frozenUntil: 0, lastFace: 0, mouseAt: 0, wink: 0, neutral: null as number[] | null, shiftSince: 0, awaySince: 0, targets: collect.bind(null), cache: { at: 0, v: { targets: [] as Target[], byId: new Map<string, HTMLElement>() } }, lastFrame: null as Frame | null, collecting: [] as number[][] });
  const stream = useRef<MediaStream | null>(null);
  const voice = useRef<Voice | null>(null);
  const raf = useRef(0);
  const tracker = useRef<typeof import("./tracker") | null>(null);

  const why = useCallback((w: string) => {
    const d = state.debug;
    const top = d[0];
    set({ debug: top && top.why === w ? [{ why: w, n: top.n + 1 }, ...d.slice(1)] : [{ why: w, n: 1 }, ...d].slice(0, 8) });
  }, []);
  const tell = useCallback((msg: string, speak = true) => {
    set({ status: msg });
    if (speak && state.settings.voice) say(msg, lang);
  }, [lang]);

  const stopAll = useCallback((msgKey: "hf.stopped" | "hf.away" = "hf.stopped") => {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((x) => x.stop());
    stream.current = null;
    voice.current?.stop();
    voice.current = null;
    confirmResolve?.(false);
    document.documentElement.removeAttribute("data-hf");
    set({ on: false, camera: "off", voice: "off", calibrating: null, status: t(msgKey) });
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, [t]);

  /** Press a control the hands-free way: read its state, hand over to PayPal, confirm destructive ones. */
  const activate = useCallback(async (el: HTMLElement, forceConfirm?: string) => {
    const no = refuseReason(el, t);
    if (no) return tell(no);
    if (forceConfirm || needsConfirm(el)) {
      const ok = await askConfirm(confirmFor(el, t, forceConfirm));
      if (!ok) return tell(t("hf.notDone"));
    }
    if (isPayPal(el)) tell(t("hf.paypal"));
    const r = el.getBoundingClientRect();
    if (eng.current.raw) eng.current.snap.confirmClick(eng.current.raw, { x: r.left, y: r.top, w: r.width, h: r.height });
    eng.current.clickedAt = performance.now();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.focus();
    else el.click();
  }, [t, tell]);

  /** What "this one" means: the outlined control; with no camera running (voice only), the control focused with Tab. */
  const currentEl = (): HTMLElement | null => {
    const looked = eng.current.current ? eng.current.cache.v.byId.get(eng.current.current) ?? null : null;
    if (looked || state.camera === "on") return looked;
    const f = document.activeElement as HTMLElement | null;
    return f && f !== document.body && f.matches(SEL) && !f.closest("[data-hf-ui]") ? f : null;
  };

  /* ----- voice ----- */
  const onHeard = useCallback(async (h: { text: string; final: boolean; ptt: boolean }) => {
    if (!h.final) return set({ heard: h.text });
    const confirming = Boolean(state.confirm);
    const { woke, rest } = stripWake(h.text);
    const intent0 = parse(woke ? rest : h.text, confirming);
    // "Stop" always works, wake word or not; while Kept is talking, nothing else gets through (playback gate).
    if (intent0.kind === "stop") return stopAll();
    if (typeof speechSynthesis !== "undefined" && speechSynthesis.speaking) return why("voice: ignored while Kept was speaking");
    if (confirming) return confirmResolve?.(intent0.kind === "yes");
    if (!woke && !h.ptt) return why("voice: no wake word and Space not held");
    set({ heard: rest });
    tell(t("hf.heard", { t: rest }), false);
    const intent = intent0;
    const el = currentEl();
    switch (intent.kind) {
      case "click":
        return el ? activate(el) : tell(t("hf.nothingLooked"));
      case "act":
        return el ? activate(el, `${intent.verb}: ${nameOf(el)}`) : tell(t("hf.nothingLooked"));
      case "scroll":
        return scrollBy({ top: (intent.dir === "down" ? 1 : -1) * innerHeight * 0.7, behavior: "smooth" });
      case "back":
        return history.back();
      case "calibrate":
        return startCalibration("full");
      case "topup":
        return startCalibration("topup");
      case "recentre":
        eng.current.neutral = null;
        return;
      case "free": {
        if (stepsIn(intent.text) > MAX_STEPS) return tell(t("hf.tooMany"));
        const box = document.querySelector<HTMLInputElement>("#assistant-msg");
        if (!box?.form) return tell(t("hf.unknown"));
        if (freeNeedsConfirm(intent.text)) {
          const ok = await askConfirm({ what: `“${intent.text}”`, amount: null, to: t("a.yours") });
          if (!ok) return tell(t("hf.notDone"));
        }
        setNativeValue(box, intent.text);
        setTimeout(() => box.form?.requestSubmit(), 50);
        return;
      }
      default:
        return tell(t("hf.unknown"));
    }
  }, [activate, stopAll, t, tell, why]);

  const startVoice = useCallback(async () => {
    if (!state.settings.voice) return;
    if (!hasRecognition()) return set({ voice: "unsupported", status: t("hf.noVoice") });
    voice.current?.stop();
    const v = new Voice(lang, (h) => void onHeard(h), (st) => {
      set({ voice: st as State["voice"] });
      if (st === "offline") set({ status: t("hf.offlineVoice") });
      if (st === "unsupported") set({ status: t("hf.noVoice") });
    });
    voice.current = v;
    await v.start();
  }, [lang, onHeard, t]);

  /* ----- calibration ----- */
  const startCalibration = useCallback((kind: "full" | "topup") => {
    if (state.camera !== "on") return;
    const dots = kind === "full" ? [...NINE, ...CHECK] : TOPUP;
    eng.current.collecting = [];
    set({ calibrating: { dots, i: 0, kind }, panel: false });
  }, []);

  useEffect(() => {
    const c = s.calibrating;
    if (!c) return;
    const dot = c.dots[c.i];
    const target = { x: dot.x * innerWidth, y: dot.y * innerHeight };
    eng.current.collecting = [];
    let collect = false;
    const t1 = setTimeout(() => (collect = true), 800);
    const iv = setInterval(() => {
      const f = eng.current.lastFrame;
      if (collect && f?.face && f.blinkL < 0.4 && f.blinkR < 0.4) eng.current.collecting.push(f.f);
    }, 33);
    const t2 = setTimeout(() => {
      clearInterval(iv);
      const v = medianVec(eng.current.collecting);
      const prev = state.saved?.samples ?? [];
      const mine: Sample[] = (window as any).__hfCal ?? ((window as any).__hfCal = []);
      if (v.length) mine.push({ dot: c.kind === "full" ? c.i : 100 + c.i, target, f: v });
      if (c.i + 1 < c.dots.length) return set({ calibrating: { ...c, i: c.i + 1 } });
      (window as any).__hfCal = [];
      const fitSet = c.kind === "full" ? mine.filter((x) => x.dot < NINE.length) : [...prev, ...mine];
      const check = c.kind === "full" ? mine.filter((x) => x.dot >= NINE.length) : mine;
      if (fitSet.length < 5) return set({ calibrating: null, status: t("hf.noAccuracy") });
      const eyes = fitWithCv(fitSet, EYES);
      const head = fitWithCv(fitSet, HEAD);
      const eyesPx = Math.round(accuracyPx(eyes, EYES, check));
      const headPx = Math.round(accuracyPx(head, HEAD, check));
      const f = eng.current.lastFrame?.f ?? [];
      const saved: Saved = { eyes, head, eyesPx, headPx, n: check.length, ref: { x: f[4] ?? 0.5, y: f[5] ?? 0.5, size: f[6] ?? 0.3 }, w: innerWidth, h: innerHeight, at: new Date().toISOString(), samples: [...fitSet, ...check].slice(-60) };
      try {
        localStorage.setItem(CKEY, JSON.stringify(saved));
      } catch { /* storage blocked: this visit only */ }
      const poor = !Number.isFinite(eyesPx) || eyesPx > POOR_EYES_PX;
      const settings = poor ? { ...state.settings, mode: "head" as Mode } : state.settings;
      set({ saved, settings, calibrating: null, shifted: false, status: poor ? t("hf.poorEyes", { px: Number.isFinite(eyesPx) ? eyesPx : "?" }) : t("hf.accuracy", { px: eyesPx, n: check.length }) });
    }, 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearInterval(iv);
    };
  }, [s.calibrating, t]);

  /* ----- the frame loop ----- */
  const loop = useCallback(() => {
    const e = eng.current;
    const v = video.current;
    const tr = tracker.current;
    raf.current = requestAnimationFrame(loop);
    if (!v || !tr || v.readyState < 2) return;
    const now = performance.now();
    let f: Frame;
    try {
      f = tr.readFrame(v, now);
    } catch {
      return why("tracker: frame failed");
    }
    e.lastFrame = f;
    if (!f.face) {
      why("no face in view");
      if (e.lastFace && now - e.lastFace > 2000 && !state.calibrating) stopAll("hf.away");
      return;
    }
    e.lastFace = now;
    // Looking well away from the screen for 2 seconds is an emergency stop (A4.3).
    if (Math.abs(f.f[2]) > 0.75) {
      e.awaySince ||= now;
      why("head turned away");
      if (now - e.awaySince > 2000 && !state.calibrating) stopAll("hf.away");
      return;
    }
    e.awaySince = 0;
    if (state.calibrating) return why("calibrating");
    if (now - e.mouseAt < 3000) return why("paused: the mouse or touch moved");
    // Blink freeze: both eyes closed holds the pointer where it was, so a click lands where they looked.
    if (f.blinkL > 0.5 && f.blinkR > 0.5) {
      e.frozenUntil = now + 150;
      return why("blink: pointer held");
    }
    if (now < e.frozenUntil) return why("just after a blink: pointer held");
    // A wink (one eye shut, the other open) is a click when that is chosen.
    if (state.settings.click === "wink") {
      const w = (f.blinkL > 0.6 && f.blinkR < 0.3) || (f.blinkR > 0.6 && f.blinkL < 0.3);
      if (w && !e.wink) e.wink = now;
      if (!w && e.wink) {
        const held = now - e.wink;
        e.wink = 0;
        const el = currentEl();
        if (held > 90 && held < 600 && el && now - e.clickedAt > 800) void activate(el);
      }
    }
    // Head shift since calibration: offer extra dots (A3.2).
    const sv = state.saved;
    if (sv && headShifted(sv.ref, { x: f.f[4], y: f.f[5], size: f.f[6] })) {
      e.shiftSince ||= now;
      if (now - e.shiftSince > 2000 && !state.shifted) set({ shifted: true });
    } else e.shiftSince = 0;
    // Where the pointer is.
    let raw: Pt;
    const fit = state.settings.mode === "eyes" ? sv?.eyes : sv?.head;
    if (fit && sv) {
      const cols = state.settings.mode === "eyes" ? EYES : HEAD;
      const p = predict(fit, [...cols.map((c) => f.f[c]), 1]);
      raw = { x: (p.x * innerWidth) / sv.w, y: (p.y * innerHeight) / sv.h };
    } else {
      e.neutral ??= [f.f[2], f.f[3]];
      raw = { x: innerWidth / 2 - (f.f[2] - e.neutral[0]) * innerWidth * 1.6, y: innerHeight / 2 + (f.f[3] - e.neutral[1]) * innerHeight * 2.2 };
    }
    raw = { x: Math.max(0, Math.min(innerWidth, e.fx.filter(raw.x, now))), y: Math.max(0, Math.min(innerHeight, e.fy.filter(raw.y, now))) };
    e.raw = raw;
    e.pts = [...e.pts.slice(-9), raw];
    if (now - e.cache.at > 300) e.cache = { at: now, v: collect() };
    const out = e.snap.update(raw, jitterOf(e.pts), e.cache.v.targets, now);
    why(out.why === "snapped" ? "moved to a new control" : out.why === "held" ? "same control" : out.why === "no-target" ? "no control near the pointer" : out.why === "saccade-reset" ? "big jump: votes cleared" : "two controls too close to call");
    if (out.id !== e.current) {
      e.current = out.id;
      e.since = now;
    }
    const el = currentEl();
    const o = outline.current;
    if (o) {
      if (el) {
        const r = el.getBoundingClientRect();
        Object.assign(o.style, { display: "block", left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
      } else o.style.display = "none";
    }
    const dwell = state.settings.dwellMs * (document.documentElement.dataset.a11yExtraTime === "on" ? 2 : 1);
    const g = ring.current;
    if (g) {
      const on = state.settings.click === "dwell" && el && now - e.clickedAt > 1200;
      g.style.display = on ? "block" : "none";
      if (on) {
        const r = el!.getBoundingClientRect();
        const pct = Math.min(1, (now - e.since) / dwell);
        Object.assign(g.style, { left: `${r.right - 14}px`, top: `${r.top - 14}px`, background: `conic-gradient(var(--stamp) ${pct * 360}deg, transparent 0)` });
      }
    }
    if (state.settings.click === "dwell" && el && now - e.since > dwell && now - e.clickedAt > 1200 && !state.confirm) {
      e.since = now;
      void activate(el);
    }
  }, [activate, stopAll, why]);

  /* ----- start and stop ----- */
  const start = useCallback(async () => {
    set({ on: true, camera: "loading", status: t("hf.loading"), debug: [] });
    document.documentElement.dataset.hf = "on";
    void startVoice();
    try {
      stream.current = await (await import("./tracker")).openCamera();
    } catch (err) {
      const name = (err as Error).name;
      set({ camera: name === "NotAllowedError" ? "denied" : "none", status: name === "NotAllowedError" ? t("hf.cameraDenied") : t("hf.noCamera") });
      return;
    }
    try {
      tracker.current = await import("./tracker");
      await tracker.current.loadTracker();
    } catch {
      stream.current?.getTracks().forEach((x) => x.stop());
      stream.current = null;
      return set({ camera: "failed", status: t("hf.trackerFailed") });
    }
    if (!state.on) return stream.current?.getTracks().forEach((x) => x.stop());
    const v = video.current!;
    v.srcObject = stream.current;
    await v.play().catch(() => undefined);
    // The look-away stop counts only once a face has been seen: a slow first frame or a user still sitting down is not looking away.
    eng.current.lastFace = 0;
    eng.current.snap.reset();
    set({ camera: "on", status: state.saved ? t("hf.accuracy", { px: state.saved.eyesPx ?? "?", n: state.saved.n }) : t("hf.noAccuracy") });
    loop();
  }, [loop, startVoice, t]);

  // The shortcut, the emergency stop, the hand-back, and the toggle's requests.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === "h" || e.key === "H" || e.code === "KeyH")) {
        e.preventDefault();
        if (state.on) stopAll();
        else void start();
      } else if (e.key === "Escape" && state.on) {
        if (state.confirm) confirmResolve?.(false);
        else stopAll();
      } else if (e.code === "Space" && state.on && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        if (voice.current) voice.current.ptt = e.type === "keydown";
        if (e.type === "keydown") e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !state.on || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (voice.current) voice.current.ptt = false;
      // Push-to-talk must never press the focused button: browsers click a button on Space's key-up.
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (!state.on || !e.isTrusted || (e.movementX === 0 && e.movementY === 0 && e.pointerType === "mouse")) return;
      if (performance.now() - eng.current.mouseAt > 3000) set({ status: t("hf.mouse") });
      eng.current.mouseAt = performance.now();
    };
    const offline = () => state.on && state.settings.voice && set({ status: t("hf.offlineVoice"), voice: "offline" });
    const online = () => state.on && state.settings.voice && state.voice === "offline" && void startVoice();
    const req = (e: Event) => {
      const d = (e as CustomEvent).detail;
      if (d === "start") void start();
      if (d === "stop") stopAll();
      if (d === "calibrate" || d === "topup") startCalibration(d === "calibrate" ? "full" : "topup");
    };
    addEventListener("keydown", key, true);
    addEventListener("keyup", up, true);
    addEventListener("pointermove", move, { passive: true });
    addEventListener("offline", offline);
    addEventListener("online", online);
    addEventListener("kept:hf", req);
    return () => {
      removeEventListener("keydown", key, true);
      removeEventListener("keyup", up, true);
      removeEventListener("pointermove", move);
      removeEventListener("offline", offline);
      removeEventListener("online", online);
      removeEventListener("kept:hf", req);
    };
  }, [start, startCalibration, startVoice, stopAll, t]);

  // A language switch restarts recognition in the new language.
  useEffect(() => {
    if (state.on && state.settings.voice) void startVoice();
  }, [lang]);
  useEffect(() => () => stopAll(), []);

  return createPortal(
    <div data-hf-ui aria-live="polite">
      <video ref={video} muted playsInline className="sr-only" aria-hidden="true" />
      <div ref={outline} className="pointer-events-none fixed z-[60] hidden rounded-lg border-4 border-stamp shadow-[0_0_0_3px_var(--paper)]" aria-hidden="true" data-testid="hf-outline" />
      <div ref={ring} className="pointer-events-none fixed z-[61] hidden size-7 rounded-full border-2 border-stamp" aria-hidden="true" />
      {s.on && (
        <div className="fixed bottom-3 left-3 z-[62] flex max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-2 rounded-full border border-rule bg-card py-1 pr-1 pl-3 text-sm shadow-lg" data-testid="hf-indicator">
          {s.camera === "on" ? <span className="inline-flex items-center gap-1.5"><Video className="size-4 text-fail" aria-hidden="true" />{t("hf.cameraOn")}</span> : <span>{s.status}</span>}
          <Button size="sm" variant="outline" className="min-h-11" onClick={() => stopAll()}>{s.camera === "on" ? t("hf.cameraOff") : t("hf.stop")}</Button>
        </div>
      )}
      {s.status && <p className="sr-only" role="status">{s.status}</p>}
      {s.shifted && s.on && !s.calibrating && (
        <div className="fixed right-3 bottom-16 z-[62] flex items-center gap-2 rounded-lg border border-pause bg-pause-wash p-3 text-sm shadow" role="status">
          {t("hf.shifted")}
          <Button size="sm" onClick={() => startCalibration("topup")}>{t("hf.addDots")}</Button>
          <Button size="icon" variant="ghost" aria-label={t("hf.cancel")} onClick={() => set({ shifted: false })}><X aria-hidden="true" /></Button>
        </div>
      )}
      {s.calibrating && (
        <div className="fixed inset-0 z-[70] bg-paper/95" role="dialog" aria-modal="true" aria-label={t("hf.calibrate")}>
          <p className="absolute top-6 left-1/2 m-0 -translate-x-1/2 rounded bg-card px-3 py-2 text-center" role="status">{t("hf.lookDot", { i: s.calibrating.i + 1, n: s.calibrating.dots.length })}</p>
          <span className="absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-stamp ring-8 ring-stamp/25" style={{ left: `${s.calibrating.dots[s.calibrating.i].x * 100}%`, top: `${s.calibrating.dots[s.calibrating.i].y * 100}%` }} aria-hidden="true" />
          <Button variant="outline" className="absolute right-4 bottom-4" onClick={() => set({ calibrating: null })}>{t("hf.cancel")}</Button>
        </div>
      )}
      {s.confirm && <ConfirmCard c={s.confirm} t={t} />}
      <HandsFreePanel open={s.panel} lang={lang} />
    </div>,
    document.body,
  );
}

function ConfirmCard({ c, t }: { c: Confirm; t: T }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-ink/40 p-4" data-hf-pointable>
      <div role="alertdialog" aria-modal="true" aria-labelledby="hf-confirm-t" className="w-full max-w-md rounded-2xl border border-rule bg-card p-6 shadow-xl" data-testid="hf-confirm">
        <h2 id="hf-confirm-t" className="m-0 text-xl font-bold">{t("hf.confirmT")}</h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-ink-2">{t("hf.what")}</dt><dd className="m-0 font-medium">{c.what}</dd>
          <dt className="text-ink-2">{t("hf.amount")}</dt><dd className="m-0 font-medium num">{c.amount ?? "—"}</dd>
          <dt className="text-ink-2">{t("hf.to")}</dt><dd className="m-0 font-medium">{c.to ?? "—"}</dd>
        </dl>
        <p className="mt-3 text-sm text-ink-2">{t("hf.sayYes")}</p>
        <div className="mt-4 flex flex-wrap gap-2" data-hf-safe>
          <Button ref={ref} onClick={() => confirmResolve?.(true)}>{t("hf.confirm")}</Button>
          <Button variant="outline" onClick={() => confirmResolve?.(false)}>{t("hf.cancel")}</Button>
        </div>
      </div>
    </div>
  );
}

function HandsFreePanel({ open, lang }: { open: boolean; lang: Lang }) {
  const s = useHF();
  const { t } = useT();
  const st = s.settings;
  const upd = (p: Partial<Settings>) => set({ settings: { ...st, ...p } });
  const send = (d: string) => dispatchEvent(new CustomEvent("kept:hf", { detail: d }));
  return (
    <Sheet open={open} onOpenChange={(o) => set({ panel: o })}>
      <SheetContent side="right" className="w-[min(100vw,380px)] overflow-y-auto bg-card p-5" lang={lang}>
        <SheetHeader className="p-0">
          <SheetTitle className="text-left">{t("hf.title")}</SheetTitle>
        </SheetHeader>
        <p className="mt-2 text-sm text-ink-2">{t("hf.intro")}</p>
        <p className="text-sm text-ink-2">{t("hf.shortcut")}</p>
        <fieldset className="mt-3 grid gap-1 border-0 p-0">
          <legend className="font-medium">{t("hf.pointer")}</legend>
          {(["head", "eyes"] as Mode[]).map((m) => (
            <label key={m} className="flex min-h-11 items-center gap-2"><input type="radio" name="hf-mode" checked={st.mode === m} onChange={() => upd({ mode: m })} className="size-5" />{t(m === "head" ? "hf.head" : "hf.eyes")}</label>
          ))}
        </fieldset>
        <fieldset className="mt-3 grid gap-1 border-0 p-0">
          <legend className="font-medium">{t("hf.clickBy")}</legend>
          {(["dwell", "say", "wink"] as ClickBy[]).map((m) => (
            <label key={m} className="flex min-h-11 items-center gap-2"><input type="radio" name="hf-click" checked={st.click === m} onChange={() => upd({ click: m })} className="size-5" />{t(m === "dwell" ? "hf.dwell" : m === "say" ? "hf.say" : "hf.wink")}</label>
          ))}
        </fieldset>
        <label className="mt-3 flex min-h-11 items-center gap-2"><input type="checkbox" checked={st.voice} onChange={(e) => upd({ voice: e.target.checked })} className="size-5" />{t("hf.voice")}</label>
        <p className="m-0 text-xs text-ink-2">{t("hf.voiceNote")}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {s.on ? <Button variant="outline" onClick={() => send("stop")}>{t("hf.stop")}</Button> : <Button onClick={() => send("start")} data-testid="hf-start">{t("hf.start")}</Button>}
          <Button variant="outline" disabled={s.camera !== "on"} onClick={() => send("calibrate")}>{t("hf.calibrate")}</Button>
          <Button variant="outline" disabled={s.camera !== "on" || !s.saved} onClick={() => send("topup")}>{t("hf.topup")}</Button>
        </div>
        <p className="mt-3 text-sm" role="status">{s.saved ? t("hf.accuracy", { px: s.saved.eyesPx ?? "?", n: s.saved.n }) : t("hf.noAccuracy")}</p>
        {s.status && <p className="text-sm text-ink-2" data-testid="hf-status">{s.status}</p>}
        {s.heard && <p className="text-sm">{t("hf.heard", { t: s.heard })}</p>}
        <details className="mt-3">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2"><Bug className="size-4" aria-hidden="true" />{t("hf.debug")}</summary>
          <ol className="mt-1 list-none p-0 font-mono text-xs" data-testid="hf-debug">
            {s.debug.map((d, i) => <li key={i}>{d.why}{d.n > 1 ? ` ×${d.n}` : ""}</li>)}
          </ol>
          <p className="text-xs text-ink-2">camera: {s.camera} · voice: {s.voice}{s.saved ? ` · head ${s.saved.headPx ?? "?"} px, eyes ${s.saved.eyesPx ?? "?"} px` : ""}</p>
        </details>
      </SheetContent>
    </Sheet>
  );
}

/** The header button: opens the panel. Alt+H starts and stops without opening anything. */
export function HandsFreeToggle() {
  const s = useHF();
  const { t } = useT();
  return (
    <Button variant={s.on ? "default" : "ghost"} size="icon" className="size-11" aria-label={t("hf.title")} title={`${t("hf.title")} (Alt+H)`} aria-pressed={s.on} data-hf-toggle="true" data-testid="hf-toggle" onClick={() => set({ panel: true })}>
      <ScanEye aria-hidden="true" />
    </Button>
  );
}
