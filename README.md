# Eye Roller

A webcam toy that drops a rolling pupil into each of your eyes. The pupils tumble around with gravity and head motion, and disappear when you blink.

![Demo](assets/demo.gif)

## How it works

1. The webcam feeds [MediaPipe Face Landmarker](https://developers.google.com/mediapipe/solutions/vision/face_landmarker), which returns 478 landmarks per face every frame. When MediaPipe finds nothing, a [YOLOv11n-face](https://huggingface.co/AdamCodd/YOLOv11n-face-detection) model runs as a fallback to spot distant faces and prompt them to come closer.
2. The eye-socket landmarks get turned into a static collision contour inside a [Planck.js](https://piqnt.com/planck.js) world (Planck is a Box2D port).
3. A circle body — the rolling pupil — sits inside each socket. A soft spring pulls it toward the socket center, while gravity and head motion push it around.
4. Each frame, the canvas redraws the video, paints the sockets white, and renders the pupils on top.
5. Closing an eye (detected via eye-aspect-ratio) fades the pupil out. Opening it back up fades it in.

## Tech stack

- Vite + TypeScript for the dev server and build
- MediaPipe Tasks Vision for face landmark detection
- ONNX Runtime Web running YOLOv11n-face as a "come closer" fallback when MediaPipe loses a far-away face
- Planck.js for 2D rigid-body physics
- Tweakpane for runtime controls (press `Tab` to toggle)
- Canvas 2D for rendering

## Run locally

```bash
bun install
bun run dev
```

Open the URL it prints. You'll need to grant camera permission.

## Deploy

It's a static site, so `bun run build` gives you a `dist/` folder you can drop on any static host.

```bash
bun run build
# then serve dist/ with Vercel, Netlify, GitHub Pages, Cloudflare Pages, etc.
```

The page has to be served over HTTPS (or `localhost`) for `getUserMedia` to work.
