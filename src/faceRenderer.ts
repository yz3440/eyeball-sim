import { FACE_OVAL } from "./landmarks";

export interface Point {
  x: number;
  y: number;
}

function tracePath(ctx: CanvasRenderingContext2D, pts: Point[], indices: number[]) {
  ctx.beginPath();
  ctx.moveTo(pts[indices[0]].x, pts[indices[0]].y);
  for (let i = 1; i < indices.length; i++) {
    ctx.lineTo(pts[indices[i]].x, pts[indices[i]].y);
  }
  ctx.closePath();
}

function tracePoints(ctx: CanvasRenderingContext2D, points: Point[]) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.closePath();
}

export function drawFaceMask(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  pts: Point[],
  W: number,
  H: number,
  scale: number,
  tx: number,
  ty: number
) {
  ctx.save();
  tracePath(ctx, pts, FACE_OVAL);
  ctx.clip();
  ctx.translate(tx, ty);
  ctx.scale(scale, scale);
  ctx.scale(-1, 1);
  ctx.drawImage(video, -W, 0, W, H);
  ctx.restore();
}

export function drawFaceColor(
  ctx: CanvasRenderingContext2D,
  pts: Point[],
  color: string
) {
  ctx.save();
  tracePath(ctx, pts, FACE_OVAL);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

export function cutOutEyes(
  ctx: CanvasRenderingContext2D,
  leftEye: Point[],
  rightEye: Point[]
) {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "white";

  tracePoints(ctx, rightEye);
  ctx.fill();

  tracePoints(ctx, leftEye);
  ctx.fill();

  ctx.restore();
}

export function fillEyesWhite(
  ctx: CanvasRenderingContext2D,
  leftEye: Point[],
  rightEye: Point[]
) {
  ctx.save();
  ctx.fillStyle = "white";

  tracePoints(ctx, rightEye);
  ctx.fill();

  tracePoints(ctx, leftEye);
  ctx.fill();

  ctx.restore();
}
