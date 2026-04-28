import { Pane } from "tweakpane";
import { createFaceLandmarker } from "./faceLandmarker";
import {
  fillEyesWhite,
  Point,
  addPolygonSubpath,
  dilatePolygon,
} from "./faceRenderer";
import {
  EyeballSystem,
  DEFAULT_PHYSICS_PARAMS,
  PhysicsParams,
} from "./physicsEyeballs";
import { FaceTracker, TrackedFace } from "./faceTracker";
import { FACE_OVAL } from "./landmarks";
import { GLEyeRenderer } from "./glEyeRenderer";
import { YoloFaceDetector } from "./yoloFaceDetector";

interface VisualParams {
  colorOnlyFace: boolean;
  grayscaleStrength: number;
  rotation: number; // degrees, clockwise
  imageScale: number; // 1 = auto-fit (contain); >1 zooms in
  mirror: boolean;
  showDebug: boolean;
  faceFeather: number; // px of edge softening on the face cutout
  faceSaturation: number; // 1 = original, >1 boosts saturation inside the face
  faceDilate: number; // px to expand the face polygon outward
  eyeFeather: number; // px of edge softening on the eye-socket fill
  cropToBiggest: boolean; // post-render: zoom display to the biggest face
}

interface ViewTransform {
  cos: number;
  sin: number;
  rad: number;
  scale: number; // total source→canvas scale (auto-fit × user)
  vW: number; // source video width
  vH: number;
  detW: number; // detector input width = visible-on-display region of rotated frame
  detH: number; // detector input height
  cW: number; // canvas width
  cH: number;
  mirror: number; // -1 or 1
}

