import * as planck from "planck";
import { dilatePolygon, Point } from "./faceRenderer";
import { GLEyeRenderer } from "./glEyeRenderer";
import {
  RIGHT_EYE,
  LEFT_EYE,
  RIGHT_EYE_UPPER_MID,
  RIGHT_EYE_LOWER_MID,
  LEFT_EYE_UPPER_MID,
  LEFT_EYE_LOWER_MID,
  RIGHT_EYE_OUTER,
  RIGHT_EYE_INNER,
  LEFT_EYE_OUTER,
  LEFT_EYE_INNER,
} from "./landmarks";

const SCALE = 100; // pixels per meter (planck world ↔ canvas)

// Average adult bizygomatic (cheekbone-to-cheekbone) width. Used as the
// real-world reference for converting the ball's pixel travel into meters.
// ~14 cm spans typical male/female means in published anthropometric data.
const FACE_WIDTH_M = 0.14;
// MediaPipe FaceMesh indices for the right and left cheekbone (zygion area).
const FACE_WIDTH_RIGHT = 234;
const FACE_WIDTH_LEFT = 454;

export interface PhysicsParams {
  gravity: number;
  linearDamping: number;
  restitution: number;
  friction: number;
  density: number;
  eyeSizeRatio: number;
  landmarkSmooth: number;
  springStrength: number;
  earClosedThreshold: number;
  alphaTimeConstant: number;
  /** 0..1 — how much the ball follows the eye when the head moves.
   *  1 = rigidly glued, 0 = ignores head motion (heavy slosh). */
  eyeDrag: number;
  /** px to push each eye-contour vertex outward; affects both physics and rendering. */
  eyeDilate: number;
}

export const DEFAULT_PHYSICS_PARAMS: PhysicsParams = {
  gravity: 45.5,
  linearDamping: 3.3,
  restitution: 0.8,
  friction: 0.05,
  density: 1.6,
  eyeSizeRatio: 0.35,
  landmarkSmooth: 0.7,
  springStrength: 28,
  earClosedThreshold: 0.11,
  alphaTimeConstant: 0.32,
  eyeDrag: 0.15,
  eyeDilate: 0.5,
};

interface EyeBasis {
  c: Point; // centroid of smoothed contour
  ux: number; // unit vector inner→outer corner, x component
  uy: number; //                                  y component
  w: number; // eye width = |outer - inner|
}

function computeBasis(contour: Point[]): EyeBasis {
  // RIGHT_EYE/LEFT_EYE are ordered so contour[0] = outer corner, contour[8] = inner corner.
  const outer = contour[0];
  const inner = contour[8];
  let sumX = 0,
    sumY = 0;
  for (const p of contour) {
    sumX += p.x;
    sumY += p.y;
  }
  const c: Point = { x: sumX / contour.length, y: sumY / contour.length };
  const dx = outer.x - inner.x;
  const dy = outer.y - inner.y;
  const w = Math.hypot(dx, dy) || 1e-6;
  return { c, ux: dx / w, uy: dy / w, w };
}

function toWorld(x: number, y: number): planck.Vec2 {
  return planck.Vec2(x / SCALE, y / SCALE);
}

