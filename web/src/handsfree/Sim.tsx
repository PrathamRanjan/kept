/**
 * Part A9: hands-free without a camera, for judges. A scripted, noisy "gaze" (about 40 px of jitter, the kind a
 * webcam gives) moves across three buttons. The same Snapper the real mode uses picks the outlined button, the
 * ring fills while it dwells, and the click lands. Labelled as simulated everywhere it appears.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { Snapper, jitterOf, type Pt } from "./snap";

const DWELL = 900;

export function HandsFreeSim() {
  const { t } = useT();
  const box = useRef<HTMLDivElement>(null);
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  const [dot, setDot] = useState<Pt | null>(null);
  const [lit, setLit] = useState<number | null>(null);
  const [fill, setFill] = useState(0);
  const [clicked, setClicked] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const labels = [t("hf.simA"), t("hf.simB"), t("hf.simC")];

  useEffect(() => {
    if (!running) return;
    const snap = new Snapper();
    const b = box.current!.getBoundingClientRect();
    const rects = btns.current.map((el) => el!.getBoundingClientRect()).map((r) => ({ x: r.left - b.left, y: r.top - b.top, w: r.width, h: r.height }));
    // Glance at the first button (shorter than the dwell, so it must not click), then settle on the middle one.
    const waypoints: Pt[] = [{ x: rects[0].x + rects[0].w / 2, y: rects[0].y + rects[0].h / 2 }, { x: rects[0].x + rects[0].w / 2, y: rects[0].y + rects[0].h / 2 }, { x: rects[1].x + rects[1].w / 2, y: rects[1].y + rects[1].h / 2 }];
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 80;
    const pts: Pt[] = [];
    const t0 = performance.now();
    let since = 0;
    let cur: string | null = null;
    let raf = 0;
    const step = () => {
      const now = performance.now();
      const el = now - t0;
      const seg = el < 250 ? 0 : el < 400 ? 1 : 2;
      const a = waypoints[seg === 2 ? 2 : seg];
      const z = waypoints[seg === 2 ? 2 : seg + 1];
      const k = seg === 0 ? el / 250 : seg === 1 ? (el - 250) / 150 : 1;
      const p = { x: a.x + (z.x - a.x) * k + noise(), y: a.y + (z.y - a.y) * k + noise() * 0.6 };
      pts.push(p);
      if (pts.length > 10) pts.shift();
      setDot(p);
      const out = snap.update(p, jitterOf(pts), rects.map((r, i) => ({ id: String(i), rect: r })), now);
      if (out.id !== cur) {
        cur = out.id;
        since = now;
      }
      setLit(cur === null ? null : Number(cur));
      const f = cur === null ? 0 : Math.min(1, (now - since) / DWELL);
      setFill(f);
      if (cur !== null && f >= 1) {
        setClicked(labels[Number(cur)]);
        setRunning(false);
        return;
      }
      if (el > 8000) return setRunning(false);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  return (
    <section className="mt-8 rounded-xl border border-rule bg-card p-5" aria-labelledby="hf-sim" data-testid="hf-sim">
      <h2 id="hf-sim" className="m-0 text-2xl font-bold">{t("hf.simTitle")}</h2>
      <p className="mt-1 text-ink-2">{t("hf.simBody")}</p>
      <div ref={box} className="relative mt-4 flex flex-wrap items-center gap-6 rounded-lg border border-dashed border-rule p-6" aria-hidden="true">
        {labels.map((l, i) => (
          <span key={l} className="relative">
            <button ref={(el) => { btns.current[i] = el; }} type="button" tabIndex={-1} className={`min-h-11 rounded-md border px-4 ${lit === i ? "border-stamp ring-4 ring-stamp/40" : "border-rule"}`}>{l}</button>
            {lit === i && <span className="absolute -top-3 -right-3 size-6 rounded-full border-2 border-stamp" style={{ background: `conic-gradient(var(--stamp) ${fill * 360}deg, transparent 0)` }} />}
          </span>
        ))}
        {dot && <span className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-fail/70" style={{ left: dot.x, top: dot.y }} />}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={() => { setClicked(null); setRunning(true); }} disabled={running} data-testid="hf-sim-run">{t("hf.simRun")}</Button>
        <p className="m-0" role="status" data-testid="hf-sim-out">{clicked ? t("hf.simClicked", { t: clicked }) : ""}</p>
      </div>
    </section>
  );
}
