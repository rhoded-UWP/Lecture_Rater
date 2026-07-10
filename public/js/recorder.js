// In-browser session recording (Phase 2). Low-bitrate Opus so a 50-minute
// class stays ~12 MB. The blob exists only in browser memory until the single
// upload to /api/transcribe, then is released.

export class SessionRecorder {
  constructor(bitsPerSecond) {
    this.bitsPerSecond = bitsPerSecond;
    this.recorder = null;
    this.chunks = [];
    this.mimeType = '';
  }

  start(stream) {
    if (typeof MediaRecorder === 'undefined') return false;
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    this.mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    if (!this.mimeType) return false;

    this.chunks = [];
    this.recorder = new MediaRecorder(stream, {
      mimeType: this.mimeType,
      audioBitsPerSecond: this.bitsPerSecond,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data);
    };
    this.recorder.start(10_000); // flush a chunk every 10s
    return true;
  }

  /** Pause during nonlecture activity — lab/video audio is never captured. */
  pause() {
    if (this.recorder?.state === 'recording') this.recorder.pause();
  }

  resume() {
    if (this.recorder?.state === 'paused') this.recorder.resume();
  }

  /** @returns {Promise<Blob|null>} */
  stop() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') {
        resolve(this.chunks.length ? new Blob(this.chunks, { type: this.mimeType }) : null);
        return;
      }
      this.recorder.onstop = () => {
        const blob = this.chunks.length ? new Blob(this.chunks, { type: this.mimeType }) : null;
        this.chunks = [];
        this.recorder = null;
        resolve(blob);
      };
      this.recorder.stop();
    });
  }
}
