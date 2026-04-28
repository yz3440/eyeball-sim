import { Point } from "./faceRenderer";
import {
  SIGNATURE_LENGTH,
  computeFaceSignature,
  signatureDistance,
} from "./faceSignature";

const STORAGE_KEY = "eyeball-sim/faces/v1";
const MAX_ENTRIES = 32;
const STALE_MS = 1000 * 60 * 60 * 24 * 30; // forget faces unseen for 30 days

export interface FaceRecord {
  id: number;
  /** Cluster of signature variants (e.g. neutral, smiling, mouth-open) that
   *  share one identity. A new observation matches if it's within
   *  matchThreshold of *any* centroid here. */
  centroids: number[][];
  leftDistanceM: number;
  rightDistanceM: number;
  lastSeenAt: number;
}

interface StoredMemory {
  nextId: number;
  records: FaceRecord[];
}

/** Legacy v1 schema with a single signature per record. Read on load and
 *  upgraded into a one-centroid cluster. */
interface LegacyFaceRecord {
  id: number;
  signature: number[];
  leftDistanceM?: number;
  rightDistanceM?: number;
  lastSeenAt?: number;
}

/** Persistent roster of known faces, keyed by a geometric signature.
 *  Used to restore stable IDs (and counters) across detection drops and
 *  page reloads. Pure client-side: nothing leaves the browser. */
export class FaceMemory {
  /** Mean-abs-diff threshold for signature match. Smaller = stricter.
   *  Each signature component is a ratio normalized by interocular distance,
   *  so this is interpretable as "average pair-distance mismatch". */
  matchThreshold = 0.04;

  /** EMA blend rate applied when a new observation merges into an existing
   *  centroid — lets each centroid drift toward the running mean of frames
   *  hitting that expression mode. 0 = never update, 1 = replace every frame. */
  signatureLearnRate = 0.15;

  /** Cap on expression centroids stored per identity. Once full, new
   *  observations EMA-blend into the nearest centroid instead of growing. */
  maxCentroidsPerCluster = 8;

  /** Below `matchThreshold * centroidSpawnRatio` the observation merges into
   *  the nearest centroid (same expression seen again). Above it but still
   *  under matchThreshold, a new centroid is spawned for this identity. */
  centroidSpawnRatio = 0.5;

  private records: FaceRecord[] = [];
  private nextId = 1;
  private dirty = false;
  private lastSaveAt = 0;

  constructor() {
    this.load();
  }

  /** Find or create a record for a face. The returned record is mutable —
   *  callers should write distance updates into it directly. */
  identify(landmarks: Point[]): FaceRecord {
    const sig = computeFaceSignature(landmarks);
    const match = this.findMatch(sig);
    if (match) {
      this.absorbObservation(match.record, match.centroidIdx, match.dist, sig);
      match.record.lastSeenAt = Date.now();
      this.dirty = true;
      return match.record;
    }
    const record: FaceRecord = {
      id: this.nextId++,
      centroids: [Array.from(sig)],
      leftDistanceM: 0,
      rightDistanceM: 0,
      lastSeenAt: Date.now(),
    };
    this.records.push(record);
    this.evict();
    this.dirty = true;
    this.save();
    return record;
  }

  markUpdated() {
    this.dirty = true;
  }

  /** Throttled persistence — call once per frame. */
  flush(saveEveryMs = 2000) {
    if (!this.dirty) return;
    const now = Date.now();
    if (now - this.lastSaveAt < saveEveryMs) return;
    this.save();
  }

  clear() {
    this.records = [];
    this.nextId = 1;
    this.dirty = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // localStorage may be unavailable; clearing in memory is enough.
    }
  }

  size(): number {
    return this.records.length;
  }

  /** Either blend the observation into the closest centroid (same expression)
   *  or add it as a new centroid in this identity's cluster (new expression),
   *  depending on how close the match was. */
  private absorbObservation(
    record: FaceRecord,
    centroidIdx: number,
    dist: number,
    sig: Float32Array
  ) {
    const spawnAbove = this.matchThreshold * this.centroidSpawnRatio;
    const canSpawn =
      dist >= spawnAbove &&
      record.centroids.length < this.maxCentroidsPerCluster;
    if (canSpawn) {
      record.centroids.push(Array.from(sig));
      return;
    }
    const a = this.signatureLearnRate;
    if (a <= 0) return;
    const c = record.centroids[centroidIdx];
    for (let i = 0; i < sig.length; i++) {
      c[i] = c[i] * (1 - a) + sig[i] * a;
    }
  }

  private findMatch(
    sig: Float32Array
  ): { record: FaceRecord; centroidIdx: number; dist: number } | null {
    let best: { record: FaceRecord; centroidIdx: number; dist: number } | null =
      null;
    let bestD = this.matchThreshold;
    for (const r of this.records) {
      for (let i = 0; i < r.centroids.length; i++) {
        const c = r.centroids[i];
        if (c.length !== SIGNATURE_LENGTH) continue;
        const d = signatureDistance(sig, new Float32Array(c));
        if (d < bestD) {
          bestD = d;
          best = { record: r, centroidIdx: i, dist: d };
        }
      }
    }
    return best;
  }

  private evict() {
    const now = Date.now();
    this.records = this.records.filter((r) => now - r.lastSeenAt < STALE_MS);
    if (this.records.length > MAX_ENTRIES) {
      this.records.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      this.records.splice(0, this.records.length - MAX_ENTRIES);
    }
  }

  private save() {
    try {
      const data: StoredMemory = {
        nextId: this.nextId,
        records: this.records,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      this.dirty = false;
      this.lastSaveAt = Date.now();
    } catch {
      // Quota or private mode; keep in memory only.
    }
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as { nextId?: number; records?: unknown[] };
      this.nextId = typeof data.nextId === "number" ? data.nextId : 1;
      const rawRecords = Array.isArray(data.records) ? data.records : [];
      this.records = rawRecords
        .map((r) => normalizeRecord(r))
        .filter((r): r is FaceRecord => r !== null);
    } catch {
      // Bad/missing data; start fresh.
    }
  }
}

function normalizeRecord(raw: unknown): FaceRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<FaceRecord> & Partial<LegacyFaceRecord>;
  if (typeof r.id !== "number") return null;

  let centroids: number[][] = [];
  if (Array.isArray(r.centroids)) {
    centroids = r.centroids.filter(
      (c): c is number[] => Array.isArray(c) && c.length === SIGNATURE_LENGTH
    );
  } else if (Array.isArray(r.signature) && r.signature.length === SIGNATURE_LENGTH) {
    // v1 → v2 upgrade: a single signature becomes a one-centroid cluster.
    centroids = [r.signature.slice()];
  }
  if (centroids.length === 0) return null;

  return {
    id: r.id,
    centroids,
    leftDistanceM: typeof r.leftDistanceM === "number" ? r.leftDistanceM : 0,
    rightDistanceM: typeof r.rightDistanceM === "number" ? r.rightDistanceM : 0,
    lastSeenAt: typeof r.lastSeenAt === "number" ? r.lastSeenAt : Date.now(),
  };
}
