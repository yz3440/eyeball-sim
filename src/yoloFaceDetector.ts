import * as ort from "onnxruntime-web";

// onnxruntime-web ships its WASM artifacts as separate files. Point it at the
// CDN matching the npm package version so Vite doesn't have to bundle them.
ort.env.wasm.wasmPaths =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/";

const MODEL_URL =
  "https://huggingface.co/AdamCodd/YOLOv11n-face-detection/resolve/main/model.onnx";
const INPUT_SIZE = 640;
const NUM_ANCHORS = 8400;

export interface YoloBox {
  /** top-left x in source-image pixels */
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

export class YoloFaceDetector {
  private session: ort.InferenceSession | null = null;
  private inputBuf = new Float32Array(1 * 3 * INPUT_SIZE * INPUT_SIZE);
  private workCanvas: HTMLCanvasElement;
  private workCtx: CanvasRenderingContext2D;

  constructor() {
    this.workCanvas = document.createElement("canvas");
    this.workCanvas.width = INPUT_SIZE;
    this.workCanvas.height = INPUT_SIZE;
    this.workCtx = this.workCanvas.getContext("2d", {
      willReadFrequently: true,
    })!;
  }

  async load(): Promise<void> {
    this.session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["webgpu", "wasm"],
      graphOptimizationLevel: "all",
    });
  }

  /**
   * Run YOLO on `input`. Returned bboxes are in `input`'s pixel coordinates.
   * `scoreThr` ~0.4 catches confident faces; lower (~0.25) is more lenient at
   * the cost of false positives.
   */
  async detect(
    input: HTMLCanvasElement | HTMLVideoElement | ImageBitmap,
    scoreThr = 0.35,
    iouThr = 0.45
  ): Promise<YoloBox[]> {
    if (!this.session) throw new Error("YOLO model not loaded");

    const srcW =
      (input as HTMLCanvasElement).width ||
      (input as HTMLVideoElement).videoWidth ||
      (input as ImageBitmap).width;
    const srcH =
      (input as HTMLCanvasElement).height ||
      (input as HTMLVideoElement).videoHeight ||
      (input as ImageBitmap).height;
    if (!srcW || !srcH) return [];

    // Letterbox: keep aspect ratio, pad shorter side to 640.
    const scale = Math.min(INPUT_SIZE / srcW, INPUT_SIZE / srcH);
    const scaledW = Math.round(srcW * scale);
    const scaledH = Math.round(srcH * scale);
    const padX = (INPUT_SIZE - scaledW) / 2;
    const padY = (INPUT_SIZE - scaledH) / 2;

    this.workCtx.fillStyle = "rgb(114,114,114)"; // canonical YOLO letterbox gray
    this.workCtx.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
    this.workCtx.drawImage(input, 0, 0, srcW, srcH, padX, padY, scaledW, scaledH);

    const img = this.workCtx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
    const buf = this.inputBuf;
    const plane = INPUT_SIZE * INPUT_SIZE;
    for (let i = 0, p = 0; p < plane; i += 4, p++) {
      buf[p] = img[i] / 255; // R
      buf[plane + p] = img[i + 1] / 255; // G
      buf[2 * plane + p] = img[i + 2] / 255; // B
    }

    const tensor = new ort.Tensor("float32", buf, [
      1,
      3,
      INPUT_SIZE,
      INPUT_SIZE,
    ]);
    const results = await this.session.run({ images: tensor });
    const out = results.output0.data as Float32Array; // shape [1, 5, 8400]

    // Output is channel-major: row 0 = cx, row 1 = cy, row 2 = w, row 3 = h, row 4 = conf.
    const candidates: YoloBox[] = [];
    for (let i = 0; i < NUM_ANCHORS; i++) {
      const score = out[4 * NUM_ANCHORS + i];
      if (score < scoreThr) continue;
      const cx = out[i];
      const cy = out[NUM_ANCHORS + i];
      const w = out[2 * NUM_ANCHORS + i];
      const h = out[3 * NUM_ANCHORS + i];
      // Undo letterbox to source pixel coords.
      const x = (cx - w / 2 - padX) / scale;
      const y = (cy - h / 2 - padY) / scale;
      candidates.push({ x, y, w: w / scale, h: h / scale, score });
    }
    return nms(candidates, iouThr);
  }
}

function nms(boxes: YoloBox[], iouThr: number): YoloBox[] {
  boxes.sort((a, b) => b.score - a.score);
  const kept: YoloBox[] = [];
  for (const b of boxes) {
    let drop = false;
    for (const k of kept) {
      if (iou(b, k) > iouThr) {
        drop = true;
        break;
      }
    }
    if (!drop) kept.push(b);
  }
  return kept;
}

function iou(a: YoloBox, b: YoloBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}
