export interface Point {
  x: number;
  y: number;
}

export function tracePoints(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  addPolygonSubpath(ctx, points);
}

/** Adds the polygon as a subpath of the current path (no beginPath). */
export function addPolygonSubpath(
  ctx: CanvasRenderingContext2D,
  points: Point[]
) {
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
}

/**
 * Pushes each polygon vertex outward by `amount` pixels along its bisector
 * normal. Outward direction is chosen relative to the centroid, so the polygon
 * winding doesn't matter. amount = 0 returns the input untouched.
 */
export function dilatePolygon(points: Point[], amount: number): Point[] {
  if (amount === 0 || points.length < 3) return points;

  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  const n = points.length;
  const out: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    // Average of the two edges' perpendiculars (bisector direction).
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    let nx = -e1y - e2y;
    let ny = e1x + e2x;
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;

    // Flip if it points inward.
    const rx = curr.x - cx;
    const ry = curr.y - cy;
    if (nx * rx + ny * ry < 0) {
      nx = -nx;
      ny = -ny;
    }

    out[i] = { x: curr.x + nx * amount, y: curr.y + ny * amount };
  }
  return out;
}

export function fillEyesWhite(
  ctx: CanvasRenderingContext2D,
  leftEye: Point[],
  rightEye: Point[]
) {
  if (rightEye.length > 0) fillEyeShaded(ctx, rightEye);
  if (leftEye.length > 0) fillEyeShaded(ctx, leftEye);
}

function fillEyeShaded(ctx: CanvasRenderingContext2D, eye: Point[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  let sumX = 0,
    sumY = 0;
  for (const p of eye) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    sumX += p.x;
    sumY += p.y;
  }
  const cx = sumX / eye.length;
  const cy = sumY / eye.length;
  const w = maxX - minX;
  const h = maxY - minY;
  const r = Math.max(w, h);

  ctx.save();
  // clip everything to the eye polygon
  tracePoints(ctx, eye);
  ctx.clip();

  // base: radial gradient from a bright upper-left center, fading to off-white.
  // light direction here matches the GL shader's u_lightDir (upper-left).
  const baseGrad = ctx.createRadialGradient(
    cx - w * 0.22,
    cy - h * 0.32,
    0,
    cx,
    cy,
    r * 0.95
  );
  baseGrad.addColorStop(0, "#ffffff");
  baseGrad.addColorStop(0.55, "#f1f1f3");
  baseGrad.addColorStop(1, "#d6d6db");
  ctx.fillStyle = baseGrad;
  ctx.fillRect(minX - 4, minY - 4, w + 8, h + 8);

  // bright specular blob — the "wet" highlight on the glossy surface
  const spec = ctx.createRadialGradient(
    cx - w * 0.28,
    cy - h * 0.32,
    0,
    cx - w * 0.28,
    cy - h * 0.32,
    Math.min(w, h) * 0.45
  );
  spec.addColorStop(0, "rgba(255,255,255,0.85)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = spec;
  ctx.fillRect(minX - 4, minY - 4, w + 8, h + 8);

  ctx.restore();
}
