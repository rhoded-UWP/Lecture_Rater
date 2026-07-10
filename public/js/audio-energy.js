// Web Audio vocal-tone analysis, all local. Tracks volume dynamics (RMS)
// and pitch variance (autocorrelation) over a rolling window and distills
// them into a 0..1 "vocal energy" value — 0 is dead monotone.

const FFT_SIZE = 2048;
const FRAME_MS = 100;              // analysis cadence
const WINDOW_SEC = 30;             // rolling window for variance
const PITCH_MIN_HZ = 65;
const PITCH_MAX_HZ = 400;
const VOICE_RMS_THRESHOLD = 0.015; // below this we treat the frame as silence
const PITCH_STD_REF = 3.0;         // semitone stddev that maps to "fully dynamic"
const VOL_STD_REF = 0.35;          // relative RMS stddev that maps to "fully dynamic"

export class EnergyAnalyzer {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
    this.timer = null;
    this.buf = new Float32Array(FFT_SIZE);
    this.frames = [];   // { t, rms, semitone|null }
    this.level = 0;     // instantaneous mic level 0..1 (for the mic-check meter)
    this.energy = 0;    // rolling 0..1 energy
    this.startedAt = 0;
  }

  /** Reuses an existing getUserMedia stream if provided. */
  async start(stream) {
    this.stream = stream || (await navigator.mediaDevices.getUserMedia({ audio: true }));
    this.ownsStream = !stream;
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    source.connect(this.analyser);
    this.startedAt = performance.now();
    this.timer = setInterval(() => this._tick(), FRAME_MS);
    return this.stream;
  }

  _tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    const t = (performance.now() - this.startedAt) / 1000;

    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    this.level = Math.min(1, rms * 8);

    let semitone = null;
    if (rms > VOICE_RMS_THRESHOLD) {
      const hz = this._detectPitch(this.buf, this.ctx.sampleRate);
      if (hz) semitone = 12 * Math.log2(hz / 440);
    }

    this.frames.push({ t, rms, semitone });
    const cutoff = t - WINDOW_SEC;
    while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift();
    this.energy = this._computeEnergy();
  }

  _computeEnergy() {
    const voiced = this.frames.filter((f) => f.rms > VOICE_RMS_THRESHOLD);
    if (voiced.length < 10) return this.energy; // not enough speech — hold last value

    const rmsVals = voiced.map((f) => f.rms);
    const meanRms = avg(rmsVals);
    const volStd = meanRms > 0 ? std(rmsVals) / meanRms : 0; // coefficient of variation

    const pitches = voiced.map((f) => f.semitone).filter((s) => s !== null);
    const pitchStd = pitches.length >= 5 ? std(pitches) : 0;

    const volScore = Math.min(1, volStd / VOL_STD_REF);
    const pitchScore = Math.min(1, pitchStd / PITCH_STD_REF);
    return 0.5 * volScore + 0.5 * pitchScore;
  }

  // Autocorrelation pitch detection on the time-domain frame.
  _detectPitch(buf, sampleRate) {
    const minLag = Math.floor(sampleRate / PITCH_MAX_HZ);
    const maxLag = Math.floor(sampleRate / PITCH_MIN_HZ);
    let bestLag = -1;
    let bestCorr = 0;
    let norm = 0;
    for (let i = 0; i < buf.length; i++) norm += buf[i] * buf[i];
    if (norm === 0) return null;

    for (let lag = minLag; lag <= maxLag && lag < buf.length; lag++) {
      let corr = 0;
      for (let i = 0; i < buf.length - lag; i++) corr += buf[i] * buf[i + lag];
      corr /= norm;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }
    if (bestCorr < 0.5 || bestLag < 0) return null; // unvoiced / noisy frame
    return sampleRate / bestLag;
  }

  /** Pause analysis (nonlecture activity) without releasing the mic. */
  pause() {
    clearInterval(this.timer);
    this.timer = null;
  }

  resume() {
    if (!this.timer && this.ctx) this.timer = setInterval(() => this._tick(), FRAME_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.ctx?.close();
    this.ctx = null;
    if (this.ownsStream) this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
  }
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const std = (a) => {
  const m = avg(a);
  return Math.sqrt(avg(a.map((v) => (v - m) ** 2)));
};
