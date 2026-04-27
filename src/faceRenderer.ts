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
  ctx.save();
  ctx.fillStyle = "white";

  if (rightEye.length > 0) {
    tracePoints(ctx, rightEye);
    ctx.fill();
  }

  if (leftEye.length > 0) {
    tracePoints(ctx, leftEye);
    ctx.fill();
  }

  ctx.restore();
}
