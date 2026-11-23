/**
 * js/video-engine.js — Canvas Preview + FFmpeg.wasm Trim, Merge, Aspect, 720p/1080p, Audio & MP4 Export
 */
import { FFmpeg } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/index.js';
import { fetchFile, toBlobURL } from 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js';

const FFMPEG_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
const FFMPEG_MT_BASE_URL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core-mt@0.12.10/dist/esm';

export class VideoEngine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onLog = options.onLog || (() => {});
    this.onProgress = options.onProgress || (() => {});

    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.preload = 'auto';

    this.sourceBlob = null;
    this.fileName = '';
    this.duration = 0;
    this.isPlaying = false;
    this.rafId = null;

    // Phase 1 editing state
    this.trimStart = 0;
    this.trimEnd = 0;
    this.brightness = 100;
    this.contrast = 100;
    this.saturation = 100;
    this.overlayText = '';

    // Phase 2 engines
    this.whisperEngine = null;
    this.reframeEngine = null;

    // FFmpeg state
    this.ffmpeg = null;
    this.ffmpegLoaded = false;
    this.singleThreadMode = false;
    this.abortController = null;

    this.onTimeTick = null;
    this._wireEvents();
  }

  attachPhase2Engines({ whisperEngine, reframeEngine }) {
    this.whisperEngine = whisperEngine || null;
    this.reframeEngine = reframeEngine || null;
  }

  _wireEvents() {
    this.video.addEventListener('loadedmetadata', () => {
      this.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
      this.trimStart = 0;
      this.trimEnd = this.duration;
      this.resizeCanvasForAspect(this.reframeEngine ? this.reframeEngine.aspectRatio : '16:9');
      this.renderPreviewFrame();
    });

    this.video.addEventListener('pause', () => {
      this.isPlaying = false;
      cancelAnimationFrame(this.rafId);
      this.renderPreviewFrame();
    });

    this.video.addEventListener('ended', () => {
      this.isPlaying = false;
      cancelAnimationFrame(this.rafId);
      this.renderPreviewFrame();
    });
  }

  async loadVideoFile(file) {
    return this.loadVideoBlob(file, file.name);
  }

  async loadVideoBlob(blob, fileName = 'video.mp4') {
    if (!blob) throw new Error('No video Blob provided.');
    this.sourceBlob = blob;
    this.fileName = fileName;

    if (this.video.src && this.video.src.startsWith('blob:')) {
      URL.revokeObjectURL(this.video.src);
    }
    this.video.src = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const ok = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('Unable to load video stream in browser.'));
      };
      const cleanup = () => {
        this.video.removeEventListener('loadeddata', ok);
        this.video.removeEventListener('error', fail);
      };
      this.video.addEventListener('loadeddata', ok);
      this.video.addEventListener('error', fail);
    });

    this.video.currentTime = 0;
    this.renderPreviewFrame();
    this.onLog(`Loaded video "${fileName}" (${this.duration.toFixed(1)}s).`);
  }

  get currentTime() {
    return this.video.currentTime || 0;
  }

  play() {
    if (!this.video.src) return;
    if (this.video.currentTime < this.trimStart || this.video.currentTime >= this.trimEnd) {
      this.video.currentTime = this.trimStart;
    }
    this.video.play();
    this.isPlaying = true;
    this._loop();
  }

  pause() {
    if (!this.video.src) return;
    this.video.pause();
    this.isPlaying = false;
    cancelAnimationFrame(this.rafId);
  }

  seek(timeSec) {
    if (!this.video.src) return;
    const target = Math.max(0, Math.min(this.duration, timeSec));
    this.video.currentTime = target;
    const onSeeked = () => {
      this.video.removeEventListener('seeked', onSeeked);
      this.renderPreviewFrame();
      if (this.onTimeTick) this.onTimeTick(this.currentTime, this.duration);
    };
    this.video.addEventListener('seeked', onSeeked);
  }

  setTrimRange(start, end) {
    this.trimStart = Math.max(0, Math.min(start, this.duration));
    this.trimEnd = Math.max(this.trimStart + 0.1, Math.min(end, this.duration));
  }

  setAdjustments({ brightness, contrast, saturation, overlayText }) {
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
  }

  _loop() {
    const tick = () => {
      if (!this.isPlaying) return;
      if (this.video.currentTime >= this.trimEnd) {
        this.pause();
        return;
      }
      this.renderPreviewFrame();
      if (this.onTimeTick) {
        this.onTimeTick(this.video.currentTime, this.duration);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  renderPreviewFrame() {
    const ctx = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, cw, ch);

    if (this.video.readyState >= 2) {
      ctx.filter = `brightness(${this.brightness}%) contrast(${this.contrast}%) saturate(${this.saturation}%)`;
      const vw = this.video.videoWidth || cw;
      const vh = this.video.videoHeight || ch;
      if (this.reframeEngine) {
        const crop = this.reframeEngine.getCropForFrame(vw, vh, cw, ch, this.currentTime);
        ctx.drawImage(this.video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, cw, ch);
      } else {
        ctx.drawImage(this.video, 0, 0, cw, ch);
      }
    }

    ctx.filter = 'none';

    if (this.overlayText && this.overlayText.trim().length > 0) {
      const fontSize = Math.max(16, Math.round(ch * 0.04));
      ctx.font = `700 ${fontSize}px Inter, sans-serif`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      const w = ctx.measureText(this.overlayText).width;
      ctx.fillRect(14, 14, w + 20, fontSize + 12);
      ctx.fillStyle = '#38bdf8';
      ctx.fillText(this.overlayText, 24, 14 + fontSize * 0.82);
    }

    if (this.whisperEngine) {
      this.whisperEngine.drawOverlay(ctx, cw, ch, this.currentTime);
    }

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

    this.onProgress(5);
    this.onLog('Initializing FFmpeg.wasm...');

    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => {
      if (message) this.onLog(`ffmpeg: ${message}`);
    });
    ffmpeg.on('progress', ({ progress }) => {
      this.onProgress(Math.round(Math.max(0, Math.min(1, progress)) * 100));
    });

    const hasSharedArrayBuffer = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';

    try {
      if (hasSharedArrayBuffer) {
        this.singleThreadMode = false;
        await ffmpeg.load({
          coreURL: await toBlobURL(`${FFMPEG_MT_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${FFMPEG_MT_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
          workerURL: await toBlobURL(`${FFMPEG_MT_BASE_URL}/ffmpeg-core.worker.js`, 'text/javascript')
        });
        this.onLog('FFmpeg.wasm loaded in multi-threaded mode.');
      } else {
        this.singleThreadMode = true;
        this.onLog('SharedArrayBuffer unavailable (common on GitHub Pages); loading single-thread FFmpeg core.');
        await ffmpeg.load({
          coreURL: await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.js`, 'text/javascript'),
          wasmURL: await toBlobURL(`${FFMPEG_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm')
        });
        this.onLog('FFmpeg.wasm loaded in single-thread compatibility mode.');
      }
    } catch (err) {
      throw new Error(`FFmpeg initialization failed (check network/CDN/CORS): ${err.message}`);
    }

    this.ffmpeg = ffmpeg;
    this.ffmpegLoaded = true;
    this.onProgress(100);
    return this.ffmpeg;
  }

  _beginTask() {
    this.abortController = new AbortController();
    return this.abortController.signal;
  }

  cancelFFmpeg() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.ffmpeg && typeof this.ffmpeg.terminate === 'function') {
      this.ffmpeg.terminate();
      this.ffmpeg = null;
      this.ffmpegLoaded = false;
      this.onLog('FFmpeg operation cancelled and worker terminated.', 'warn');
    }
    this.onProgress(0);
  }

  async trimVideoWithFFmpeg(startSec, endSec) {
    if (!this.sourceBlob) throw new Error('Import a video first.');
    if (endSec <= startSec) throw new Error('Trim end time must be greater than start time.');
    const signal = this._beginTask();
    const ff = await this.initFFmpeg();

    const inName = 'trim_in.mp4';
    const outName = 'trim_out.mp4';
    await ff.writeFile(inName, await fetchFile(this.sourceBlob));
    if (signal.aborted) throw new Error('Task cancelled.');

    await ff.exec([
      '-ss', String(startSec),
      '-to', String(endSec),
      '-i', inName,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '24',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outName
    ]);

    const data = await ff.readFile(outName);
    await this._safeDelete(ff, [inName, outName]);
    this.onProgress(100);
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  async mergeVideosWithFFmpeg(firstBlob, secondBlob) {
    if (!firstBlob || !secondBlob) throw new Error('Both source and second video clips are required.');
    const signal = this._beginTask();
    const ff = await this.initFFmpeg();

    await ff.writeFile('clip1.mp4', await fetchFile(firstBlob));
    await ff.writeFile('clip2.mp4', await fetchFile(secondBlob));
    if (signal.aborted) throw new Error('Task cancelled.');

    await ff.exec([
      '-i', 'clip1.mp4',
      '-i', 'clip2.mp4',
      '-filter_complex', '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v0];[1:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v1];[v0][0:a][v1][1:a]concat=n=2:v=1:a=1[outv][outa]',
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      'merged.mp4'
    ]);

    const data = await ff.readFile('merged.mp4');
    await this._safeDelete(ff, ['clip1.mp4', 'clip2.mp4', 'merged.mp4']);
    this.onProgress(100);
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  async extractAudioWithFFmpeg(videoBlob) {
    if (!videoBlob) throw new Error('No video loaded.');
    const signal = this._beginTask();
    const ff = await this.initFFmpeg();

    await ff.writeFile('extract_in.mp4', await fetchFile(videoBlob));
    if (signal.aborted) throw new Error('Task cancelled.');

    await ff.exec(['-i', 'extract_in.mp4', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'extracted.wav']);
    const data = await ff.readFile('extracted.wav');
    await this._safeDelete(ff, ['extract_in.mp4', 'extracted.wav']);
    this.onProgress(100);
    return new Blob([data.buffer], { type: 'audio/wav' });
  }

  async mixAudioWithFFmpeg(videoBlob, audioBlob, mixVolume = 0.35) {
    if (!videoBlob || !audioBlob) throw new Error('Video and background audio are both required.');
    const signal = this._beginTask();
    const ff = await this.initFFmpeg();

    await ff.writeFile('mix_vid.mp4', await fetchFile(videoBlob));
    await ff.writeFile('mix_aud.mp3', await fetchFile(audioBlob));
    if (signal.aborted) throw new Error('Task cancelled.');

    const bgVol = Math.max(0, Math.min(1, mixVolume)).toFixed(2);
    await ff.exec([
      '-i', 'mix_vid.mp4',
      '-i', 'mix_aud.mp3',
      '-filter_complex', `[1:a]volume=${bgVol}[bg];[0:a][bg]amix=inputs=2:duration=shortest[aout]`,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      'mixed_out.mp4'
    ]);

    const data = await ff.readFile('mixed_out.mp4');
    await this._safeDelete(ff, ['mix_vid.mp4', 'mix_aud.mp3', 'mixed_out.mp4']);
    this.onProgress(100);
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  async exportMp4WithFFmpeg({ resolution = '720p', aspectRatio = '16:9', reframeEngine = null, startSec = null, endSec = null } = {}) {
    if (!this.sourceBlob) throw new Error('Import a video before exporting MP4.');
    const signal = this._beginTask();
    const ff = await this.initFFmpeg();

    const dims = this._resolveDimensions(resolution, aspectRatio);
    await ff.writeFile('export_in.mp4', await fetchFile(this.sourceBlob));
    if (signal.aborted) throw new Error('Task cancelled.');

    const cropFilter = reframeEngine
      ? reframeEngine.buildFFmpegCropFilter(dims.width, dims.height)
      : `scale=${dims.width}:${dims.height}:force_original_aspect_ratio=decrease,pad=${dims.width}:${dims.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

    const args = [];
    if (typeof startSec === 'number' && startSec > 0) {
      args.push('-ss', String(startSec));
    }
    if (typeof endSec === 'number' && endSec > (startSec || 0)) {
      args.push('-to', String(endSec));
    }
    args.push(
      '-i', 'export_in.mp4',
      '-vf', cropFilter,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      'export_out.mp4'
    );

    await ff.exec(args);
    const data = await ff.readFile('export_out.mp4');
    await this._safeDelete(ff, ['export_in.mp4', 'export_out.mp4']);
    this.onProgress(100);
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  _resolveDimensions(resolution, aspectRatio) {
    const is1080 = resolution === '1080p';
    if (aspectRatio === '9:16') {
      return is1080 ? { width: 1080, height: 1920 } : { width: 720, height: 1280 };
    }
    if (aspectRatio === '1:1') {
      return is1080 ? { width: 1080, height: 1080 } : { width: 720, height: 720 };
    }
    return is1080 ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
  }

  async _safeDelete(ff, names) {
    for (const n of names) {
      try { await ff.deleteFile(n); } catch (_) {}
    }
  }
}
