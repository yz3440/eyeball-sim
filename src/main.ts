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

const W = 640;
const H = 480;

interface VisualParams {
  colorOnlyFace: boolean;
  grayscaleStrength: number;
}

async function main() {
  const video = document.getElementById("video") as HTMLVideoElement;
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const loading = document.getElementById("loading") as HTMLDivElement;
  const ctx = canvas.getContext("2d")!;

  canvas.width = W;
  canvas.height = H;

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: W, height: H, facingMode: "user" },
  });
  video.srcObject = stream;
  await new Promise<void>((resolve) => {
    video.onloadeddata = () => resolve();
  });

  const faceLandmarker = await createFaceLandmarker();
  loading.style.display = "none";

  const physicsParams: PhysicsParams = { ...DEFAULT_PHYSICS_PARAMS };
  const visualParams: VisualParams = {
    colorOnlyFace: true,
    grayscaleStrength: 1,
  };

  const system = new EyeballSystem(physicsParams);
  const tracker = new FaceTracker(system);

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
    max: 300,
    step: 1,
    label: "min face px",
  });

  pane.addButton({ title: "reset eyeballs" }).on("click", () => {
    tracker.resetAll();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const el = pane.element as HTMLElement;
      el.style.display = el.style.display === "none" ? "" : "none";
    }
  });

  let lastVideoTime = -1;
  let lastTime = performance.now();

  function drawBackground(faces: TrackedFace[]) {
    if (visualParams.colorOnlyFace) {
      // Grayscale full-frame, then color clipped to each face
      ctx.save();
      ctx.filter = `grayscale(${visualParams.grayscaleStrength})`;
      ctx.scale(-1, 1);
      ctx.drawImage(video, -W, 0, W, H);
      ctx.restore();

      for (const f of faces) {
        ctx.save();
        traceFaceOval(ctx, f.landmarks);
        ctx.clip();
        ctx.scale(-1, 1);
        ctx.drawImage(video, -W, 0, W, H);
        ctx.restore();
      }
    } else {
      ctx.save();
      ctx.scale(-1, 1);
      ctx.drawImage(video, -W, 0, W, H);
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

      ctx.clearRect(0, 0, W, H);

      const faces = tracker.update(result.faceLandmarks, W, H, dt);
      system.step(dt);

      drawBackground(faces);

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
