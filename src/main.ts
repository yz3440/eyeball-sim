import { Pane } from "tweakpane";
import { createFaceLandmarker } from "./faceLandmarker";
import { fillEyesWhite, Point } from "./faceRenderer";
import {
  EyeballSystem,
  DEFAULT_PHYSICS_PARAMS,
  PhysicsParams,
} from "./physicsEyeballs";
import { FaceTracker, TrackedFace } from "./faceTracker";
import { FACE_OVAL } from "./landmarks";

interface VisualParams {
  colorOnlyFace: boolean;
  grayscaleStrength: number;
  rotation: number; // degrees, clockwise
  imageScale: number; // 1 = auto-fit (contain); >1 zooms in
  mirror: boolean;
}

interface ViewTransform {
  cos: number;
  sin: number;
  rad: number;
  scale: number; // total source→canvas scale (auto-fit × user)
  vW: number; // source video width
  vH: number;
  cW: number; // canvas width
  cH: number;
  mirror: number; // -1 or 1
}

const STORAGE_KEY = "eyeball-sim/settings/v1";
const DEFAULT_VISUAL_PARAMS: VisualParams = {
  colorOnlyFace: true,
  grayscaleStrength: 1,
  rotation: 0,
  imageScale: 1,
  mirror: true,
};
const DEFAULT_MIN_FACE_WIDTH = 60;

interface StoredSettings {
  physics?: Partial<PhysicsParams>;
  visual?: Partial<VisualParams>;
  minFaceWidth?: number;
  deviceId?: string;
}

function loadSettings(): StoredSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSettings) : null;
  } catch {
    return null;
  }
}

