/**
 * Part A3: calibration. Nine dots; for each, the tracker's features are collected once the eyes have settled.
 * Two linear maps are fitted with ridge regression: eyes (iris position plus head angle) and head (head angle
 * only). The ridge strength is chosen by leave-one-dot-out cross-validation. Accuracy is then measured on check
 * dots the fit never saw and shown in pixels; when eye pointing is worse than POOR_EYES_PX, head pointing is used.
 * Pure maths: no DOM, so it runs in unit tests.
 */
export type Vec = number[];
export interface Sample { dot: number; target: { x: number; y: number }; f: Vec }
export interface Fit { w: [Vec, Vec]; lambda: number; cvPx: number; dims: number }

export const LAMBDAS = [1e-4, 1e-3, 1e-2, 1e-1, 1];
export const POOR_EYES_PX = 120;
export const NINE: { x: number; y: number }[] = [0.1, 0.5, 0.9].flatMap((y) => [0.1, 0.5, 0.9].map((x) => ({ x, y })));
export const CHECK: { x: number; y: number }[] = [{ x: 0.3, y: 0.3 }, { x: 0.7, y: 0.3 }, { x: 0.3, y: 0.7 }, { x: 0.7, y: 0.7 }];
export const TOPUP: { x: number; y: number }[] = [{ x: 0.5, y: 0.5 }, { x: 0.15, y: 0.15 }, { x: 0.85, y: 0.85 }];

/** Solve (XᵀX + λI) w = Xᵀy by Gaussian elimination. The bias column (last) is not penalised. */
export function ridge(X: Vec[], y: number[], lambda: number): Vec {
  const d = X[0]?.length ?? 0;
  const A = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => X.reduce((s, r) => s + r[i] * r[j], 0) + (i === j && i < d - 1 ? lambda : 0)));
  const b = Array.from({ length: d }, (_, i) => X.reduce((s, r, k) => s + r[i] * y[k], 0));
  for (let c = 0; c < d; c++) {
    let p = c;
    for (let r = c + 1; r < d; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) continue;
    for (let r = 0; r < d; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j < d; j++) A[r][j] -= k * A[c][j];
      b[r] -= k * b[c];
    }
  }
  return b.map((v, i) => (Math.abs(A[i][i]) < 1e-12 ? 0 : v / A[i][i]));
}

const dot = (w: Vec, f: Vec) => w.reduce((s, v, i) => s + v * (f[i] ?? 0), 0);
export const predict = (fit: Pick<Fit, "w">, f: Vec) => ({ x: dot(fit.w[0], f), y: dot(fit.w[1], f) });

/** Features standardised per column would be better; the tracker already gives values of similar size. */
function fitOnce(samples: Sample[], lambda: number, cols: number[]): [Vec, Vec] {
  const X = samples.map((s) => [...cols.map((c) => s.f[c]), 1]);
  return [ridge(X, samples.map((s) => s.target.x), lambda), ridge(X, samples.map((s) => s.target.y), lambda)];
}

/** Choose λ by leave-one-dot-out error in px, then fit on everything. `cols` picks the feature columns. */
export function fitWithCv(samples: Sample[], cols: number[]): Fit {
  const dots = [...new Set(samples.map((s) => s.dot))];
  let best = { lambda: LAMBDAS[0], err: Infinity };
  for (const lambda of LAMBDAS) {
    let sum = 0;
    let n = 0;
    for (const d of dots) {
      const train = samples.filter((s) => s.dot !== d);
      const test = samples.filter((s) => s.dot === d);
      if (!train.length || !test.length) continue;
      const w = fitOnce(train, lambda, cols);
      for (const s of test) {
        const p = predict({ w }, [...cols.map((c) => s.f[c]), 1]);
        sum += Math.hypot(p.x - s.target.x, p.y - s.target.y);
        n++;
      }
    }
    const err = n ? sum / n : Infinity;
    if (err < best.err) best = { lambda, err };
  }
  return { w: fitOnce(samples, best.lambda, cols), lambda: best.lambda, cvPx: best.err, dims: cols.length };
}

/** Mean error in px of a fit on samples it was not fitted on. */
export function accuracyPx(fit: Fit, cols: number[], check: Sample[]): number {
  if (!check.length) return Infinity;
  return check.reduce((s, c) => {
    const p = predict(fit, [...cols.map((i) => c.f[i]), 1]);
    return s + Math.hypot(p.x - c.target.x, p.y - c.target.y);
  }, 0) / check.length;
}

/** Feature columns: 0 iris x, 1 iris y, 2 yaw, 3 pitch, 4 head x, 5 head y, 6 face size. */
export const EYES = [0, 1, 2, 3];
export const HEAD = [2, 3];

/** The head moved far from where it was during calibration (position or distance to the screen). */
export function headShifted(ref: { x: number; y: number; size: number }, now: { x: number; y: number; size: number }): boolean {
  return Math.hypot(now.x - ref.x, now.y - ref.y) > 0.08 || Math.abs(now.size - ref.size) / Math.max(1e-6, ref.size) > 0.18;
}

/** The median of a sample window, per feature (steadier than a mean when a blink sneaks in). */
export function medianVec(vs: Vec[]): Vec {
  if (!vs.length) return [];
  return vs[0].map((_, i) => {
    const col = vs.map((v) => v[i]).sort((a, b) => a - b);
    return col[Math.floor(col.length / 2)];
  });
}
