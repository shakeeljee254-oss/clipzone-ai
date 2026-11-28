/**
 * js/video-engine.js
 * CLIPZONE AI — Canvas Preview + FFmpeg.wasm editing/export engine
 */
import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';

const FFMPEG_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const FFMPEG_MT_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm';

export class VideoEngine {
  constructor(canvas, options = {}) {
    if (!canvas) throw new Error('A preview canvas is required.');

    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Unable to create the preview canvas context.');

    this.onLog = options.onLog || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';

    this.sourceBlob = null;
    this.fileName = '';
    this.objectUrl = null;
    this.duration = 0;
    this.isPlaying = false;
    this.rafId = null;

    this.trimStart = 0;
    this.trimEnd = 0;
    this.brightness = 100;
    this.contrast = 100;
    this.saturation = 100;
    this.overlayText = '';

    this.whisperEngine = null;
    this.reframeEngine = null;

    this.ffmpeg = null;
    this.ffmpegLoaded = false;
    this.ffmpegLoading = null;
    this.singleThreadMode = true;
    this.abortController = null;

    this.onTimeTick = null;
    this._wireEvents();
  }

  attachPhase2Engines({ whisperEngine, reframeEngine } = {}) {
    this.whisperEngine = whisperEngine || null;
    this.reframeEngine = reframeEngine || null;
    this.renderPreviewFrame();
  }

  _wireEvents() {
    this.video.addEventListener('loadedmetadata', () => {
      this.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
      this.trimStart = 0;
      this.trimEnd = this.duration;
      this.resizeCanvasForAspect(this.reframeEngine?.aspectRatio || '16:9');
      this.renderPreviewFrame();
      this.onTimeTick?.(this.currentTime, this.duration);
    });

    this.video.addEventListener('pause', () => {
      this.isPlaying = false;
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.renderPreviewFrame();
    });

    this.video.addEventListener('ended', () => {
      this.isPlaying = false;
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.renderPreviewFrame();
    });

    this.video.addEventListener('error', () => {
      this.isPlaying = false;
    });
  }

  async loadVideoFile(file) {
    if (!file) throw new Error('Please choose a video file.');
    return this.loadVideoBlob(file, file.name || 'video.mp4');
  }

