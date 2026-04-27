import { Pane } from "tweakpane";
import { createFaceLandmarker } from "./faceLandmarker";
import {
  drawFaceMask,
  drawFaceColor,
  fillEyesWhite,
  cutOutEyes,
  Point,
} from "./faceRenderer";
import { PhysicsEyeballs } from "./physicsEyeballs";
import { FACE_OVAL } from "./landmarks";

const W = 640;
const H = 480;
const FACE_FILL = 0.95;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
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

  const physics = new PhysicsEyeballs();

  // Tweakpane
  const params = {
    faceColor: "#ffffff",
    useTexture: true,
  };

  const pane = new Pane({ title: "controls" });
  pane.addButton({ title: "drop eyeballs" }).on("click", () => {
    physics.dropBalls();
  });
  pane.addBinding(params, "useTexture", { label: "face texture" });
  pane.addBinding(params, "faceColor", { label: "face color" });

  let lastVideoTime = -1;
  let lastTime = performance.now();

  let smoothScale = 1;
  let smoothTx = 0;
  let smoothTy = 0;
  const SMOOTH = 0.15;

  function loop() {
    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;

      const result = faceLandmarker.detectForVideo(video, performance.now());

      ctx.clearRect(0, 0, W, H);

      if (result.faceLandmarks.length > 0) {
        const lm = result.faceLandmarks[0];

        const rawPts: Point[] = lm.map((p) => ({
          x: (1 - p.x) * W,
          y: p.y * H,
        }));

        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity;
        for (const i of FACE_OVAL) {
          minX = Math.min(minX, rawPts[i].x);
          maxX = Math.max(maxX, rawPts[i].x);
          minY = Math.min(minY, rawPts[i].y);
          maxY = Math.max(maxY, rawPts[i].y);
        }
        const faceW = maxX - minX;
        const faceH = maxY - minY;
        const faceCx = (minX + maxX) / 2;
        const faceCy = (minY + maxY) / 2;

        const targetScale = Math.min(
          (W * FACE_FILL) / faceW,
          (H * FACE_FILL) / faceH
        );
        const targetTx = W / 2 - faceCx * targetScale;
        const targetTy = H / 2 - faceCy * targetScale;

        smoothScale = lerp(smoothScale, targetScale, SMOOTH);
        smoothTx = lerp(smoothTx, targetTx, SMOOTH);
        smoothTy = lerp(smoothTy, targetTy, SMOOTH);

        const pts: Point[] = rawPts.map((p) => ({
          x: p.x * smoothScale + smoothTx,
          y: p.y * smoothScale + smoothTy,
        }));

        physics.update(pts, dt);
        const { left: smoothLeft, right: smoothRight } =
          physics.getSmoothedContours();

        // Face: texture or solid color
        if (params.useTexture) {
          drawFaceMask(ctx, video, pts, W, H, smoothScale, smoothTx, smoothTy);
        } else {
          drawFaceColor(ctx, pts, params.faceColor);
        }

        cutOutEyes(ctx, smoothLeft, smoothRight);
        fillEyesWhite(ctx, smoothLeft, smoothRight);
        physics.draw(ctx);
      } else {
        physics.noFace();
      }
    }

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

main().catch(console.error);
