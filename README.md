# Eye Roller

A video mirror that puts a rolling pupil in each one of your eyes. Pupils tumble inside your real sockets under gravity and head movement.

![Demo](assets/demo.gif)

## What it is

Mainly a mirror toy to play with. Hand it to someone and watch them spend several minutes making faces; by yourself, you'll start doing it too.

There's a optional tiny game underneath: it measures how far each pupil has rolled (in meters, scaled against your face width) and keeps a running total per recognized face. Stick around long enough and you'll clock a kilometer of pupil. It's a small flourish, not the point — flip it off in the controls whenever you'd rather just watch the eyes.

## Prior art

Googly-eye effects have been on Snapchat and Instagram for years, but almost none simulate physics. Snapchat's official ["Googly Eyes" lens](https://www.snapchat.com/lens/7be9b09dff934d71a4817d8a22d44d54), tagged `#physics`, is the clearest exception — a 3D pair of plastic doll eyes glued to your face.

Eye Roller is different in three ways: it runs in a browser, the socket is your actual eye contour (so the pupil rolls along _your_ eye, not a cartoon circle), and it's 2D — closer to a plastic googly eye stuck to a thing than a 3D object floating in front of your face.

## How it works

1. The webcam feeds [MediaPipe Face Landmarker](https://developers.google.com/mediapipe/solutions/vision/face_landmarker), which returns 478 landmarks per face every frame. When MediaPipe finds nothing, a [YOLOv11n-face](https://huggingface.co/AdamCodd/YOLOv11n-face-detection) model runs as a fallback to spot distant faces and prompt them to come closer.
2. The eye-socket landmarks get turned into a static collision contour inside a [Planck.js](https://piqnt.com/planck.js) world (Planck is a Box2D port).
3. A circle body — the rolling pupil — sits inside each socket. A soft spring pulls it toward the socket center, while gravity and head motion push it around.
4. Each frame, the canvas redraws the video, paints the sockets white, and renders the pupils on top.
5. Closing an eye (detected via eye-aspect-ratio) fades the pupil out. Opening it back up fades it in.

Across frames and reloads, each face is identified by a lightweight geometric signature — 17 normalized distances between MediaPipe landmarks (eye widths, nose proportions, face height, chin-to-cheek). It's not a deep face embedding, just a hash, but it's enough to tell a small roster apart and keep each person's pupil counter pinned to them across detection drops and reloads.

## Tech stack

- Vite + TypeScript for the dev server and build
- [MediaPipe Tasks Vision](https://developers.google.com/mediapipe/solutions/vision/face_landmarker) for face landmark detection
- ONNX Runtime Web running [YOLOv11n-face](https://huggingface.co/AdamCodd/YOLOv11n-face-detection) as a "come closer" fallback when MediaPipe loses a far-away face
- [Planck.js](https://piqnt.com/planck.js) for 2D rigid-body physics
- [Tweakpane](https://tweakpane.github.io/docs/) for runtime controls (press `Tab` to toggle)
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
```

The page has to be served over HTTPS (or `localhost`) for `getUserMedia` to work.
