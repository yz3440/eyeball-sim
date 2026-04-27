export interface Point {
  x: number;
  y: number;
}

function tracePoints(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
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
