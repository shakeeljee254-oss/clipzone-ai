/**
 * js/autopilot-engine.js — Highlight Detection & Ranking + Clip Selection + MP4 Render + JSZip Export
 */
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

export class AutopilotEngine {
  constructor({ videoEngine, whisperEngine, reframeEngine, onLog, onProgress }) {
    this.videoEngine = videoEngine;
    this.whisperEngine = whisperEngine;
    this.reframeEngine = reframeEngine;
    this.onLog = onLog || (() => {});
    this.onProgress = onProgress || (() => {});

    this.candidates = []; // [{ id, start, end, score, reason, selected, blob }]
  }

  getCandidates() {
    return this.candidates;
  }

  setCandidates(list) {
    this.candidates = Array.isArray(list) ? list : [];
  }

  setCandidateSelected(index, selected) {
    if (this.candidates[index]) {
      this.candidates[index].selected = Boolean(selected);
    }
  }

  async findHighlights({ maxClips = 3, clipDuration = 15, captions = [] } = {}) {
    const blob = this.videoEngine.sourceBlob;
    const duration = this.videoEngine.duration;
    if (!blob || !duration) {
      throw new Error('Import a video before running AutoPilot highlight analysis.');
    }

    this.onProgress(15);
    this.onLog('Analyzing audio energy and transcript density for highlight ranking...');

    this.onLog('Extracting audio track for highlight analysis...');
    const audioBlob = await this.videoEngine.extractAudioWithFFmpeg(blob);
    const arrayBuffer = await audioBlob.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    let audioBuffer;
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    } finally {
      await audioCtx.close().catch(() => {});
    }

    const pcm = audioBuffer.getChannelData(0);
    const sampleRate = audioBuffer.sampleRate;
    const windowSec = Math.max(4, Math.min(clipDuration, duration));
    const stepSec = Math.max(2, windowSec / 2);

    const scoredWindows = [];
    for (let start = 0; start < duration; start += stepSec) {
      const end = Math.min(duration, start + windowSec);
      if (end - start < 2 && duration > 2) continue;

      const sIdx = Math.floor(start * sampleRate);
      const eIdx = Math.min(pcm.length, Math.floor(end * sampleRate));
      let sumSq = 0;
      for (let i = sIdx; i < eIdx; i++) {
        sumSq += pcm[i] * pcm[i];
      }
      const rms = eIdx > sIdx ? Math.sqrt(sumSq / (eIdx - sIdx)) : 0;
      const energyScore = Math.min(10, rms * 45);

      const overlappingCaptions = captions.filter((c) => c.end >= start && c.start <= end);
      const wordCount = overlappingCaptions.reduce(
        (sum, c) => sum + (c.text ? c.text.trim().split(/\s+/).length : 0),
        0
      );
      const speechScore = Math.min(10, wordCount * 0.35);

      const totalScore = Number((energyScore * 0.6 + speechScore * 0.4).toFixed(2));
      const reason = wordCount > 0
        ? `Audio RMS ${(rms * 100).toFixed(1)}% + ${wordCount} caption words`
        : `Audio RMS energy ${(rms * 100).toFixed(1)}%`;

      scoredWindows.push({
        start: Number(start.toFixed(1)),
        end: Number(end.toFixed(1)),
        score: totalScore,
        reason
      });
    }

    scoredWindows.sort((a, b) => b.score - a.score);

    const picked = [];
    for (const win of scoredWindows) {
      const overlaps = picked.some((p) => !(win.end <= p.start || win.start >= p.end));
      if (!overlaps) {
        picked.push(win);
      }
      if (picked.length >= maxClips) break;
    }

    picked.sort((a, b) => a.start - b.start);

    this.candidates = picked.map((item, idx) => ({
      id: `clip-${idx + 1}`,
      start: item.start,
      end: item.end,
      score: item.score,
      reason: item.reason,
      selected: true,
      blob: null
    }));

    this.onLog(`Identified ${this.candidates.length} ranked highlight clips.`);
    this.onProgress(100);
    return this.candidates;
  }

  async renderSelectedClips({ resolution = '720p', aspectRatio = '9:16' } = {}) {
    const selected = this.candidates.filter((c) => c.selected);
    if (!selected.length) {
      throw new Error('Select at least one highlight clip to render.');
    }

    for (let i = 0; i < selected.length; i++) {
      const clip = selected[i];
      this.onLog(`Rendering highlight ${i + 1}/${selected.length} (${clip.start}s - ${clip.end}s)...`);
      const mp4Blob = await this.videoEngine.exportMp4WithFFmpeg({
        resolution,
        aspectRatio,
        reframeEngine: this.reframeEngine,
        startSec: clip.start,
        endSec: clip.end
      });
      clip.blob = mp4Blob;
      this.onProgress(Math.round(((i + 1) / selected.length) * 100));
    }

    this.onLog(`Rendered ${selected.length} MP4 highlight clips.`);
    return selected;
  }

  async buildZipArchive() {
    const renderedClips = this.candidates.filter((c) => c.selected && c.blob);
    if (!renderedClips.length) {
      throw new Error('Render selected MP4 clips before generating ZIP.');
    }

    this.onLog('Packaging rendered MP4 clips into ZIP archive...');
    const zip = new JSZip();
    renderedClips.forEach((clip, idx) => {
      zip.file(`highlight_${idx + 1}_${clip.start}s-${clip.end}s.mp4`, clip.blob);
    });

    const zipBlob = await zip.generateAsync({ type: 'blob' });
    this.onLog(`ZIP archive ready (${(zipBlob.size / (1024 * 1024)).toFixed(2)} MB).`);
    return zipBlob;
  }
}
