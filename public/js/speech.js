// Web Speech API wrapper. Chrome-only; drives the live dashboard.
// Emits final and interim results with session-clock timestamps and
// auto-restarts when Chrome silently ends the recognition stream.

export function speechSupported() {
  return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
}

export class LiveSpeech {
  /**
   * @param {object} handlers
   * @param {(text: string, tSec: number) => void} handlers.onFinal
   * @param {(text: string) => void} handlers.onInterim
   * @param {(msg: string) => void} [handlers.onStatus]
   */
  constructor(handlers) {
    this.handlers = handlers;
    this.recognition = null;
    this.running = false;
    this.startedAt = 0;
  }

  start() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) throw new Error('Web Speech API unavailable — use Chrome.');
    this.running = true;
    this.startedAt = performance.now();
    this._spinUp(Recognition);
  }

  /** Resume after a pause (stop()) without resetting the session clock. */
  resume() {
    if (this.running || !this.startedAt) return;
    this.running = true;
    this._spinUp(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  _spinUp(Recognition) {
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';

    rec.onresult = (event) => {
      const tSec = (performance.now() - this.startedAt) / 1000;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) {
          const text = r[0].transcript.trim();
          if (text) this.handlers.onFinal(text, tSec);
        } else {
          interim += r[0].transcript;
        }
      }
      this.handlers.onInterim?.(interim.trim());
    };

    rec.onerror = (e) => {
      // 'no-speech' and 'aborted' are routine; onend handles the restart.
      if (e.error === 'not-allowed') {
        this.running = false;
        this.handlers.onStatus?.('Microphone permission denied for speech recognition.');
      }
    };

    rec.onend = () => {
      // Chrome ends recognition every ~60s of continuous audio; restart
      // seamlessly for the whole session.
      if (this.running) {
        try {
          rec.start();
        } catch {
          this._spinUp(Recognition); // stale instance — build a fresh one
        }
      }
    };

    this.recognition = rec;
    rec.start();
  }

  stop() {
    this.running = false;
    try {
      this.recognition?.stop();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
  }
}
