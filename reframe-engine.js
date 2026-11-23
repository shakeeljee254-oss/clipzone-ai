/**
 * js/reframe-engine.js — MediaPipe BlazeFace Subject Tracking & Safe Center-Crop Fallback
 */
import { FaceDetector, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22';

const VISION_WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/wasm';
const BLAZEFACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

export class ReframeEngine {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.onProgress = options.onProgress || (() => {});

    this.detector = null;
    this.aspectRatio = '16:9';
    this.smoothing = 0.18;
    this.keyframes = []; // [{ time, normX, normY }]
    this.smoothedX = 0.5;
    this.fallbackToCenter = false;
  }

  setAspectRatio(ratio) {
    this.aspectRatio = ratio;
  }

  setSmoothing(val) {
    this.smoothing = Math.max(0.02, Math.min(0.8, Number(val) || 0.18));
  }

  useCenterFallback() {
    this.fallbackToCenter = true;
    this.keyframes = [];
    this.smoothedX = 0.5;
    this.onLog('Switched Smart Reframe to safe center-crop mode.');
  }

  getState() {
    return {
      aspectRatio: this.aspectRatio,
      smoothing: this.smoothing,
      keyframes: this.keyframes,
      fallbackToCenter: this.fallbackToCenter
    };
  }

  applyState(state) {
    if (!state) return;
    if (state.aspectRatio) this.aspectRatio = state.aspectRatio;
    if (typeof state.smoothing === 'number') this.smoothing = state.smoothing;
    if (Array.isArray(state.keyframes)) this.keyframes = state.keyframes;
    if (typeof state.fallbackToCenter === 'boolean') this.fallbackToCenter = state.fallbackToCenter;
  }

  async initDetector() {
    if (this.detector) return this.detector;
    this.onProgress(10);
    this.onLog('Initializing MediaPipe BlazeFace detector...');

    try {
      const vision = await FilesetResolver.forVisionTasks(VISION_WASM_ROOT);
      this.detector = await FaceDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: BLAZEFACE_MODEL_URL,
          delegate: 'GPU'
        },
        runningMode: 'IMAGE',
        minDetectionConfidence: 0.45
      });
      this.onLog('MediaPipe BlazeFace ready.');
      this.onProgress(100);
      return this.detector;
    } catch (err) {
      this.fallbackToCenter = true;
      throw new Error(`MediaPipe BlazeFace initialization failed; center-crop fallback active: ${err.message}`);
    }
  }

  async analyzeVideoFaces(videoEl) {
    if (!videoEl || !videoEl.duration) {
      throw new Error('Load a video before running face tracking.');
    }

    const detector = await this.initDetector();
    this.fallbackToCenter = false;

    const sampleCanvas = document.createElement('canvas');
    sampleCanvas.width = 320;
    sampleCanvas.height = 180;
    const sCtx = sampleCanvas.getContext('2d');

    const duration = videoEl.duration;
    const step = Math.max(0.4, duration / 20);
    const prevTime = videoEl.currentTime;
    const detected = [];

    for (let t = 0; t <= duration; t += step) {
      await this._seekForSample(videoEl, t);
      sCtx.drawImage(videoEl, 0, 0, sampleCanvas.width, sampleCanvas.height);
      const result = detector.detect(sampleCanvas);
      const faces = result?.detections || [];

      if (faces.length > 0) {
        const primary = faces[0];
        const box = primary.boundingBox;
        if (box && sampleCanvas.width > 0) {
          const centerNormX = (box.originX + box.width * 0.5) / sampleCanvas.width;
          const centerNormY = (box.originY + box.height * 0.5) / sampleCanvas.height;
          detected.push({
            time: Number(t.toFixed(2)),
            normX: Math.max(0.1, Math.min(0.9, centerNormX)),
            normY: Math.max(0.1, Math.min(0.9, centerNormY))
          });
        }
      }
      this.onProgress(Math.round((t / duration) * 100));
    }

    await this._seekForSample(videoEl, prevTime);

    if (detected.length === 0) {
      this.fallbackToCenter = true;
      this.keyframes = [];
      this.onLog('No faces detected; using safe center-crop fallback.', 'warn');
      return [];
    }

    this.keyframes = detected;
    this.onLog(`Detected face keyframes across ${detected.length} samples.`);
    this.onProgress(100);
    return this.keyframes;
  }

  _seekForSample(video, time) {
    return new Promise((resolve) => {
      const target = Math.max(0, Math.min(video.duration, time));
      if (Math.abs(video.currentTime - target) < 0.03) {
        resolve();
        return;
      }
      const done = () => {
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done);
      video.currentTime = target;
    });
  }

  getTargetNormX(currentTime) {
    if (this.fallbackToCenter || !this.keyframes.length) {
      return 0.5;
    }

    let before = this.keyframes[0];
    let after = this.keyframes[this.keyframes.length - 1];

    for (let i = 0; i < this.keyframes.length - 1; i++) {
      if (currentTime >= this.keyframes[i].time && currentTime <= this.keyframes[i + 1].time) {
        before = this.keyframes[i];
        after = this.keyframes[i + 1];
        break;
      }
    }

    const dt = after.time - before.time;
    const ratio = dt > 0 ? (currentTime - before.time) / dt : 0;
    return before.normX + (after.normX - before.normX) * ratio;
  }

  getCropForFrame(srcW, srcH, dstW, dstH, currentTime) {
    const srcRatio = srcW / srcH;
    const dstRatio = dstW / dstH;

    let sw = srcW;
    let sh = srcH;
    if (srcRatio > dstRatio) {
      sw = srcH * dstRatio;
    } else {
      sh = srcW / dstRatio;
    }

    const targetX = this.getTargetNormX(currentTime);
    this.smoothedX += (targetX - this.smoothedX) * this.smoothing;

    const maxSx = Math.max(0, srcW - sw);
    const sx = Math.max(0, Math.min(maxSx, this.smoothedX * srcW - sw * 0.5));
    const sy = Math.max(0, (srcH - sh) * 0.5);

    return { sx, sy, sw, sh };
  }

  buildFFmpegCropFilter(dstW, dstH) {
    const targetRatio = dstW / dstH;
    const avgNormX = this.fallbackToCenter || !this.keyframes.length
      ? 0.5
      : this.keyframes.reduce((acc, k) => acc + k.normX, 0) / this.keyframes.length;

    const cropExprW = `min(iw,ih*${targetRatio.toFixed(4)})`;
    const cropExprH = `min(ih,iw/${targetRatio.toFixed(4)})`;
    const offsetX = `clip((iw*(${avgNormX.toFixed(3)}))-(${cropExprW})/2,0,iw-(${cropExprW}))`;
    const offsetY = `(ih-(${cropExprH}))/2`;

    return `crop=${cropExprW}:${cropExprH}:${offsetX}:${offsetY},scale=${dstW}:${dstH},setsar=1`;
  }
}
