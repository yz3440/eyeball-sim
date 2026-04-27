import { EyeballSystem, PersonEyeballs } from "./physicsEyeballs";
import { Point } from "./faceRenderer";
import { FACE_OVAL } from "./landmarks";

const PRUNE_FRAMES = 30;
const MATCH_THRESHOLD_PX = 150;

export interface TrackedFace {
  id: number;
  landmarks: Point[];
  person: PersonEyeballs;
}

interface Entry {
  id: number;
  person: PersonEyeballs;
  lastCentroid: Point;
  framesSinceSeen: number;
}

function faceCentroid(pts: Point[]): Point {
  let cx = 0,
    cy = 0;
  for (const i of FACE_OVAL) {
    cx += pts[i].x;
    cy += pts[i].y;
  }
  return { x: cx / FACE_OVAL.length, y: cy / FACE_OVAL.length };
}

export class FaceTracker {
  /** Faces whose FACE_OVAL bbox width is smaller than this (in pixels) are
   *  ignored — too small to render eyes meaningfully. */
  minFaceWidth = 60;

  private system: EyeballSystem;
  private tracked: Entry[] = [];
  private nextId = 1;

  constructor(system: EyeballSystem) {
    this.system = system;
  }

  update(
    detected: { x: number; y: number }[][],
    W: number,
    H: number,
    dt: number
  ): TrackedFace[] {
    const faces: Point[][] = [];
    for (const lm of detected) {
      const pts: Point[] = lm.map((p) => ({ x: (1 - p.x) * W, y: p.y * H }));
      let minX = Infinity,
        maxX = -Infinity;
      for (const i of FACE_OVAL) {
        if (pts[i].x < minX) minX = pts[i].x;
        if (pts[i].x > maxX) maxX = pts[i].x;
      }
      if (maxX - minX >= this.minFaceWidth) faces.push(pts);
    }
    const centroids = faces.map(faceCentroid);

    const claimed = new Set<Entry>();
    const detToEntry: (Entry | null)[] = faces.map(() => null);

    for (let di = 0; di < faces.length; di++) {
      let best: Entry | null = null;
      let bestDist = MATCH_THRESHOLD_PX;
      for (const e of this.tracked) {
        if (claimed.has(e)) continue;
        const d = Math.hypot(
          e.lastCentroid.x - centroids[di].x,
          e.lastCentroid.y - centroids[di].y
        );
        if (d < bestDist) {
          best = e;
          bestDist = d;
        }
      }
      if (best) {
        claimed.add(best);
        detToEntry[di] = best;
      }
    }

    for (const e of this.tracked) {
      if (claimed.has(e)) e.framesSinceSeen = 0;
      else e.framesSinceSeen++;
    }

    for (let di = 0; di < faces.length; di++) {
      if (!detToEntry[di]) {
        const e: Entry = {
          id: this.nextId++,
          person: this.system.createPerson(),
          lastCentroid: centroids[di],
          framesSinceSeen: 0,
        };
        this.tracked.push(e);
        detToEntry[di] = e;
      }
    }

    const result: TrackedFace[] = [];
    for (let di = 0; di < faces.length; di++) {
      const e = detToEntry[di]!;
      e.lastCentroid = centroids[di];
      e.person.update(faces[di], dt);
      result.push({ id: e.id, landmarks: faces[di], person: e.person });
    }

    this.tracked = this.tracked.filter((e) => {
      if (e.framesSinceSeen > PRUNE_FRAMES) {
        this.system.destroyPerson(e.person);
        return false;
      }
      return true;
    });

    return result;
  }

  resetAll() {
    for (const e of this.tracked) e.person.respawn();
  }
}
