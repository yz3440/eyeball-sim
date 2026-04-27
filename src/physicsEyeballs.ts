import * as planck from "planck";
import { Point } from "./faceRenderer";
import {
  RIGHT_EYE,
  LEFT_EYE,
  RIGHT_EYE_UPPER_MID,
  RIGHT_EYE_LOWER_MID,
  LEFT_EYE_UPPER_MID,
  LEFT_EYE_LOWER_MID,
} from "./landmarks";

const SCALE = 100; // pixels per meter
const EYEBALL_SIZE_RATIO = 0.35;
const LANDMARK_SMOOTH = 0.7; // lerp factor for eye contour smoothing (higher = faster tracking)
const SPRING_STRENGTH = 50; // force pulling escaped ball back to centroid

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

export class PhysicsEyeballs {
  private world: planck.World;
  private leftBall: planck.Body;
  private rightBall: planck.Body;
  private leftWall: planck.Body | null = null;
  private rightWall: planck.Body | null = null;
  private leftRadius = 5;
  private rightRadius = 5;
  private initialized = false;
  private hadFace = false;
  private visible = false;
  private lastPts: Point[] | null = null;

  // Smoothed eye contour positions (pixel coords)
  private smoothedLeft: Point[] | null = null;
  private smoothedRight: Point[] | null = null;

  constructor() {
    this.world = new planck.World(planck.Vec2(0, 10));

    this.leftBall = this.world.createDynamicBody({
      position: planck.Vec2(0, 0),
      fixedRotation: true,
      linearDamping: 2.0,
    });
    this.leftBall.createFixture({
      shape: new planck.Circle(5 / SCALE),
      density: 1.0,
      friction: 0.3,
      restitution: 0.3,
    });

    this.rightBall = this.world.createDynamicBody({
      position: planck.Vec2(0, 0),
      fixedRotation: true,
      linearDamping: 2.0,
    });
    this.rightBall.createFixture({
      shape: new planck.Circle(5 / SCALE),
      density: 1.0,
      friction: 0.3,
      restitution: 0.3,
    });
  }

  private updateBallRadius(ball: planck.Body, newRadius: number) {
    const old = ball.getFixtureList();
    if (old) ball.destroyFixture(old);
    ball.createFixture({
      shape: new planck.Circle(newRadius / SCALE),
      density: 1.0,
      friction: 0.3,
      restitution: 0.3,
    });
  }

  private smoothContour(
    rawPts: Point[],
    indices: number[],
    prev: Point[] | null
  ): Point[] {
    const current = indices.map((i) => rawPts[i]);
    if (!prev) return current;
    return current.map((p, i) => lerpPt(prev[i], p, LANDMARK_SMOOTH));
  }

  /** Drop balls into eyes — repositions at eye centroid and makes visible */
  dropBalls() {
    this.visible = true;
    // If we have recent landmark data, reposition immediately
    if (this.lastPts) {
      const lc = centroid(this.lastPts, LEFT_EYE);
      const rc = centroid(this.lastPts, RIGHT_EYE);
      this.leftBall.setPosition(toWorld(lc.x, lc.y));
      this.rightBall.setPosition(toWorld(rc.x, rc.y));
      this.leftBall.setLinearVelocity(planck.Vec2(0, 0));
      this.rightBall.setLinearVelocity(planck.Vec2(0, 0));
    }
  }

  isVisible() {
    return this.visible;
  }

