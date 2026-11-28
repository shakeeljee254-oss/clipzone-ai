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
