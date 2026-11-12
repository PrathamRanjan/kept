/**
 * Part A2.1: snapping a noisy pointer to buttons instead of moving a raw cursor. The approach follows what the
 * Peek README describes (deixis-main, no licence file, so no code was copied; this is written from scratch):
 *   - each sample votes for nearby targets, weighted by how close it is and by the current jitter;
 *   - votes fade within a fraction of a second;
 *   - the outline only moves when another target clearly wins (hysteresis), so it does not flicker;
 *   - a sudden jump (a saccade) clears the old votes, so looking somewhere new is picked up quickly;
 *   - each confirmed click counts as "the user was looking here" and nudges a drift offset toward that point.
 * Pure functions and one small class: no DOM, so it runs in unit tests.
 */
export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Target { id: string; rect: Rect }

export const SNAP = {
  /** Votes lose half their weight in this many ms. */
  halfLifeMs: 180,
  /** A move this far between two samples is a saccade and clears the votes. */
  saccadePx: 220,
  /** A challenger must beat the current target by this factor. */
  hysteresis: 1.6,
  /** And have at least this much vote before it can take over. */
  minVote: 0.6,
  baseRadius: 48,
  maxRadius: 180,
  /** How far each confirmed click moves the drift offset toward the clicked target's centre. */
  driftAlpha: 0.3,
  maxDrift: 160,
};

export function distToRect(p: Pt, r: Rect): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}
export const centre = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Jitter: the spread of the last few samples, in px. */
export function jitterOf(samples: Pt[]): number {
  if (samples.length < 2) return 0;
  const m = samples.reduce((a, p) => ({ x: a.x + p.x / samples.length, y: a.y + p.y / samples.length }), { x: 0, y: 0 });
  return Math.sqrt(samples.reduce((a, p) => a + (p.x - m.x) ** 2 + (p.y - m.y) ** 2, 0) / samples.length);
}

export type Why = "snapped" | "held" | "no-target" | "too-close-to-call" | "saccade-reset";

export class Snapper {
  votes = new Map<string, number>();
  current: string | null = null;
  drift: Pt = { x: 0, y: 0 };
  private last: Pt | null = null;
  private lastAt = 0;

  /** Feed one sample. Returns the outlined target and why it is (or is not) that one. */
  update(raw: Pt, jitter: number, targets: Target[], now: number): { id: string | null; why: Why; point: Pt } {
    const p = { x: raw.x + this.drift.x, y: raw.y + this.drift.y };
    const dt = this.lastAt ? Math.max(0, now - this.lastAt) : 0;
    this.lastAt = now;
    let why: Why = "held";
    if (this.last && Math.hypot(p.x - this.last.x, p.y - this.last.y) > SNAP.saccadePx) {
      this.votes.clear();
      why = "saccade-reset";
    }
    this.last = p;
    const fade = Math.pow(0.5, dt / SNAP.halfLifeMs);
    for (const [k, v] of this.votes) {
      const nv = v * fade;
      if (nv < 0.01) this.votes.delete(k);
      else this.votes.set(k, nv);
    }
    // A steadier signal votes more sharply; a jittery one spreads its vote wider and thinner.
    const radius = Math.min(SNAP.maxRadius, SNAP.baseRadius + 1.5 * jitter);
    const sigma = Math.max(18, jitter);
    let any = false;
    for (const t of targets) {
      const d = distToRect(p, t.rect);
      if (d > radius) continue;
      any = true;
      this.votes.set(t.id, (this.votes.get(t.id) ?? 0) + Math.exp(-(d * d) / (2 * sigma * sigma)));
    }
    if (this.current && !targets.some((t) => t.id === this.current)) this.current = null;
    let lead: string | null = null;
    let best = 0;
    for (const [k, v] of this.votes) if (v > best && targets.some((t) => t.id === k)) (lead = k), (best = v);
    if (!lead) {
      if (!any) this.current = null;
      return { id: this.current, why: any ? "too-close-to-call" : "no-target", point: p };
    }
    if (lead === this.current) return { id: this.current, why: why === "saccade-reset" ? why : "held", point: p };
    const cur = this.current ? this.votes.get(this.current) ?? 0 : 0;
    if (best >= SNAP.minVote && best > cur * SNAP.hysteresis) {
      this.current = lead;
      return { id: lead, why: "snapped", point: p };
    }
    return { id: this.current, why: "too-close-to-call", point: p };
  }

  /** A confirmed click on `target` while the pointer read `raw`: the user was looking at the target. */
  confirmClick(raw: Pt, target: Rect) {
    const c = centre(target);
    const p = { x: raw.x + this.drift.x, y: raw.y + this.drift.y };
    const clamp = (v: number) => Math.max(-SNAP.maxDrift, Math.min(SNAP.maxDrift, v));
    this.drift = { x: clamp(this.drift.x + SNAP.driftAlpha * (c.x - p.x)), y: clamp(this.drift.y + SNAP.driftAlpha * (c.y - p.y)) };
  }

  reset() {
    this.votes.clear();
    this.current = null;
    this.last = null;
    this.lastAt = 0;
  }
}

/** One-euro filter: smooths a jittery signal while staying quick on real movement. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private minCutoff = 1.0, private beta = 0.02, private dCutoff = 1.0) {}
  private alpha(cut: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cut);
    return 1 / (1 + tau / dt);
  }
  filter(v: number, tMs: number): number {
    if (this.x === null) {
      this.x = v;
      this.t = tMs;
      return v;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const d = (v - this.x) / dt;
    this.dx += this.alpha(this.dCutoff, dt) * (d - this.dx);
    const cut = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this.alpha(cut, dt) * (v - this.x);
    return this.x;
  }
  reset() {
    this.x = null;
  }
}
