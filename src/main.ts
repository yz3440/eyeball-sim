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
import { GLEyeRenderer } from "./glEyeRenderer";

interface VisualParams {
  colorOnlyFace: boolean;
  grayscaleStrength: number;
  rotation: number; // degrees, clockwise
  imageScale: number; // 1 = auto-fit (contain); >1 zooms in
  mirror: boolean;
  showDebug: boolean;
}

interface ViewTransform {
  cos: number;
  sin: number;
  rad: number;
  scale: number; // total source→canvas scale (auto-fit × user)
  vW: number; // source video width
  vH: number;
  rotW: number; // rotated-frame width
  rotH: number; // rotated-frame height
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
  showDebug: false,
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
  const glCanvas = document.getElementById("gl") as HTMLCanvasElement;
  const loading = document.getElementById("loading") as HTMLDivElement;
  const ctx = canvas.getContext("2d")!;
  const eyeRenderer = new GLEyeRenderer(glCanvas);

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    eyeRenderer.resize(window.innerWidth, window.innerHeight);
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
  vis.addBinding(visualParams, "showDebug", { label: "debug overlay" });

  const trk = pane.addFolder({ title: "tracking" });
  trk.addBinding(tracker, "minFaceWidth", {
    min: 0,
    max: 600,
    step: 1,
    label: "min face px",
  });

  let switching = false;
  async function switchCameraTo(deviceId: string) {
    if (switching || !deviceId || deviceId === currentDeviceId) return;
    switching = true;
    try {
      currentStream.getTracks().forEach((t) => t.stop());
      try {
        currentStream = await openCameraStream(deviceId);
        currentDeviceId = deviceId;
      } catch {
        // New device failed; reacquire whatever was working before.
        currentStream = await openCameraStream(currentDeviceId);
        cameraSel.deviceId = currentDeviceId ?? "";
        pane.refresh();
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

  const cameraSel = { deviceId: currentDeviceId ?? "" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cameraBinding: any = null;

  async function rebuildCameraList() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const cams = devs.filter((d) => d.kind === "videoinput");
    if (cams.length === 0) return;

    const options: Record<string, string> = {};
    cams.forEach((c, i) => {
      const label = c.label || `camera ${i + 1}`;
      options[label] = c.deviceId;
    });

    if (!cams.some((c) => c.deviceId === cameraSel.deviceId)) {
      cameraSel.deviceId = currentDeviceId ?? cams[0].deviceId;
    }

    if (cameraBinding) cameraBinding.dispose();
    cameraBinding = view.addBinding(cameraSel, "deviceId", {
      label: "camera",
      options,
      index: 0,
    });
    cameraBinding.on("change", (ev: { value: string }) => {
      switchCameraTo(ev.value).catch((err) =>
        console.error("switchCameraTo failed", err)
      );
    });
  }

  rebuildCameraList().catch((err) =>
    console.error("rebuildCameraList failed", err)
  );
  navigator.mediaDevices.addEventListener("devicechange", () => {
    rebuildCameraList().catch((err) =>
      console.error("rebuildCameraList failed", err)
    );
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
      rotW,
      rotH,
      cW,
      cH,
      mirror: visualParams.mirror ? -1 : 1,
    };
  }

  // Maps a point in the rotated-detector-canvas frame to the display canvas.
  function pointToCanvas(rotX: number, rotY: number, t: ViewTransform): Point {
    return {
      x: (rotX - t.rotW / 2) * t.scale + t.cW / 2,
      y: (rotY - t.rotH / 2) * t.scale + t.cH / 2,
    };
  }

  function applyVideoTransform(c: CanvasRenderingContext2D, t: ViewTransform) {
    c.translate(t.cW / 2, t.cH / 2);
    c.scale(t.scale, t.scale);
    c.rotate(t.rad);
    c.scale(t.mirror, 1);
    c.translate(-t.vW / 2, -t.vH / 2);
  }

  // Offscreen canvas holding the rotated+mirrored video frame fed to the
  // landmarker. Rotating the input lets the network see an upright face when
  // the user has tilted the view.
  const detectorCanvas = document.createElement("canvas");
  const detectorCtx = detectorCanvas.getContext("2d")!;

  function renderDetectorFrame(t: ViewTransform) {
    const w = Math.max(1, Math.ceil(t.rotW));
    const h = Math.max(1, Math.ceil(t.rotH));
    if (detectorCanvas.width !== w) detectorCanvas.width = w;
    if (detectorCanvas.height !== h) detectorCanvas.height = h;
    detectorCtx.setTransform(1, 0, 0, 1, 0, 0);
    detectorCtx.clearRect(0, 0, w, h);
    detectorCtx.translate(w / 2, h / 2);
    detectorCtx.rotate(t.rad);
    detectorCtx.scale(t.mirror, 1);
    detectorCtx.translate(-t.vW / 2, -t.vH / 2);
    detectorCtx.drawImage(video, 0, 0);
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

      const t = buildTransform();
      renderDetectorFrame(t);
      const result = faceLandmarker.detectForVideo(
        detectorCanvas,
        performance.now()
      );

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const facesPx: Point[][] = result.faceLandmarks.map((lm) =>
        lm.map((p) => pointToCanvas(p.x * t.rotW, p.y * t.rotH, t))
      );

      const faces = tracker.update(facesPx, dt);
      system.step(dt);

      drawBackground(faces, t);

      for (const f of faces) {
        const { left, right } = f.person.getSmoothedContours();
        fillEyesWhite(ctx, left, right);
      }

      eyeRenderer.beginFrame();
      for (const f of faces) {
        f.person.draw(eyeRenderer);
      }

      if (visualParams.showDebug) {
        drawDebugOverlay(ctx, faces);
      }
    }

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

function drawDebugOverlay(ctx: CanvasRenderingContext2D, faces: TrackedFace[]) {
  ctx.save();
  for (const f of faces) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of f.landmarks) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    ctx.fillStyle = "rgba(0, 255, 120, 0.85)";
    for (const p of f.landmarks) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(255, 80, 200, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

    ctx.fillStyle = "rgba(255, 80, 200, 0.9)";
    ctx.font = "11px monospace";
    ctx.textBaseline = "bottom";
    ctx.fillText(`#${f.id}`, minX, minY - 2);
  }
  ctx.restore();
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
