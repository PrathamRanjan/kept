/**
 * Part A1.2/A1.4: face tracking in the browser, on this device only. MediaPipe Face Landmarker (Apache 2.0) runs
 * from files Kept serves itself (/static/handsfree), so nothing is installed and no frame is ever uploaded: the
 * video element is never drawn to a canvas that leaves the page, and no request carries pixels.
 *
 * Per frame it gives the features calibration uses: iris position inside each eye, head yaw and pitch, where the
 * head is in the picture and how big (distance), and the two blink scores for blink-freeze and wink clicks.
 */
import type { Vec } from "./calib";

export interface Frame {
  t: number;
  face: boolean;
  /** 0 iris x, 1 iris y, 2 yaw, 3 pitch, 4 head x, 5 head y, 6 face size (see calib.ts). */
  f: Vec;
  blinkL: number;
  blinkR: number;
}

const BASE = "/static/handsfree";
let landmarker: any = null;

export async function loadTracker(): Promise<void> {
  if (landmarker) return;
  const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
  const files = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
  const make = (delegate: "GPU" | "CPU") =>
    FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${BASE}/face_landmarker.task`, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  try {
    landmarker = await make("GPU");
  } catch {
    landmarker = await make("CPU");
  }
}

const L = { rIris: 468, lIris: 473, rOut: 33, rIn: 133, rUp: 159, rLo: 145, lIn: 362, lOut: 263, lUp: 386, lLo: 374, nose: 1, top: 10, chin: 152, lCheek: 234, rCheek: 454 };

function eyeRatio(lm: any[], iris: number, a: number, b: number, up: number, lo: number): [number, number] {
  const ax = lm[a].x, bx = lm[b].x;
  const x = (lm[iris].x - Math.min(ax, bx)) / Math.max(1e-6, Math.abs(bx - ax));
  const y = (lm[iris].y - lm[up].y) / Math.max(1e-6, lm[lo].y - lm[up].y);
  return [x, y];
}

export function readFrame(video: HTMLVideoElement, t: number): Frame {
  const r = landmarker.detectForVideo(video, t);
  const lm = r.faceLandmarks?.[0];
  if (!lm) return { t, face: false, f: [], blinkL: 0, blinkR: 0 };
  const [rx, ry] = eyeRatio(lm, L.rIris, L.rOut, L.rIn, L.rUp, L.rLo);
  const [lx, ly] = eyeRatio(lm, L.lIris, L.lIn, L.lOut, L.lUp, L.lLo);
  const m: number[] = r.facialTransformationMatrixes?.[0]?.data ?? [];
  // Column-major 4x4; the third column is the face's forward direction.
  const fx = m[8] ?? 0, fy = m[9] ?? 0, fz = m[10] ?? 1;
  const yaw = Math.atan2(fx, fz);
  const pitch = Math.atan2(-fy, Math.hypot(fx, fz));
  const size = Math.hypot(lm[L.lCheek].x - lm[L.rCheek].x, lm[L.lCheek].y - lm[L.rCheek].y);
  const cats: { categoryName: string; score: number }[] = r.faceBlendshapes?.[0]?.categories ?? [];
  const score = (n: string) => cats.find((c) => c.categoryName === n)?.score ?? 0;
  return { t, face: true, f: [(rx + lx) / 2, (ry + ly) / 2, yaw, pitch, lm[L.nose].x, lm[L.nose].y, size], blinkL: score("eyeBlinkLeft"), blinkR: score("eyeBlinkRight") };
}

export async function openCamera(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error("no camera API"), { name: "NotFoundError" });
  return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
}