  update(pts: Point[], dt: number) {
    this.lastPts = pts;
    // Smooth eye contour landmarks
    this.smoothedLeft = this.smoothContour(pts, LEFT_EYE, this.smoothedLeft);
    this.smoothedRight = this.smoothContour(pts, RIGHT_EYE, this.smoothedRight);

    // Compute eye socket heights for dynamic eyeball sizing
    const rh = dist(pts[RIGHT_EYE_UPPER_MID], pts[RIGHT_EYE_LOWER_MID]);
    const lh = dist(pts[LEFT_EYE_UPPER_MID], pts[LEFT_EYE_LOWER_MID]);
    const newRightRadius = Math.max(rh * EYEBALL_SIZE_RATIO, 3);
    const newLeftRadius = Math.max(lh * EYEBALL_SIZE_RATIO, 3);

    if (Math.abs(newRightRadius - this.rightRadius) > 1) {
      this.rightRadius = newRightRadius;
      this.updateBallRadius(this.rightBall, this.rightRadius);
    }
    if (Math.abs(newLeftRadius - this.leftRadius) > 1) {
      this.leftRadius = newLeftRadius;
      this.updateBallRadius(this.leftBall, this.leftRadius);
    }

    // Rebuild eye socket walls from smoothed landmarks
    if (this.leftWall) this.world.destroyBody(this.leftWall);
    if (this.rightWall) this.world.destroyBody(this.rightWall);

    this.leftWall = this.world.createBody();
    // Reverse winding so chain normals face inward (contains the ball)
    const leftVerts = this.smoothedLeft.map((p) => toWorld(p.x, p.y)).reverse();
    this.leftWall.createFixture({
      shape: new planck.Chain(leftVerts, true),
      friction: 0.3,
    });

    this.rightWall = this.world.createBody();
    const rightVerts = this.smoothedRight.map((p) => toWorld(p.x, p.y)).reverse();
    this.rightWall.createFixture({
      shape: new planck.Chain(rightVerts, true),
      friction: 0.3,
    });

    // Re-place balls when face reappears after being lost
    if (this.visible && !this.hadFace) {
      const lc = centroid(pts, LEFT_EYE);
      const rc = centroid(pts, RIGHT_EYE);
      this.leftBall.setPosition(toWorld(lc.x, lc.y));
      this.rightBall.setPosition(toWorld(rc.x, rc.y));
      this.leftBall.setLinearVelocity(planck.Vec2(0, 0));
      this.rightBall.setLinearVelocity(planck.Vec2(0, 0));
      this.smoothedLeft = LEFT_EYE.map((i) => pts[i]);
      this.smoothedRight = RIGHT_EYE.map((i) => pts[i]);
    }
    this.initialized = true;
    this.hadFace = true;

    if (!this.visible) return;

    // Soft clamp: spring force pulling ball toward eye centroid if it drifts
    this.softClamp(this.leftBall, pts, LEFT_EYE);
    this.softClamp(this.rightBall, pts, RIGHT_EYE);

    // Step physics with actual dt (clamped)
    const clampedDt = Math.min(dt, 1 / 30);
    this.world.step(clampedDt, 8, 3);
  }

  private softClamp(ball: planck.Body, pts: Point[], eyeIndices: number[]) {
    const c = centroid(pts, eyeIndices);
    const pos = ball.getPosition();
    const px = pos.x * SCALE;
    const py = pos.y * SCALE;
    const d = Math.hypot(px - c.x, py - c.y);

    // Hard teleport only as last resort (very far away)
    if (d > 50) {
      ball.setPosition(toWorld(c.x, c.y));
      ball.setLinearVelocity(planck.Vec2(0, 0));
      return;
    }

    // Spring force pulling toward centroid — stronger as ball drifts further
    if (d > 5) {
      const fx = ((c.x - px) / SCALE) * SPRING_STRENGTH;
      const fy = ((c.y - py) / SCALE) * SPRING_STRENGTH;
      ball.applyForceToCenter(planck.Vec2(fx, fy));
    }
  }

  /** Call when no face is detected so next detection resets ball positions */
  noFace() {
    this.hadFace = false;
    this.smoothedLeft = null;
    this.smoothedRight = null;
  }

  /** Return the smoothed eye contours for rendering (so visuals match physics walls) */
  getSmoothedContours(): { left: Point[]; right: Point[] } {
    return {
      left: this.smoothedLeft ?? [],
      right: this.smoothedRight ?? [],
    };
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.visible) return;
    ctx.fillStyle = "black";

    const lp = this.leftBall.getPosition();
    ctx.beginPath();
    ctx.arc(lp.x * SCALE, lp.y * SCALE, this.leftRadius, 0, Math.PI * 2);
    ctx.fill();

    const rp = this.rightBall.getPosition();
    ctx.beginPath();
    ctx.arc(rp.x * SCALE, rp.y * SCALE, this.rightRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}