const STORAGE_KEY = "eyeball-sim/settings/v1";
const DEFAULT_VISUAL_PARAMS: VisualParams = {
  colorOnlyFace: true,
  grayscaleStrength: 0.55,
  rotation: 0,
  imageScale: 1.2,
  mirror: true,
  showDebug: false,
  faceFeather: 80,
  faceSaturation: 1.3,
  faceDilate: 24,
  eyeFeather: 9,
  cropToBiggest: false,
};
const DEFAULT_MIN_FACE_WIDTH = 185;

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

  // Origin at top-left so the crop transform math is straightforward.
  canvas.style.transformOrigin = "0 0";
  glCanvas.style.transformOrigin = "0 0";

  // Offscreen canvas used to build a soft-edged color face overlay before
  // compositing it onto the grayscale background.
  const maskCanvas = document.createElement("canvas");
  const maskCtx = maskCanvas.getContext("2d")!;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    maskCanvas.width = window.innerWidth;
    maskCanvas.height = window.innerHeight;
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

  // YOLO is the cold-start detector for small faces; it only runs when
  // MediaPipe finds nothing on the full frame. Loading it in the background
  // means we don't gate the rest of the app on it.
  const yolo = new YoloFaceDetector();
  let yoloReady = false;
  yolo
    .load()
    .then(() => {
      yoloReady = true;
    })
    .catch((err) => console.error("YOLO model load failed", err));

  // Sub-canvas used for the cropped second-pass MP inference when YOLO finds
  // a face MP missed. ~384px is enough headroom for MP's internal 256px
  // rescale without burning bandwidth.
  const SUB_DETECTOR_SIZE = 384;
  const subCanvas = document.createElement("canvas");
  subCanvas.width = SUB_DETECTOR_SIZE;
  subCanvas.height = SUB_DETECTOR_SIZE;
  const subCtx = subCanvas.getContext("2d")!;

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

  const pane = new Pane({ title: "controls (c to hide)" });
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
  eye.addBinding(physicsParams, "eyeDilate", {
    min: -10,
    max: 30,
    step: 0.5,
    label: "dilate",
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
  vis.addBinding(visualParams, "faceFeather", {
    min: 0,
    max: 100,
    step: 1,
    label: "face feather",
  });
  vis.addBinding(visualParams, "faceDilate", {
    min: -50,
    max: 100,
    step: 1,
    label: "face dilate",
  });
  vis.addBinding(visualParams, "faceSaturation", {
    min: 0,
    max: 3,
    step: 0.05,
    label: "face saturation",
  });
  vis.addBinding(visualParams, "eyeFeather", {
    min: 0,
    max: 30,
    step: 1,
    label: "eye feather",
  });
  vis.addBinding(visualParams, "showDebug", { label: "debug overlay" });
  vis.addBinding(visualParams, "cropToBiggest", { label: "zoom to face" });

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
    if (e.key === "c" || e.key === "C") {
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
    // Detector input is the part of the rotated frame that's actually visible
    // on screen at this scale. When the user zooms in (scale > fit), we crop
    // accordingly so the network sees the same view.
    const detW = Math.min(rotW, cW / scale);
    const detH = Math.min(rotH, cH / scale);
    return {
      cos,
      sin,
      rad,
      scale,
      vW,
      vH,
      detW,
      detH,
      cW,
      cH,
      mirror: visualParams.mirror ? -1 : 1,
    };
  }

  // Maps a point in the detector-canvas frame to the display canvas.
  function pointToCanvas(detX: number, detY: number, t: ViewTransform): Point {
    return {
      x: (detX - t.detW / 2) * t.scale + t.cW / 2,
      y: (detY - t.detH / 2) * t.scale + t.cH / 2,
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
  // landmarker. Sized to the visible-on-screen region so when the user zooms
  // in, the network sees the same crop and small faces fill more pixels.
  const detectorCanvas = document.createElement("canvas");
  const detectorCtx = detectorCanvas.getContext("2d")!;

  function renderDetectorFrame(t: ViewTransform) {
    const w = Math.max(1, Math.ceil(t.detW));
    const h = Math.max(1, Math.ceil(t.detH));
    if (detectorCanvas.width !== w) detectorCanvas.width = w;
    if (detectorCanvas.height !== h) detectorCanvas.height = h;
    detectorCtx.setTransform(1, 0, 0, 1, 0, 0);
    detectorCtx.clearRect(0, 0, w, h);
    // Drawing the full rotated/mirrored video centered on the detector canvas
    // naturally clips anything outside — that's the zoom crop we want.
    detectorCtx.translate(w / 2, h / 2);
    detectorCtx.rotate(t.rad);
    detectorCtx.scale(t.mirror, 1);
    detectorCtx.translate(-t.vW / 2, -t.vH / 2);
    detectorCtx.drawImage(video, 0, 0);
  }

  let lastVideoTime = -1;
  let lastTime = performance.now();

  function drawBackground(faces: TrackedFace[], t: ViewTransform) {
    if (!visualParams.colorOnlyFace) {
      ctx.save();
      applyVideoTransform(ctx, t);
      ctx.drawImage(video, 0, 0);
      ctx.restore();
      return;
    }

    // grayscale full-frame background
    ctx.save();
    ctx.filter = `grayscale(${visualParams.grayscaleStrength})`;
    applyVideoTransform(ctx, t);
    ctx.drawImage(video, 0, 0);
    ctx.restore();

    if (faces.length === 0) return;

    // Build a soft-edged color face overlay on the mask canvas:
    // 1) draw the color video, 2) keep only what's under a blurred polygon
    //    via destination-in, which produces a feathered alpha edge.
    maskCtx.save();
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    if (visualParams.faceSaturation !== 1) {
      maskCtx.filter = `saturate(${visualParams.faceSaturation})`;
    }
    applyVideoTransform(maskCtx, t);
    maskCtx.drawImage(video, 0, 0);
    maskCtx.restore();

    // Build a single combined path of all face ovals (dilated if requested)
    // and apply destination-in once. Doing it per-face would wipe earlier
    // faces from the mask canvas.
    maskCtx.save();
    maskCtx.globalCompositeOperation = "destination-in";
    if (visualParams.faceFeather > 0) {
      maskCtx.filter = `blur(${visualParams.faceFeather}px)`;
    }
    maskCtx.fillStyle = "white";
    maskCtx.beginPath();
    const dilate = visualParams.faceDilate;
    for (const f of faces) {
      let oval = FACE_OVAL.map((i) => f.landmarks[i]);
      if (dilate !== 0) oval = dilatePolygon(oval, dilate);
      addPolygonSubpath(maskCtx, oval);
    }
    maskCtx.fill();
    maskCtx.restore();

    ctx.drawImage(maskCanvas, 0, 0);
  }

  function drawEyeSockets(faces: TrackedFace[]) {
    const feather = visualParams.eyeFeather;

    if (feather <= 0) {
      for (const f of faces) {
        const { left, right } = f.person.getSmoothedContours();
        fillEyesWhite(ctx, left, right);
      }
      return;
    }

    // Render the (already gradient-shaded) eye fills to the mask canvas, then
    // mask via destination-in with a blurred polygon to feather the edges.
    maskCtx.save();
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    for (const f of faces) {
      const { left, right } = f.person.getSmoothedContours();
      fillEyesWhite(maskCtx, left, right);
    }
    maskCtx.restore();

    // Apply destination-in once with the union of both eye polygons. Doing it
    // per-polygon would wipe the other eye's content with each subsequent fill.
    maskCtx.save();
    maskCtx.globalCompositeOperation = "destination-in";
    maskCtx.filter = `blur(${feather}px)`;
    maskCtx.fillStyle = "white";
    maskCtx.beginPath();
    for (const f of faces) {
      const { left, right } = f.person.getSmoothedContours();
      if (left.length > 0) addPolygonSubpath(maskCtx, left);
      if (right.length > 0) addPolygonSubpath(maskCtx, right);
    }
    maskCtx.fill();
    maskCtx.restore();

    ctx.drawImage(maskCanvas, 0, 0);
  }

  // Smoothed bbox for the post-render zoom-to-face effect. Smoothing keeps the
  // magnified view from jittering as raw landmarks twitch frame to frame.
  let zoomCx = 0;
  let zoomCy = 0;
  let zoomW = 0;
  let zoomH = 0;
  let zoomInit = false;

  function applyZoomToFace(
    faces: TrackedFace[],
    t: ViewTransform,
    dt: number
  ) {
    if (!visualParams.cropToBiggest || faces.length === 0) {
      canvas.style.transform = "";
      glCanvas.style.transform = "";
      zoomInit = false;
      return;
    }

    let bestArea = 0;
    let bx = 0,
      by = 0,
      bw = 0,
      bh = 0;
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
      const w = maxX - minX;
      const h = maxY - minY;
      const area = w * h;
      if (area > bestArea) {
        bestArea = area;
        bx = minX;
        by = minY;
        bw = w;
        bh = h;
      }
    }
    if (bestArea === 0) {
      canvas.style.transform = "";
      glCanvas.style.transform = "";
      zoomInit = false;
      return;
    }

    const cx = bx + bw / 2;
    const cy = by + bh / 2;

    const k = 1 - Math.exp(-Math.max(dt, 0) / 0.4);
    if (!zoomInit) {
      zoomCx = cx;
      zoomCy = cy;
      zoomW = bw;
      zoomH = bh;
      zoomInit = true;
    } else {
      zoomCx += (cx - zoomCx) * k;
      zoomCy += (cy - zoomCy) * k;
      zoomW += (bw - zoomW) * k;
      zoomH += (bh - zoomH) * k;
    }

    // Video content rectangle in canvas coords. The video is drawn centered
    // and scaled by t.scale; outside this rect the canvas is empty/cleared.
    const rotW = Math.abs(t.cos) * t.vW + Math.abs(t.sin) * t.vH;
    const rotH = Math.abs(t.sin) * t.vW + Math.abs(t.cos) * t.vH;
    const contentW = rotW * t.scale;
    const contentH = rotH * t.scale;
    const contentLeft = (canvas.width - contentW) / 2;
    const contentTop = (canvas.height - contentH) / 2;
    const contentRight = contentLeft + contentW;
    const contentBottom = contentTop + contentH;

    // Pick zoom: enough to fit the face with padding, but never less than the
    // amount needed for the content rect to cover the viewport on both axes
    // (otherwise the transform would expose canvas-clear regions / letterbox).
    const padding = 1.6;
    const targetZoom = Math.min(
      canvas.width / (zoomW * padding),
      canvas.height / (zoomH * padding)
    );
    const minZoom = Math.max(
      canvas.width / contentW,
      canvas.height / contentH
    );
    const zoom = Math.max(targetZoom, minZoom);

    // Translation: aim to center the smoothed face, then clamp so the content
    // rect (post-transform) covers the viewport edges.
    const txTarget = canvas.width / 2 - zoomCx * zoom;
    const tyTarget = canvas.height / 2 - zoomCy * zoom;
    const txMin = canvas.width - contentRight * zoom;
    const txMax = -contentLeft * zoom;
    const tyMin = canvas.height - contentBottom * zoom;
    const tyMax = -contentTop * zoom;
    const tx = Math.min(Math.max(txTarget, txMin), txMax);
    const ty = Math.min(Math.max(tyTarget, tyMin), tyMax);

    const transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    canvas.style.transform = transform;
    glCanvas.style.transform = transform;
  }

  let detecting = false;
  async function loop() {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    if (!detecting && video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      detecting = true;

      const t = buildTransform();
      renderDetectorFrame(t);

      // First pass: MP on the full scale-aware detector frame. Cheap and
      // catches multi-face when faces are big enough.
      let mpResult = await faceLandmarker.detectForVideo(
        detectorCanvas,
        performance.now()
      );

      // Default mapping: landmarks come in detectorCanvas-normalized coords.
      let landmarkToDet = (p: { x: number; y: number }) => ({
        x: p.x * t.detW,
        y: p.y * t.detH,
      });

      // Cold-start fallback: only when MP saw nothing. YOLO finds the bbox,
      // we crop tightly around it and re-run MP on the crop. Skipping YOLO in
      // the steady state keeps the M1 inference budget reasonable.
      if (mpResult.faceLandmarks.length === 0 && yoloReady) {
        const yoloBoxes = await yolo.detect(detectorCanvas).catch(() => []);
        if (yoloBoxes.length > 0) {
          let best = yoloBoxes[0];
          for (const b of yoloBoxes) {
            if (b.w * b.h > best.w * best.h) best = b;
          }
          const cx = best.x + best.w / 2;
          const cy = best.y + best.h / 2;
          let side = Math.max(best.w, best.h) * 1.5;
          side = Math.min(side, detectorCanvas.width, detectorCanvas.height);
          let cropX = cx - side / 2;
          let cropY = cy - side / 2;
          cropX = Math.max(0, Math.min(detectorCanvas.width - side, cropX));
          cropY = Math.max(0, Math.min(detectorCanvas.height - side, cropY));

          subCtx.clearRect(0, 0, SUB_DETECTOR_SIZE, SUB_DETECTOR_SIZE);
          subCtx.drawImage(
            detectorCanvas,
            cropX,
            cropY,
            side,
            side,
            0,
            0,
            SUB_DETECTOR_SIZE,
            SUB_DETECTOR_SIZE
          );

          mpResult = await faceLandmarker.detectForVideo(
            subCanvas,
            performance.now()
          );
          if (mpResult.faceLandmarks.length > 0) {
            landmarkToDet = (p) => ({
              x: cropX + p.x * side,
              y: cropY + p.y * side,
            });
          }
        }
      }

      detecting = false;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const facesPx: Point[][] = mpResult.faceLandmarks.map((lm) =>
        lm.map((p) => {
          const det = landmarkToDet(p);
          return pointToCanvas(det.x, det.y, t);
        })
      );

      const faces = tracker.update(facesPx, dt);
      system.step(dt);

      drawBackground(faces, t);

      drawEyeSockets(faces);

      eyeRenderer.beginFrame();
      for (const f of faces) {
        f.person.draw(eyeRenderer);
      }

      if (visualParams.showDebug) {
        drawDebugOverlay(ctx, faces);
      }

      applyZoomToFace(faces, t, dt);
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

main().catch(console.error);
