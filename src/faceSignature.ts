import { Point } from "./faceRenderer";

// Pairs of MediaPipe FaceMesh landmarks whose distances together describe
// face proportions. Distances are normalized by interocular distance, so the
// signature is invariant to face size and rough orientation.
//
// Only bone-structure pairs — no mouth, no eye openness, no eyebrow raise.
// Expression should not change identity, and the previous version drifted
// 10–30% per component when the subject smiled or blinked.
//
// This is a lightweight identity hash — good for distinguishing a small
// roster (<~10 people). It is NOT a CNN face embedding; expect false matches
// between people with very similar bone structure.
const PAIRS: ReadonlyArray<readonly [number, number]> = [
  // Eye widths
  [33, 133], // right eye
  [263, 362], // left eye
  // Eye spacing
  [33, 263], // outer-to-outer
  [133, 362], // inner-to-inner
  // Inter-brow (above the nose bridge — stable, doesn't move with raise)
  [55, 285],
  // Nose ridge proportions
  [168, 1],
  [1, 4],
  // Nose width (alae)
  [102, 331],
  // Bizygomatic + face height
  [234, 454],
  [10, 152],
  // Chin → cheek
  [152, 234],
  [152, 454],
  // Nose tip → cheek (encodes mid-face shape)
  [1, 234],
  [1, 454],
  // Nose tip → chin
  [1, 152],
  // Forehead → eye corners
  [10, 33],
  [10, 263],
];

const INTEROCULAR = [
  [33, 133], // right eye outer/inner midpoint
  [263, 362], // left eye outer/inner midpoint
] as const;

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export const SIGNATURE_LENGTH = PAIRS.length;

export function computeFaceSignature(landmarks: Point[]): Float32Array {
  const rEye = midpoint(landmarks[INTEROCULAR[0][0]], landmarks[INTEROCULAR[0][1]]);
  const lEye = midpoint(landmarks[INTEROCULAR[1][0]], landmarks[INTEROCULAR[1][1]]);
  const interOc = dist(rEye, lEye) || 1;

  const sig = new Float32Array(PAIRS.length);
  for (let i = 0; i < PAIRS.length; i++) {
    sig[i] = dist(landmarks[PAIRS[i][0]], landmarks[PAIRS[i][1]]) / interOc;
  }
  return sig;
}

/** Mean absolute difference per component — small means similar. Each
 *  component is a ratio (pair distance / interocular), so the value is
 *  interpretable as "average ratio mismatch": ~0.04 separates same person
 *  from different in informal testing. Exposed to the user via tweakpane. */
export function signatureDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += Math.abs(a[i] - b[i]);
  }
  return s / a.length;
}
