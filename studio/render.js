// FOS Studio · dibujo. El mapa 2D (cancha, los 22, Apolonio, huella de la cámara) y las capas sobre el video (líneas de la cancha, aros en los pies).
import {dominance, teamBorder} from './analysis.js';
import {L, W, footprint, pointInPolygon, pitchLines, invert3, toImage, wSignOf} from './geometry.js';

export const KEEPER = '#4FC3FF', REF = '#FF4FA8', INK = '#0a0e0c', LIME = '#C8F169', LINE_RED = '#FF4040';

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgba = (h, a) => { const [r, g, b] = hex(h); return `rgba(${r},${g},${b},${a})`; };
/** El blanco puro se pierde sobre el pasto: para pintar el espacio se usa un celeste claro. */
export const tintOf = h => { const [r, g, b] = hex(h); return (0.299 * r + 0.587 * g + 0.114 * b) > 215 ? '#BFD8FF' : h; };

function pitchBackdrop(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), k = w / L;
  g.fillStyle = '#1e6e3e'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#227a44';
  for (let i = 1; i < 14; i += 2) g.fillRect(i * w / 14, 0, w / 14, h);
  g.strokeStyle = '#ecf4ee'; g.lineWidth = Math.max(2, 0.25 * k); g.lineJoin = 'round';
  for (const line of pitchLines()) { g.beginPath(); line.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k))); g.stroke(); }
  g.fillStyle = '#ecf4ee';
  for (const [x, y] of [[L / 2, W / 2], [11, W / 2], [L - 11, W / 2]]) { g.beginPath(); g.arc(x * k, y * k, 0.35 * k, 0, 7); g.fill(); }
  return c;
}

export function createMapRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const field = document.createElement('canvas'); field.width = L; field.height = W;   // el espacio, a 1 m por celda; se estira suavizado
  const fctx = field.getContext('2d'), img = fctx.createImageData(L, W);
  let backdrop = null, w = 0, h = 0, k = 1;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1), cw = canvas.clientWidth;
    w = Math.round(cw * dpr); h = Math.round(cw * dpr * W / L); k = w / L;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; backdrop = null; }
  }

  function draw(bundle, f, o) {
    resize();
    if (!backdrop) backdrop = pitchBackdrop(w, h);
    const slots = bundle.slots[f], H = bundle.H[f], fp = o.layers.footprint || o.layers.apolonio ? footprint(H, bundle.clip.width, bundle.clip.height) : [];
    ctx.drawImage(backdrop, 0, 0);
    const colors = bundle.teams.map(t => t.color);
    let pct = null;
    if (o.layers.apolonio) {
      const players = slots.map((p, j) => ({x: p[0], y: p[1], s: p[4], team: j < 11 ? 0 : 1}));
      const dom = dominance(players, {res: 1, gain: o.gain}), c0 = hex(tintOf(colors[0])), c1 = hex(tintOf(colors[1]));
      let inCam = 0, win0 = 0;
      for (let j = 0; j < W; j++) for (let i = 0; i < L; i++) {
        const q = j * L + i, mg = dom.margin[q], t = 1 / (1 + Math.exp(-mg / 1.4)), inside = fp.length ? pointInPolygon(i + 0.5, j + 0.5, fp) : true;
        if (inside) { inCam++; if (mg > 0) win0++; }
        const a = 0.62 * (0.62 + 0.38 * Math.exp(-dom.near[q] / 5)) * (0.40 + 0.60 * (inside ? 1 : 0));
        img.data[q * 4] = t * c0[0] + (1 - t) * c1[0]; img.data[q * 4 + 1] = t * c0[1] + (1 - t) * c1[1]; img.data[q * 4 + 2] = t * c0[2] + (1 - t) * c1[2]; img.data[q * 4 + 3] = a * 255;
      }
      fctx.putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(field, 0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,.62)'; ctx.lineWidth = Math.max(2, 0.28 * k); ctx.lineCap = 'round';
      ctx.beginPath(); for (const s of teamBorder(dom)) { ctx.moveTo(s.x1 * k, s.y1 * k); ctx.lineTo(s.x2 * k, s.y2 * k); } ctx.stroke();
      pct = inCam > 50 ? win0 / inCam : null;
    }
    if (o.layers.footprint && fp.length) {
      ctx.beginPath(); fp.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k))); ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = Math.max(2, 0.3 * k); ctx.stroke();
    }
    const r = 1.15 * k, ring = 0.011 * w;
    const dot = (x, y, fill, rr, outline) => { ctx.beginPath(); ctx.arc(x, y, rr + 2, 0, 7); ctx.fillStyle = INK; ctx.fill(); ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fillStyle = fill; ctx.fill(); if (outline) { ctx.strokeStyle = outline; ctx.lineWidth = Math.max(3, 0.35 * k); ctx.stroke(); } };
    // los 22: primero los medidos y encima los estimados (círculo con aro y un disco de duda)
    const order = [...slots.keys()].sort((a, b) => slots[b][2] - slots[a][2]);
    for (const j of order) {
      const [x, y, vis, rad] = slots[j], team = j < 11 ? 0 : 1, keeper = j === 0 || j === 11, fill = keeper ? KEEPER : colors[team], ghost = o.layers.estimated ? 1 - Math.min(1, vis / 0.98) : 0;
      if (ghost > 0.02 && rad > 0.6) {
        const rr = Math.min(Math.max(rad, 1.8), 9) * k;
        ctx.beginPath(); ctx.arc(x * k, y * k, rr, 0, 7); ctx.fillStyle = rgba(fill, 0.12 * ghost); ctx.fill(); ctx.strokeStyle = rgba(fill, 0.43 * ghost); ctx.lineWidth = 2; ctx.stroke();
      }
      dot(x * k, y * k, fill, r, keeper ? colors[team] : null);
      if (ghost > 0.02) { ctx.beginPath(); ctx.arc(x * k, y * k, r + ring, 0, 7); ctx.strokeStyle = rgba(fill, ghost); ctx.lineWidth = Math.max(3, 0.3 * k); ctx.stroke(); }
      if (o.sel === j) { ctx.beginPath(); ctx.arc(x * k, y * k, r + 3.2 * ring, 0, 7); ctx.strokeStyle = LIME; ctx.lineWidth = Math.max(3, 0.4 * k); ctx.stroke(); }
    }
    if (o.layers.referees) {
      const rf = bundle.referee[f];
      if (rf) { if (rf[2] < 1) { ctx.beginPath(); ctx.arc(rf[0] * k, rf[1] * k, r * 0.88 + ring, 0, 7); ctx.strokeStyle = rgba(REF, 1 - rf[2]); ctx.lineWidth = Math.max(3, 0.3 * k); ctx.stroke(); } dot(rf[0] * k, rf[1] * k, REF, r * 0.88); }
      for (const [x, y, al] of bundle.assistants[f]) { ctx.globalAlpha = al; dot(x * k, y * k, REF, r * 0.7); ctx.globalAlpha = 1; }
    }
    if (o.layers.ball) {
      ctx.fillStyle = 'rgba(255,255,255,.4)';
      for (let g = Math.max(0, f - 9); g < f; g++) { const b = bundle.ball[g]; if (b) { ctx.globalAlpha = 0.15 + 0.5 * (g - (f - 9)) / 9; ctx.beginPath(); ctx.arc(b[0] * k, b[1] * k, 0.4 * k, 0, 7); ctx.fill(); } }
      ctx.globalAlpha = 1;
      const b = bundle.ball[f];
      if (b) { ctx.beginPath(); ctx.arc(b[0] * k, b[1] * k, 0.7 * k + 3, 0, 7); ctx.fillStyle = INK; ctx.fill(); ctx.beginPath(); ctx.arc(b[0] * k, b[1] * k, 0.7 * k, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#F05A3C'; ctx.lineWidth = Math.max(2, 0.3 * k); ctx.stroke(); }
    }
    return {pct, footprintArea: fp.length};
  }

  /** Posición en metros de un clic sobre el mapa. */
  const toPitch = ev => { const b = canvas.getBoundingClientRect(); return [(ev.clientX - b.left) / b.width * L, (ev.clientY - b.top) / b.height * W]; };
  return {draw, toPitch};
}