function centroid(pts: Point[], indices: number[]): Point {
  let cx = 0,
    cy = 0;
  for (const i of indices) {
    cx += pts[i].x;
    cy += pts[i].y;
  }
  return { x: cx / indices.length, y: cy / indices.length };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerpPt(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function eyeAspectRatio(
  pts: Point[],
  upperMid: number,
  lowerMid: number,
  outer: number,
  inner: number
): number {
  const v = dist(pts[upperMid], pts[lowerMid]);
  const h = dist(pts[outer], pts[inner]);
  return h > 0.0001 ? v / h : 0;
}

function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x,
      yi = poly[i].y;
    const xj = poly[j].x,
      yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export class EyeSystem {
  readonly world: planck.World;
  readonly params: PhysicsParams;

  constructor(params: PhysicsParams) {
    this.params = params;
    this.world = new planck.World(planck.Vec2(0, params.gravity));
  }

  createPerson(): PersonEyes {
    return new PersonEyes(this.world, this.params);
  }

  destroyPerson(person: PersonEyes) {
    person.dispose();
  }

  step(dt: number) {
    this.world.setGravity(planck.Vec2(0, this.params.gravity));
    const clampedDt = Math.min(dt, 1 / 30);
    this.world.step(clampedDt, 8, 3);
  }
}

export class PersonEyes {
  private world: planck.World;
  private params: PhysicsParams;
  private leftBall: planck.Body;
  private rightBall: planck.Body;
  private leftWall: planck.Body | null = null;
  private rightWall: planck.Body | null = null;
  private leftRadius = 5;
  private rightRadius = 5;
  private leftFixtureKey = "";
  private rightFixtureKey = "";

  private smoothedLeft: Point[] | null = null;
  private smoothedRight: Point[] | null = null;
  private leftPrevBasis: EyeBasis | null = null;
  private rightPrevBasis: EyeBasis | null = null;

  private leftAlpha = 0;
  private rightAlpha = 0;
  private leftClosed = false;
  private rightClosed = false;

  private spawned = false;

  // Per-eye cumulative real-world travel of the marbles.
  private leftDistanceM = 0;
  private rightDistanceM = 0;
  private leftLastPx: Point | null = null;
  private rightLastPx: Point | null = null;

  constructor(world: planck.World, params: PhysicsParams) {
    this.world = world;
    this.params = params;

    this.leftBall = this.world.createDynamicBody({
      position: planck.Vec2(0, 0),
      fixedRotation: true,
      linearDamping: params.linearDamping,
    });
    this.rightBall = this.world.createDynamicBody({
      position: planck.Vec2(0, 0),
      fixedRotation: true,
      linearDamping: params.linearDamping,
    });
    this.applyFixture(this.leftBall, this.leftRadius, "left");
    this.applyFixture(this.rightBall, this.rightRadius, "right");
  }

  private applyFixture(ball: planck.Body, radius: number, side: "left" | "right") {
    const p = this.params;
    const key = `${radius.toFixed(2)}|${p.density}|${p.friction}|${p.restitution}`;
    const last = side === "left" ? this.leftFixtureKey : this.rightFixtureKey;
    if (key === last) return;

    const old = ball.getFixtureList();
    if (old) ball.destroyFixture(old);
    ball.createFixture({
      shape: new planck.Circle(radius / SCALE),
      density: p.density,
      friction: p.friction,
      restitution: p.restitution,
    });
    if (side === "left") this.leftFixtureKey = key;
    else this.rightFixtureKey = key;
  }

  private smoothContour(
    rawPts: Point[],
    indices: number[],
    prev: Point[] | null
  ): Point[] {
    const current = indices.map((i) => rawPts[i]);
    if (!prev) return current;
    const t = this.params.landmarkSmooth;
    return current.map((p, i) => lerpPt(prev[i], p, t));
  }

  /** Trigger a re-spawn at the next update — balls go back to centroids */
  respawn() {
    this.spawned = false;
    this.leftPrevBasis = null;
    this.rightPrevBasis = null;
  }

  /** Re-express the ball's position from the prev eye-local frame into the
   *  next one, so head translation, rotation, and scale all carry the ball
   *  along. `eyeDrag` (0..1) blends between world-space (0) and full
   *  eye-frame follow (1). */
  private followEye(
    ball: planck.Body,
    prev: EyeBasis | null,
    next: EyeBasis
  ) {
    if (!prev) return;
    // Skip if scale changed wildly (face appeared/disappeared, glitch).
    const ratio = next.w / prev.w;
    if (ratio > 2 || ratio < 0.5) return;

    const drag = this.params.eyeDrag;
    const pos = ball.getPosition();
    const wx = pos.x * SCALE;
    const wy = pos.y * SCALE;
    const dx = wx - prev.c.x;
    const dy = wy - prev.c.y;

    // Local coords in PREV basis: s along axis u, t along perpendicular n=(-uy, ux).
    const s = (dx * prev.ux + dy * prev.uy) / prev.w;
    const t = (dx * -prev.uy + dy * prev.ux) / prev.w;

    // Re-project into NEXT basis.
    const followX = next.c.x + s * next.w * next.ux + t * next.w * -next.uy;
    const followY = next.c.y + s * next.w * next.uy + t * next.w * next.ux;

    const newX = wx + (followX - wx) * drag;
    const newY = wy + (followY - wy) * drag;
    ball.setPosition(toWorld(newX, newY));
  }

  private snapInside(ball: planck.Body, polygon: Point[], center: Point) {
    const pos = ball.getPosition();
    const px = pos.x * SCALE;
    const py = pos.y * SCALE;
    if (pointInPolygon({ x: px, y: py }, polygon)) return;

    // Find the nearest point on the polygon perimeter.
    let bestX = polygon[0].x;
    let bestY = polygon[0].y;
    let bestD2 = Infinity;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[j];
      const b = polygon[i];
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const denom = abx * abx + aby * aby || 1;
      const u = Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / denom));
      const cx = a.x + abx * u;
      const cy = a.y + aby * u;
      const d2 = (px - cx) * (px - cx) + (py - cy) * (py - cy);
      if (d2 < bestD2) {
        bestD2 = d2;
        bestX = cx;
        bestY = cy;
      }
    }

    // Pull ~10% toward the centroid so the ball lands just inside, not on the wall.
    const nx = bestX + (center.x - bestX) * 0.1;
    const ny = bestY + (center.y - bestY) * 0.1;
    ball.setPosition(toWorld(nx, ny));
    // Dampen velocity rather than zeroing it — preserves some inertia.
    const v = ball.getLinearVelocity();
    ball.setLinearVelocity(planck.Vec2(v.x * 0.5, v.y * 0.5));
  }

  /** Reposition both balls at their eye centroids with zero velocity */
  reset(pts: Point[]) {
    const lc = centroid(pts, LEFT_EYE);
    const rc = centroid(pts, RIGHT_EYE);
    this.leftBall.setPosition(toWorld(lc.x, lc.y));
    this.rightBall.setPosition(toWorld(rc.x, rc.y));
    this.leftBall.setLinearVelocity(planck.Vec2(0, 0));
    this.rightBall.setLinearVelocity(planck.Vec2(0, 0));
  }

  update(pts: Point[], dt: number) {
    const p = this.params;
    this.leftBall.setLinearDamping(p.linearDamping);
    this.rightBall.setLinearDamping(p.linearDamping);

    this.smoothedLeft = this.smoothContour(pts, LEFT_EYE, this.smoothedLeft);
    this.smoothedRight = this.smoothContour(pts, RIGHT_EYE, this.smoothedRight);
    if (p.eyeDilate !== 0) {
      this.smoothedLeft = dilatePolygon(this.smoothedLeft, p.eyeDilate);
      this.smoothedRight = dilatePolygon(this.smoothedRight, p.eyeDilate);
    }

    const rEar = eyeAspectRatio(
      pts,
      RIGHT_EYE_UPPER_MID,
      RIGHT_EYE_LOWER_MID,
      RIGHT_EYE_OUTER,
      RIGHT_EYE_INNER
    );
    const lEar = eyeAspectRatio(
      pts,
      LEFT_EYE_UPPER_MID,
      LEFT_EYE_LOWER_MID,
      LEFT_EYE_OUTER,
      LEFT_EYE_INNER
    );
    this.rightClosed = rEar < p.earClosedThreshold;
    this.leftClosed = lEar < p.earClosedThreshold;

    const k = 1 - Math.exp(-Math.max(dt, 0) / p.alphaTimeConstant);
    this.rightAlpha += ((this.rightClosed ? 0 : 1) - this.rightAlpha) * k;
    this.leftAlpha += ((this.leftClosed ? 0 : 1) - this.leftAlpha) * k;

    if (!this.spawned) {
      this.reset(pts);
      this.spawned = true;
    }

    const rh = dist(pts[RIGHT_EYE_UPPER_MID], pts[RIGHT_EYE_LOWER_MID]);
    const lh = dist(pts[LEFT_EYE_UPPER_MID], pts[LEFT_EYE_LOWER_MID]);
    const rWidth = dist(pts[RIGHT_EYE_OUTER], pts[RIGHT_EYE_INNER]);
    const lWidth = dist(pts[LEFT_EYE_OUTER], pts[LEFT_EYE_INNER]);
    const newRightRadius = Math.max(
      (this.rightClosed ? rWidth * 0.25 : rh) * p.eyeSizeRatio,
      0.5
    );
    const newLeftRadius = Math.max(
      (this.leftClosed ? lWidth * 0.25 : lh) * p.eyeSizeRatio,
      0.5
    );
    // Threshold scales with current size so small balls update at small steps.
    const rThresh = Math.max(0.25, this.rightRadius * 0.1);
    const lThresh = Math.max(0.25, this.leftRadius * 0.1);
    if (Math.abs(newRightRadius - this.rightRadius) > rThresh) {
      this.rightRadius = newRightRadius;
    }
    if (Math.abs(newLeftRadius - this.leftRadius) > lThresh) {
      this.leftRadius = newLeftRadius;
    }
    this.applyFixture(this.leftBall, this.leftRadius, "left");
    this.applyFixture(this.rightBall, this.rightRadius, "right");

    const leftBasis = computeBasis(this.smoothedLeft!);
    const rightBasis = computeBasis(this.smoothedRight!);

    if (this.leftClosed) {
      if (this.leftWall) {
        this.world.destroyBody(this.leftWall);
        this.leftWall = null;
      }
      this.leftBall.setPosition(toWorld(leftBasis.c.x, leftBasis.c.y));
      this.leftBall.setLinearVelocity(planck.Vec2(0, 0));
    } else {
      this.followEye(this.leftBall, this.leftPrevBasis, leftBasis);
      this.rebuildWall("left", this.smoothedLeft!);
      this.snapInside(this.leftBall, this.smoothedLeft!, leftBasis.c);
      this.softClamp(this.leftBall, pts, LEFT_EYE, lWidth);
    }
    this.leftPrevBasis = leftBasis;

    if (this.rightClosed) {
      if (this.rightWall) {
        this.world.destroyBody(this.rightWall);
        this.rightWall = null;
      }
      this.rightBall.setPosition(toWorld(rightBasis.c.x, rightBasis.c.y));
      this.rightBall.setLinearVelocity(planck.Vec2(0, 0));
    } else {
      this.followEye(this.rightBall, this.rightPrevBasis, rightBasis);
      this.rebuildWall("right", this.smoothedRight!);
      this.snapInside(this.rightBall, this.smoothedRight!, rightBasis.c);
      this.softClamp(this.rightBall, pts, RIGHT_EYE, rWidth);
    }
    this.rightPrevBasis = rightBasis;

    this.accumulateTravel(pts);
  }

  /** Add the per-frame ball displacement to the running total, converting
   *  pixels to meters via the current face width. Skips frames where either
   *  ball jumped more than half a face width — that's a teleport (respawn,
   *  blink reset, snap-into-socket), not real travel. */
  private accumulateTravel(pts: Point[]) {
    const faceWidthPx = dist(pts[FACE_WIDTH_RIGHT], pts[FACE_WIDTH_LEFT]);
    const lp = this.leftBall.getPosition();
    const rp = this.rightBall.getPosition();
    const lx = lp.x * SCALE;
    const ly = lp.y * SCALE;
    const rx = rp.x * SCALE;
    const ry = rp.y * SCALE;

    if (faceWidthPx > 1) {
      const pxToM = FACE_WIDTH_M / faceWidthPx;
      const maxJump = faceWidthPx * 0.5;
      if (this.leftLastPx && !this.leftClosed) {
        const d = Math.hypot(
          lx - this.leftLastPx.x,
          ly - this.leftLastPx.y
        );
        if (d < maxJump) this.leftDistanceM += d * pxToM;
      }
      if (this.rightLastPx && !this.rightClosed) {
        const d = Math.hypot(
          rx - this.rightLastPx.x,
          ry - this.rightLastPx.y
        );
        if (d < maxJump) this.rightDistanceM += d * pxToM;
      }
    }

    this.leftLastPx = { x: lx, y: ly };
    this.rightLastPx = { x: rx, y: ry };
  }

  getLeftDistanceM(): number {
    return this.leftDistanceM;
  }

  getRightDistanceM(): number {
    return this.rightDistanceM;
  }

  /** Seed the running counters — used when restoring a known face from memory. */
  setDistances(leftM: number, rightM: number) {
    this.leftDistanceM = leftM;
    this.rightDistanceM = rightM;
  }

  private rebuildWall(side: "left" | "right", contour: Point[]) {
    const existing = side === "left" ? this.leftWall : this.rightWall;
    if (existing) this.world.destroyBody(existing);
    const body = this.world.createBody();
    // Reverse winding so chain normals face inward
    const verts = contour.map((p) => toWorld(p.x, p.y)).reverse();
    body.createFixture({
      shape: new planck.Chain(verts, true),
      friction: this.params.friction,
    });
    if (side === "left") this.leftWall = body;
    else this.rightWall = body;
  }

  private softClamp(
    ball: planck.Body,
    pts: Point[],
    eyeIndices: number[],
    eyeSize: number
  ) {
    const s = this.params.springStrength;
    if (s <= 0) return;

    // Deadzone is most of the socket — spring only kicks near the edge.
    const deadzone = eyeSize * 0.4;
    const c = centroid(pts, eyeIndices);
    const pos = ball.getPosition();
    const px = pos.x * SCALE;
    const py = pos.y * SCALE;
    const d = Math.hypot(px - c.x, py - c.y);
    if (d <= deadzone) return;

    const fx = ((c.x - px) / SCALE) * s;
    const fy = ((c.y - py) / SCALE) * s;
    ball.applyForceToCenter(planck.Vec2(fx, fy));
  }

  getSmoothedContours(): { left: Point[]; right: Point[] } {
    return {
      left: this.smoothedLeft ?? [],
      right: this.smoothedRight ?? [],
    };
  }

  draw(renderer: GLEyeRenderer) {
    if (this.leftAlpha > 0.01) {
      const lp = this.leftBall.getPosition();
      renderer.drawEye({
        cx: lp.x * SCALE,
        cy: lp.y * SCALE,
        radius: this.leftRadius,
        alpha: this.leftAlpha,
      });
    }

    if (this.rightAlpha > 0.01) {
      const rp = this.rightBall.getPosition();
      renderer.drawEye({
        cx: rp.x * SCALE,
        cy: rp.y * SCALE,
        radius: this.rightRadius,
        alpha: this.rightAlpha,
      });
    }
  }

  dispose() {
    if (this.leftWall) {
      this.world.destroyBody(this.leftWall);
      this.leftWall = null;
    }
    if (this.rightWall) {
      this.world.destroyBody(this.rightWall);
      this.rightWall = null;
    }
    this.world.destroyBody(this.leftBall);
    this.world.destroyBody(this.rightBall);
  }
}