  async loadVideoBlob(blob, fileName = 'video.mp4') {
    if (!blob) throw new Error('No video Blob provided.');
    this.pause();

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.sourceBlob = blob;
    this.fileName = fileName;
    this.objectUrl = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      const onLoaded = () => { cleanup(); resolve(); };
      const onError = () => {
        cleanup();
        reject(new Error('Unable to load this video. Please try an MP4 or another supported format.'));
      };

      this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
      this.video.addEventListener('error', onError, { once: true });
      this.video.src = this.objectUrl;
      this.video.load();
    });

    this.video.currentTime = 0;
    this.renderPreviewFrame();
    this.onLog(`Loaded video "${fileName}" (${this.duration.toFixed(1)}s).`);
    return this.getState();
  }

  get currentTime() {
    return this.video.currentTime || 0;
  }

  play() {
    if (!this.video.src) return;
    if (this.video.currentTime < this.trimStart || this.video.currentTime >= this.trimEnd) {
      this.video.currentTime = this.trimStart;
    }
    const playPromise = this.video.play();
    if (playPromise?.catch) playPromise.catch(err => this.onLog(`Playback error: ${err.message}`));
    this.isPlaying = true;
    this._loop();
  }

  pause() {
    if (this.video && !this.video.paused) this.video.pause();
    this.isPlaying = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  seek(timeSec) {
    if (!this.video.src) return;
    const target = Math.max(0, Math.min(this.duration, Number(timeSec) || 0));
    const onSeeked = () => {
      this.video.removeEventListener('seeked', onSeeked);
      this.renderPreviewFrame();
      this.onTimeTick?.(this.currentTime, this.duration);
    };
    this.video.addEventListener('seeked', onSeeked, { once: true });
    this.video.currentTime = target;
  }

  setTrimRange(start, end) {
    const safeStart = Math.max(0, Math.min(Number(start) || 0, this.duration));
    const safeEnd = Math.max(safeStart, Math.min(Number(end) || 0, this.duration));
    this.trimStart = safeStart;
    this.trimEnd = safeEnd;
  }

  setAdjustments({ brightness, contrast, saturation, overlayText } = {}) {
    if (typeof brightness === 'number') this.brightness = brightness;
    if (typeof contrast === 'number') this.contrast = contrast;
    if (typeof saturation === 'number') this.saturation = saturation;
    if (typeof overlayText === 'string') this.overlayText = overlayText;
    this.renderPreviewFrame();
  }

  resizeCanvasForAspect(aspectRatio) {
    const sizes = {
      '16:9': { w: 960, h: 540 },
      '9:16': { w: 360, h: 640 },
      '1:1': { w: 540, h: 540 }
    };

    const chosen = sizes[aspectRatio] || sizes['16:9'];
    this.canvas.width = chosen.w;
    this.canvas.height = chosen.h;
    this.renderPreviewFrame();
  }

  _loop() {
    const tick = () => {
      if (!this.isPlaying) return;

      if (this.video.currentTime >= this.trimEnd) {
        this.pause();
        return;
      }

      this.renderPreviewFrame();
      this.onTimeTick?.(this.video.currentTime, this.duration);
      this.rafId = requestAnimationFrame(tick);
    };

    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(tick);
  }

  renderPreviewFrame() {
    if (!this.ctx || !this.canvas) return;

    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
      ctx.filter = `brightness(${this.brightness}%) contrast(${this.contrast}%) saturate(${this.saturation}%)`;

      const vw = this.video.videoWidth || cw;
      const vh = this.video.videoHeight || ch;

      if (this.reframeEngine?.getCropForFrame) {
        const crop = this.reframeEngine.getCropForFrame(
          vw, vh, cw, ch, this.currentTime
        );

        if (crop) {
          ctx.drawImage(
            this.video,
            crop.sx, crop.sy, crop.sw, crop.sh,
            0, 0, cw, ch
          );
        } else {
          ctx.drawImage(this.video, 0, 0, cw, ch);
        }
      } else {
        ctx.drawImage(this.video, 0, 0, cw, ch);
      }
    }

    ctx.filter = 'none';

    if (this.overlayText?.trim()) {
      const fontSize = Math.max(16, Math.round(ch * 0.04));
      ctx.font = `700 ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = 'left';

      const width = ctx.measureText(this.overlayText).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(14, 14, width + 20, fontSize + 12);

      ctx.fillStyle = '#38bdf8';
      ctx.fillText(this.overlayText, 24, 14 + fontSize * 0.82);
    }

    this.whisperEngine?.drawOverlay?.(ctx, cw, ch, this.currentTime);
    ctx.restore();
  }

  getState() {
    return {
      trimStart: this.trimStart,
      trimEnd: this.trimEnd,
      brightness: this.brightness,
      contrast: this.contrast,
      saturation: this.saturation,
      overlayText: this.overlayText
    };
  }

  applyState(state) {
    if (!state) return;

    if (typeof state.trimStart === 'number') this.trimStart = state.trimStart;
    if (typeof state.trimEnd === 'number') this.trimEnd = state.trimEnd;
    if (typeof state.brightness === 'number') this.brightness = state.brightness;
    if (typeof state.contrast === 'number') this.contrast = state.contrast;
    if (typeof state.saturation === 'number') this.saturation = state.saturation;
    if (typeof state.overlayText === 'string') this.overlayText = state.overlayText;

    this.renderPreviewFrame();
  }

  async initFFmpeg() {
    if (this.ffmpegLoaded && this.ffmpeg) return this.ffmpeg;
    if (this.ffmpegLoading) return this.ffmpegLoading;

    this.ffmpegLoading = (async () => {
      this.onProgress(5);
      this.onLog('Initializing FFmpeg.wasm...');

      const ffmpeg = new FFmpeg();

      ffmpeg.on('log', ({ message }) => {
        if (message) this.onLog(`ffmpeg: ${message}`);
      });

      ffmpeg.on('progress', ({ progress }) => {
        this.onProgress(
          Math.round(Math.max(0, Math.min(1, progress || 0)) * 100)
        );
      });

      const canUseThreads =
        typeof crossOriginIsolated !== 'undefined' &&
        crossOriginIsolated &&
        typeof SharedArrayBuffer !== 'undefined';

      try {
        if (canUseThreads) {
          this.singleThreadMode = false;

          await ffmpeg.load({
            coreURL: await toBlobURL(
              `${FFMPEG_MT_BASE_URL}/ffmpeg-core.js`,
              'text/javascript'
            ),
            wasmURL: await toBlobURL(
              `${FFMPEG_MT_BASE_URL}/ffmpeg-core.wasm`,
              'application/wasm'
            ),
            workerURL: await toBlobURL(
              `${FFMPEG_MT_BASE_URL}/ffmpeg-core.worker.js`,
              'text/javascript'
            )
          });
        } else {
          this.singleThreadMode = true;

          await ffmpeg.load({
            coreURL: await toBlobURL(
              `${FFMPEG_BASE_URL}/ffmpeg-core.js`,
              'text/javascript'
            ),
            wasmURL: await toBlobURL(
              `${FFMPEG_BASE_URL}/ffmpeg-core.wasm`,
              'application/wasm'
            )
          });
        }
      } catch (err) {
        try { ffmpeg.terminate(); } catch (_) {}
        throw new Error(`FFmpeg initialization failed: ${err.message}`);
      }

      this.ffmpeg = ffmpeg;
      this.ffmpegLoaded = true;
      this.onProgress(100);

      return ffmpeg;
    })();

    try {
      return await this.ffmpegLoading;
    } finally {
      this.ffmpegLoading = null;
    }
  }

  _beginTask() {
    if (this.abortController) this.abortController.abort();

    this.abortController = new AbortController();
    return this.abortController.signal;
  }

  cancelFFmpeg() {
    this.abortController?.abort();
    this.abortController = null;

    if (this.ffmpeg?.terminate) {
      this.ffmpeg.terminate();
      this.ffmpeg = null;
      this.ffmpegLoaded = false;
      this.onLog('FFmpeg operation cancelled.', 'warn');
    }

    this.onProgress(0);
  }

  async _safeDelete(ff, names) {
    for (const name of names) {
      try {
        await ff.deleteFile(name);
      } catch (_) {
        // Ignore missing temporary files.
      }
    }
  }
