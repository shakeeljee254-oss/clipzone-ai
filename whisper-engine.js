/**
 * js/whisper-engine.js — Hugging Face Transformers.js Whisper ASR (English, Urdu, Auto Detect) + SRT + RTL Nastaliq
 */
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.2';

const WHISPER_MODEL_ID = 'onnx-community/whisper-small';

export class WhisperEngine {
  constructor(options = {}) {
    this.onLog = options.onLog || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.transcriber = null;
    this.videoEngine = options.videoEngine || null;
    this.captions = [];
    this.captionStyle = 'standard';
  }

  setCaptionStyle(style) {
    this.captionStyle = style;
  }

  getCaptions() {
    return this.captions;
  }

  setCaptions(list) {
    this.captions = Array.isArray(list) ? list : [];
  }

  updateCaption(index, newText) {
    if (this.captions[index]) {
      this.captions[index].text = newText;
    }
  }

  async loadModel() {
    if (this.transcriber) return this.transcriber;
    this.onProgress(10);
    this.onLog(`Loading Whisper model (${WHISPER_MODEL_ID}) via Transformers.js...`);

    try {
      this.transcriber = await pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, {
        dtype: 'q8',
        progress_callback: (info) => {
          if (info && typeof info.progress === 'number') {
            this.onProgress(Math.round(info.progress));
          }
        }
      });
      this.onLog('Whisper ASR model ready.');
      this.onProgress(100);
      return this.transcriber;
    } catch (err) {
      throw new Error(`Whisper model download/load failed: ${err.message}`);
    }
  }

  async _decodeTo16kMono(audioBlob) {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const tempCtx = new AudioCtx();
    let decoded;
    try {
      decoded = await tempCtx.decodeAudioData(arrayBuffer);
    } finally {
      await tempCtx.close().catch(() => {});
    }

    const targetRate = 16000;
    const length = Math.ceil(decoded.duration * targetRate);
    const offline = new OfflineAudioContext(1, Math.max(1, length), targetRate);
    const bufferSource = offline.createBufferSource();
    bufferSource.buffer = decoded;
    bufferSource.connect(offline.destination);
    bufferSource.start(0);
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  async transcribeVideoBlob(videoBlob, languageSelection = 'auto') {
    if (!videoBlob) throw new Error('Import a video before running Whisper transcription.');

    const pipe = await this.loadModel();
    this.onLog('Decoding audio track to 16kHz mono PCM...');
    if (!this.videoEngine) throw new Error('Video engine is not connected; audio extraction is unavailable.');
    this.onLog('Extracting the video audio track with FFmpeg...');
    const audioBlob = await this.videoEngine.extractAudioWithFFmpeg(videoBlob);
    const audioFloat32 = await this._decodeTo16kMono(audioBlob);

    const runOptions = {
      return_timestamps: true,
      chunk_length_s: 25,
      stride_length_s: 5
    };

    if (languageSelection === 'english') {
      runOptions.language = 'english';
      runOptions.task = 'transcribe';
    } else if (languageSelection === 'urdu') {
      runOptions.language = 'urdu';
      runOptions.task = 'transcribe';
    } else {
      runOptions.task = 'transcribe';
    }

    this.onLog(`Running Whisper inference (${languageSelection})...`);
    const output = await pipe(audioFloat32, runOptions);

    const chunks = Array.isArray(output?.chunks) && output.chunks.length > 0
      ? output.chunks
      : [{ text: output?.text || '', timestamp: [0, audioFloat32.length / 16000] }];

    this.captions = chunks
      .map((chunk, idx) => {
        const start = Array.isArray(chunk.timestamp) && typeof chunk.timestamp[0] === 'number'
          ? chunk.timestamp[0]
          : idx * 3;
        const end = Array.isArray(chunk.timestamp) && typeof chunk.timestamp[1] === 'number'
          ? chunk.timestamp[1]
          : start + 3;
        const text = (chunk.text || '').trim();
        const isUrduText = /[؀-ۿ]/.test(text) || languageSelection === 'urdu';
        return {
          id: idx + 1,
          start: Number(start.toFixed(2)),
          end: Number(Math.max(start + 0.5, end).toFixed(2)),
          text,
          language: isUrduText ? 'urdu' : 'english'
        };
      })
      .filter((c) => c.text.length > 0);

    if (this.captions.some((c) => c.language === 'urdu')) {
      this.captionStyle = 'urdu-nastaliq';
    }

    this.onLog(`Whisper generated ${this.captions.length} caption segments.`);
    this.onProgress(100);
    return this.captions;
  }

  drawOverlay(ctx, cw, ch, currentTime) {
    const active = this.captions.find((c) => currentTime >= c.start && currentTime <= c.end);
    if (!active || !active.text) return;

    const isRtl = active.language === 'urdu' || /[؀-ۿ]/.test(active.text) || this.captionStyle === 'urdu-nastaliq';
    const fontSize = isRtl ? Math.max(22, Math.round(ch * 0.055)) : Math.max(16, Math.round(ch * 0.042));

    ctx.save();
    ctx.direction = isRtl ? 'rtl' : 'ltr';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = isRtl
      ? `600 ${fontSize}px "Noto Nastaliq Urdu", serif`
      : `700 ${fontSize}px Inter, sans-serif`;

    const yPos = isRtl ? ch * 0.78 : ch * 0.84;
    const textWidth = ctx.measureText(active.text).width;

    ctx.fillStyle = 'rgba(9, 11, 20, 0.78)';
    ctx.fillRect(cw / 2 - textWidth / 2 - 14, yPos - fontSize * 0.75, textWidth + 28, fontSize * 1.5);

    if (this.captionStyle === 'highlight') {
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(cw / 2 - textWidth / 2 - 14, yPos + fontSize * 0.65, textWidth + 28, 3);
    }

    ctx.fillStyle = '#ffffff';
    ctx.fillText(active.text, cw / 2, yPos);
    ctx.restore();
  }

  toSRT() {
    const fmtSrtTime = (sec) => {
      const s = Math.max(0, Number(sec) || 0);
      const hh = Math.floor(s / 3600).toString().padStart(2, '0');
      const mm = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
      const ss = Math.floor(s % 60).toString().padStart(2, '0');
      const ms = Math.floor((s % 1) * 1000).toString().padStart(3, '0');
      return `${hh}:${mm}:${ss},${ms}`;
    };

    return this.captions
      .map((c, index) => `${index + 1}
${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}
${c.text}
`)
      .join('
');
  }
}