function saveSettings(
  physics: PhysicsParams,
  visual: VisualParams,
  minFaceWidth: number,
  deviceId: string | null
) {
  try {
    const data: StoredSettings = {
      physics: { ...physics },
      visual: { ...visual },
      minFaceWidth,
      ...(deviceId ? { deviceId } : {}),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // localStorage may be unavailable (private mode, quota); ignore.
  }
}

async function openCameraStream(
  deviceId: string | null
): Promise<MediaStream> {
  const constraints: MediaStreamConstraints = {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      ...(deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "user" }),
    },
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

async function main() {
  const video = document.getElementById("video") as HTMLVideoElement;
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const loading = document.getElementById("loading") as HTMLDivElement;
  const ctx = canvas.getContext("2d")!;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener("resize", resize);

  const stored = loadSettings();
  let currentDeviceId: string | null = stored?.deviceId ?? null;

  let currentStream: MediaStream;
  try {
    currentStream = await openCameraStream(currentDeviceId);
  } catch {
    // Saved device is gone or denied — fall back to any user-facing camera.
    currentDeviceId = null;
    currentStream = await openCameraStream(null);
  }
  // Lock in the actual deviceId we ended up with.
  const activeTrack = currentStream.getVideoTracks()[0];
  if (activeTrack) currentDeviceId = activeTrack.getSettings().deviceId ?? null;

  video.srcObject = currentStream;
  await new Promise<void>((resolve) => {
    video.onloadeddata = () => resolve();
  });

  const faceLandmarker = await createFaceLandmarker();
  loading.style.display = "none";

  const physicsParams: PhysicsParams = { ...DEFAULT_PHYSICS_PARAMS };
  const visualParams: VisualParams = { ...DEFAULT_VISUAL_PARAMS };

  if (stored?.physics) Object.assign(physicsParams, stored.physics);
  if (stored?.visual) Object.assign(visualParams, stored.visual);

  const system = new EyeballSystem(physicsParams);
  const tracker = new FaceTracker(system);
  if (typeof stored?.minFaceWidth === "number") {
    tracker.minFaceWidth = stored.minFaceWidth;
  }

  const pane = new Pane({ title: "controls (tab to hide)" });
  const phys = pane.addFolder({ title: "physics" });
  phys.addBinding(physicsParams, "gravity", { min: -30, max: 50, step: 0.5 });
  phys.addBinding(physicsParams, "linearDamping", {
    min: 0,
    max: 10,
    step: 0.1,
    label: "damping",
  });
  phys.addBinding(physicsParams, "restitution", {
    min: 0,
    max: 1,
    step: 0.05,
    label: "bounce",
  });
  phys.addBinding(physicsParams, "friction", { min: 0, max: 2, step: 0.05 });
  phys.addBinding(physicsParams, "density", { min: 0.1, max: 5, step: 0.1 });
  phys.addBinding(physicsParams, "springStrength", {
    min: 0,
    max: 200,
    step: 1,
    label: "spring",
  });
  phys.addBinding(physicsParams, "eyeDrag", {
    min: 0,
    max: 1,
    step: 0.05,
    label: "eye drag",
  });

  const eye = pane.addFolder({ title: "eye" });
  eye.addBinding(physicsParams, "eyeballSizeRatio", {
    min: 0.1,
    max: 0.7,
    step: 0.01,
    label: "ball size",
  });
  eye.addBinding(physicsParams, "landmarkSmooth", {
    min: 0,
    max: 1,
    step: 0.05,
    label: "smoothing",
  });
  eye.addBinding(physicsParams, "earClosedThreshold", {
    min: 0.05,
    max: 0.4,
    step: 0.01,
    label: "blink threshold",
  });
  eye.addBinding(physicsParams, "alphaTimeConstant", {
    min: 0.01,
    max: 0.5,
    step: 0.01,
    label: "fade time",
  });

  const view = pane.addFolder({ title: "view" });
  view.addBinding(visualParams, "rotation", {
    min: 0,
    max: 360,
    step: 1,
    label: "rotation°",
  });
  view.addBinding(visualParams, "imageScale", {
    min: 0.2,
    max: 3,
    step: 0.05,
    label: "scale",
  });
  view.addBinding(visualParams, "mirror", { label: "mirror" });

  const vis = pane.addFolder({ title: "visual" });
  vis.addBinding(visualParams, "colorOnlyFace", { label: "color faces only" });
  vis.addBinding(visualParams, "grayscaleStrength", {
    min: 0,
    max: 1,
    step: 0.05,
    label: "bg grayscale",
  });

  const trk = pane.addFolder({ title: "tracking" });
  trk.addBinding(tracker, "minFaceWidth", {
    min: 0,
    max: 600,
    step: 1,
    label: "min face px",
  });

  let switching = false;
  async function switchCamera() {
    if (switching) return;
    switching = true;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === "videoinput");
      if (cams.length < 2) return;
      const idx = Math.max(
        0,
        cams.findIndex((d) => d.deviceId === currentDeviceId)
      );
      const next = cams[(idx + 1) % cams.length];

      currentStream.getTracks().forEach((t) => t.stop());
      try {
        currentStream = await openCameraStream(next.deviceId);
        currentDeviceId = next.deviceId;
      } catch {
        // New device failed; reacquire whatever was working before.
        currentStream = await openCameraStream(currentDeviceId);
      }
      video.srcObject = currentStream;
      await new Promise<void>((resolve) => {
        video.onloadeddata = () => resolve();
      });
      saveSettings(
        physicsParams,
        visualParams,
        tracker.minFaceWidth,
        currentDeviceId
      );
    } finally {
      switching = false;
    }
  }

  pane.addButton({ title: "switch camera" }).on("click", () => {
    switchCamera().catch((err) => console.error("switchCamera failed", err));
  });

  pane.addButton({ title: "reset eyeballs" }).on("click", () => {
    tracker.resetAll();
  });

  pane.addButton({ title: "reset settings to defaults" }).on("click", () => {
    Object.assign(physicsParams, DEFAULT_PHYSICS_PARAMS);
    Object.assign(visualParams, DEFAULT_VISUAL_PARAMS);
    tracker.minFaceWidth = DEFAULT_MIN_FACE_WIDTH;
    pane.refresh();
    saveSettings(
      physicsParams,
      visualParams,
      tracker.minFaceWidth,
      currentDeviceId
    );
  });

  pane.on("change", () => {
    saveSettings(
      physicsParams,
      visualParams,
      tracker.minFaceWidth,
      currentDeviceId
    );
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const el = pane.element as HTMLElement;
      el.style.display = el.style.display === "none" ? "" : "none";
    }
  });

  function buildTransform(): ViewTransform {
    const rad = (visualParams.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const vW = video.videoWidth || 1;
    const vH = video.videoHeight || 1;
    const cW = canvas.width;
    const cH = canvas.height;
    const rotW = Math.abs(cos) * vW + Math.abs(sin) * vH;
    const rotH = Math.abs(sin) * vW + Math.abs(cos) * vH;
    const fit = Math.min(cW / rotW, cH / rotH);
    const scale = fit * visualParams.imageScale;
    return {
      cos,
      sin,
      rad,
      scale,
      vW,
      vH,
      cW,
      cH,
      mirror: visualParams.mirror ? -1 : 1,
    };
  }

  function pointToCanvas(srcX: number, srcY: number, t: ViewTransform): Point {
    let x = srcX - t.vW / 2;
    let y = srcY - t.vH / 2;
    x *= t.mirror;
    const rx = x * t.cos - y * t.sin;
    const ry = x * t.sin + y * t.cos;
    return {
      x: rx * t.scale + t.cW / 2,
      y: ry * t.scale + t.cH / 2,
    };
  }

  function applyVideoTransform(c: CanvasRenderingContext2D, t: ViewTransform) {
    c.translate(t.cW / 2, t.cH / 2);
    c.scale(t.scale, t.scale);
    c.rotate(t.rad);
    c.scale(t.mirror, 1);
    c.translate(-t.vW / 2, -t.vH / 2);
  }

  let lastVideoTime = -1;
  let lastTime = performance.now();

  function drawBackground(faces: TrackedFace[], t: ViewTransform) {
    if (visualParams.colorOnlyFace) {
      ctx.save();
      ctx.filter = `grayscale(${visualParams.grayscaleStrength})`;
      applyVideoTransform(ctx, t);
      ctx.drawImage(video, 0, 0);
      ctx.restore();

      for (const f of faces) {
        ctx.save();
        traceFaceOval(ctx, f.landmarks);
        ctx.clip();
        applyVideoTransform(ctx, t);
        ctx.drawImage(video, 0, 0);
        ctx.restore();
      }
    } else {
      ctx.save();
      applyVideoTransform(ctx, t);
      ctx.drawImage(video, 0, 0);
      ctx.restore();
    }
  }

  function loop() {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;

      const result = faceLandmarker.detectForVideo(video, performance.now());

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const t = buildTransform();
      const facesPx: Point[][] = result.faceLandmarks.map((lm) =>
        lm.map((p) => pointToCanvas(p.x * t.vW, p.y * t.vH, t))
      );

      const faces = tracker.update(facesPx, dt);
      system.step(dt);

      drawBackground(faces, t);

      for (const f of faces) {
        const { left, right } = f.person.getSmoothedContours();
        fillEyesWhite(ctx, left, right);
        f.person.draw(ctx);
      }
    }

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

function traceFaceOval(ctx: CanvasRenderingContext2D, pts: Point[]) {
  ctx.beginPath();
  const first = pts[FACE_OVAL[0]];
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < FACE_OVAL.length; i++) {
    const p = pts[FACE_OVAL[i]];
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
}

main().catch(console.error);