/** Capas sobre el video: las líneas de la cancha (lo que «ve» la calibración) y un aro en los pies de cada jugador medido. */
export function drawVideoOverlay(canvas, bundle, f, o) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
  const g = canvas.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
  const H = bundle.H[f];
  if (!H) return false;
  const Hinv = invert3(H);
  if (!Hinv) return false;
  const sign = wSignOf(H, Hinv, bundle.clip.width, bundle.clip.height), sx = cw / bundle.clip.width, sy = ch / bundle.clip.height;
  const P = (x, y) => { const p = toImage(Hinv, x, y, sign); return p && [p[0] * sx, p[1] * sy]; };
  if (o.layers.fieldLines) {
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const pass of [[5, 'rgba(10,14,12,.55)'], [2.6, LINE_RED]]) {
      g.lineWidth = pass[0]; g.strokeStyle = pass[1];
      for (const line of pitchLines()) {
        g.beginPath(); let pen = false;
        for (const [x, y] of line) { const p = P(x, y); if (p) { pen ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]); pen = true; } else pen = false; }
        g.stroke();
      }
    }
  }
  if (o.layers.feetRings) {
    bundle.slots[f].forEach(([x, y, vis], j) => {
      if (vis < 0.5) return;
      const keeper = j === 0 || j === 11, col = keeper ? KEEPER : bundle.teams[j < 11 ? 0 : 1].color, pts = [];
      for (let a = 0; a < 24; a++) { const p = P(x + 0.9 * Math.cos(a / 24 * 2 * Math.PI), y + 0.9 * Math.sin(a / 24 * 2 * Math.PI)); if (p) pts.push(p); }
      if (pts.length < 20) return;
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath();
      g.lineWidth = o.sel === j ? 4 : 3; g.strokeStyle = o.sel === j ? LIME : col; g.stroke();
    });
    const rf = bundle.referee[f];
    if (rf && rf[2] > 0.5) {
      const pts = []; for (let a = 0; a < 24; a++) { const p = P(rf[0] + 0.8 * Math.cos(a / 24 * 2 * Math.PI), rf[1] + 0.8 * Math.sin(a / 24 * 2 * Math.PI)); if (p) pts.push(p); }
      if (pts.length >= 20) { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); g.lineWidth = 3; g.strokeStyle = REF; g.stroke(); }
    }
  }
  return true;
}
