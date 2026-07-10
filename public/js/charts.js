// Canvas renderers for the studio. Everything is drawn, not embedded —
// no chart library. Colors mirror the CSS custom properties.

export const INK = {
  amber: '#ffb454',
  green: '#4fd08c',
  orange: '#ff8a4d',
  red: '#ff3b41',
  cyan: '#6ec2e8',
  grid: '#232830',
  dim: '#8a919e',
  band: 'rgba(79, 208, 140, 0.12)',
  bandEdge: 'rgba(79, 208, 140, 0.35)',
};

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 40);
  const h = Math.max(rect.height, 24);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const mmss = (sec) =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Time-series line with optional target band (WPM / energy over time). */
export function drawLineChart(canvas, points, opts) {
  const { ctx, w, h } = setup(canvas);
  const { min, max, band, color, durationSec, ticks = 4, hlines = [] } = opts;
  const padL = 34;
  const padB = 18;
  const padT = 8;
  const plotW = w - padL - 8;
  const plotH = h - padT - padB;
  const dur = Math.max(durationSec || (points.length ? points[points.length - 1][0] : 60), 30);

  const x = (t) => padL + (t / dur) * plotW;
  const y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;

  if (band) {
    ctx.fillStyle = INK.band;
    ctx.fillRect(padL, y(band[1]), plotW, y(band[0]) - y(band[1]));
    ctx.strokeStyle = INK.bandEdge;
    ctx.setLineDash([3, 4]);
    for (const edge of band) {
      ctx.beginPath();
      ctx.moveTo(padL, y(edge));
      ctx.lineTo(padL + plotW, y(edge));
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  for (const hl of hlines) {
    if (hl.y < min || hl.y > max) continue;
    ctx.strokeStyle = hl.color;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(hl.y));
    ctx.lineTo(padL + plotW, y(hl.y));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.strokeStyle = INK.grid;
  ctx.fillStyle = INK.dim;
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= ticks; i++) {
    const v = min + ((max - min) * i) / ticks;
    ctx.beginPath();
    ctx.moveTo(padL, y(v));
    ctx.lineTo(padL + plotW, y(v));
    ctx.stroke();
    ctx.fillText(max - min <= 2 ? v.toFixed(1) : Math.round(v), padL - 5, y(v) + 3);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const t = (dur * i) / 4;
    ctx.fillText(mmss(t), x(t), h - 4);
  }

  if (!points.length) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 6;
  ctx.beginPath();
  points.forEach(([t, v], i) => {
    const px = x(t);
    const py = y(Math.max(min, Math.min(max, v)));
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/** Post-session monologue graph — one bar per talk stretch between interactions. */
export function drawMonologueBars(canvas, gaps, opts) {
  const { ctx, w, h } = setup(canvas);
  const { warnSec, alertSec } = opts;
  if (!gaps.length) return;
  const padB = 18;
  const padT = 8;
  const plotH = h - padT - padB;
  const maxLen = Math.max(...gaps.map((g) => g.len), alertSec);
  const gap = 3;
  const barW = Math.max(4, Math.min(48, w / gaps.length - gap));
  const totalW = gaps.length * (barW + gap) - gap;
  const startX = (w - totalW) / 2;

  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  gaps.forEach((g, i) => {
    const bh = Math.max(2, (g.len / maxLen) * plotH);
    const bx = startX + i * (barW + gap);
    const by = padT + plotH - bh;
    ctx.fillStyle = g.len >= alertSec ? INK.red : g.len >= warnSec ? INK.amber : INK.green;
    ctx.fillRect(bx, by, barW, bh);
    if (barW >= 22) {
      ctx.fillStyle = INK.dim;
      ctx.fillText(mmss(g.len), bx + barW / 2, h - 5);
    }
  });

  // threshold line
  const ty = padT + plotH - (warnSec / maxLen) * plotH;
  ctx.strokeStyle = INK.bandEdge;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(0, ty);
  ctx.lineTo(w, ty);
  ctx.stroke();
  ctx.setLineDash([]);
}

/** Live bottom strip: lecture time as a growing bar, nonlecture activity
 * (lab / video) blocks overlaid in red. */
export function drawTimelineStrip(canvas, nowSec, nonlecture, opts = {}) {
  const { ctx, w, h } = setup(canvas);
  const horizon = Math.max(nowSec * 1.15, opts.minHorizonSec || 600);
  const x = (t) => (t / horizon) * w;
  const barY = h * 0.3;
  const barH = h * 0.4;

  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, barY, w, barH);

  const grad = ctx.createLinearGradient(0, 0, x(nowSec), 0);
  grad.addColorStop(0, 'rgba(110,194,232,0.25)');
  grad.addColorStop(1, 'rgba(110,194,232,0.65)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, barY, x(nowSec), barH);

  for (const block of nonlecture) {
    const start = block.start ?? block[0];
    const end = block.end ?? block[1] ?? nowSec;
    ctx.fillStyle = 'rgba(255,59,65,0.75)';
    ctx.fillRect(x(start), barY - 3, Math.max(2, x(end) - x(start)), barH + 6);
  }

  // playhead
  ctx.fillStyle = INK.red;
  ctx.fillRect(x(nowSec) - 1, barY - 6, 2, barH + 12);

  ctx.fillStyle = INK.dim;
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'left';
  for (let m = 5; m * 60 < horizon; m += 5) {
    ctx.fillRect(x(m * 60), barY + barH, 1, 3);
    ctx.fillText(`${m}m`, x(m * 60) + 3, h - 2);
  }
}

/** Tiny trend line for the history page. */
export function drawSparkline(canvas, values, color = INK.amber) {
  const { ctx, w, h } = setup(canvas);
  if (values.length < 2) {
    if (values.length === 1) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const x = (i) => 3 + (i / (values.length - 1)) * (w - 6);
  const y = (v) => h - 3 - ((v - min) / range) * (h - 6);

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  values.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v))));
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x(values.length - 1), y(values[values.length - 1]), 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/** Needle angle for the WPM dial: sweeps -120°..+120° across the scale. */
export function dialAngle(wpm, scaleMin, scaleMax) {
  const clamped = Math.max(scaleMin, Math.min(scaleMax, wpm));
  const frac = (clamped - scaleMin) / (scaleMax - scaleMin);
  return -120 + frac * 240;
}
