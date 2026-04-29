import { EyeSystem, PersonEyes } from "./physicsEyes";
import { Point } from "./faceRenderer";
import { FACE_OVAL } from "./landmarks";
import { FaceMemory, FaceRecord } from "./faceMemory";

const PRUNE_FRAMES = 30;
const MATCH_THRESHOLD_PX = 150;

export interface TrackedFace {
  id: number;
  landmarks: Point[];
  person: PersonEyes;
}

interface Entry {
  id: number;
  person: PersonEyes;
  lastCentroid: Point;
  framesSinceSeen: number;
  /** localStorage-backed record for this face. We push counter updates into it
   *  so the tally survives detector drops and page reloads. */
  record: FaceRecord;
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

/** FACE_OVAL bbox in the same coordinate space as `pts`. `diag` is the bbox
 *  diagonal — rotation-invariant, used to threshold face size. */
export function faceBBox(pts: Point[]) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const i of FACE_OVAL) {
    if (pts[i].x < minX) minX = pts[i].x;
    if (pts[i].x > maxX) maxX = pts[i].x;
    if (pts[i].y < minY) minY = pts[i].y;
    if (pts[i].y > maxY) maxY = pts[i].y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    w,
    h,
    diag: Math.hypot(w, h),
  };
}

export class FaceTracker {
  /** Faces whose FACE_OVAL bbox width is smaller than this (in pixels) are
   *  ignored — too small to render eyes meaningfully. */
  minFaceWidth = 60;

  private system: EyeSystem;
  private memory: FaceMemory;
  private tracked: Entry[] = [];

  constructor(system: EyeSystem, memory: FaceMemory) {
    this.system = system;
    this.memory = memory;
  }

  /** `detected` must already be in canvas pixel space (mirroring/rotation
   *  applied by the caller). */
  update(detected: Point[][], dt: number): TrackedFace[] {
    const faces: Point[][] = [];
    for (const pts of detected) {
      if (faceBBox(pts).diag >= this.minFaceWidth) faces.push(pts);
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
        // Consult persistent memory: if this face matches a known signature,
        // we adopt that ID and seed the marble counters from the stored tally.
        const record = this.memory.identify(faces[di]);
        const person = this.system.createPerson();
        person.setDistances(record.leftDistanceM, record.rightDistanceM);
        const e: Entry = {
          id: record.id,
          person,
          lastCentroid: centroids[di],
          framesSinceSeen: 0,
          record,
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
      // Mirror the live counters into the persistent record.
      e.record.leftDistanceM = e.person.getLeftDistanceM();
      e.record.rightDistanceM = e.person.getRightDistanceM();
      e.record.lastSeenAt = Date.now();
      this.memory.markUpdated();
      result.push({ id: e.id, landmarks: faces[di], person: e.person });
    }

    this.tracked = this.tracked.filter((e) => {
      if (e.framesSinceSeen > PRUNE_FRAMES) {
        this.system.destroyPerson(e.person);
        return false;
      }
      return true;
    });

    this.memory.flush();
    return result;
  }

  resetAll() {
    for (const e of this.tracked) {
      e.person.respawn();
      e.person.setDistances(0, 0);
      e.record.leftDistanceM = 0;
      e.record.rightDistanceM = 0;
    }
    this.memory.markUpdated();
  }

  /** Drop in-flight tracking after the persistent roster has been wiped. */
  forgetAll() {
    for (const e of this.tracked) this.system.destroyPerson(e.person);
    this.tracked = [];
  }
}
