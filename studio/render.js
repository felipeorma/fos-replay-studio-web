// FOS Studio · dibujo. El mapa 2D (cancha, los 22, Apolonio, huella de la cámara) y las capas sobre el video (líneas de la cancha, aros en los pies).
import {dominance, teamBorder} from './analysis.js';
import {L, W, footprint, pointInPolygon, pitchLines, invert3, toImage, wSignOf, textHomography, cssMatrix3d, lineMetrics} from './geometry.js';

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


const FONT = '800 64px Inter, system-ui, -apple-system, "Segoe UI", sans-serif', TEXT_H = 80;   // la textura del texto: 64 px de letra en una caja de 80 px de alto

/** Ancho (px) de la caja de un texto en la textura: lo que mide más un margen. */
let measureCtx = null;
export function textureSize(text) {
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = FONT;
  return [Math.ceil(measureCtx.measureText(text).width) + 24, TEXT_H];
}

/** Anotaciones sobre el mapa 2D: líneas de jugadores (con su distancia al arco y su ancho), reflector (aro, halo y estela) y texto escrito en la cancha. */
function drawMapAnnotations(ctx, bundle, f, o, k, w) {
  const anns = o.annotations || [], slots = bundle.slots[f];
  for (const a of anns.filter(a => a.type === 'line')) {
    const pts = a.slots.map(j => [slots[j][0], slots[j][1]]), m = lineMetrics(pts, bundle.teams[a.team].attack);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const pass of [[Math.max(6, 0.9 * k), 'rgba(10,14,12,.55)'], [Math.max(3.5, 0.5 * k), a.color]]) {
      ctx.lineWidth = pass[0]; ctx.strokeStyle = pass[1]; ctx.beginPath(); m.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k))); ctx.stroke();
    }
    const mid = m.points[Math.floor(m.points.length / 2)], label = `${a.name} · ${m.depth.toFixed(1).replace('.', ',')} m del arco · ancho ${Math.round(m.width)} m`;
    ctx.font = `700 ${Math.max(12, 0.017 * w)}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 16, ly = Math.max(14, mid[1] * k - 2.6 * k);
    ctx.fillStyle = 'rgba(10,14,12,.78)'; ctx.beginPath(); ctx.roundRect(mid[0] * k - tw / 2, ly - 11, tw, 22, 11); ctx.fill();
    ctx.fillStyle = a.color; ctx.fillText(label, mid[0] * k, ly + 1);
  }
  for (const a of anns.filter(a => a.type === 'spotlight')) {
    const [x, y, vis] = slots[a.slot], fps = bundle.clip.fps;
    ctx.beginPath(); for (let g = Math.max(0, f - Math.round(2 * fps)); g <= f; g++) { const q = bundle.slots[g][a.slot]; g === Math.max(0, f - Math.round(2 * fps)) ? ctx.moveTo(q[0] * k, q[1] * k) : ctx.lineTo(q[0] * k, q[1] * k); }
    ctx.strokeStyle = rgba(a.color, 0.5); ctx.lineWidth = Math.max(2, 0.3 * k); ctx.lineJoin = 'round'; ctx.stroke();
    const halo = ctx.createRadialGradient(x * k, y * k, 1.2 * k, x * k, y * k, 5.5 * k);
    halo.addColorStop(0, rgba(a.color, 0.34)); halo.addColorStop(1, rgba(a.color, 0)); ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x * k, y * k, 5.5 * k, 0, 7); ctx.fill();
    ctx.setLineDash(vis > 0.5 ? [] : [0.9 * k, 0.7 * k]);   // un jugador estimado se marca con trazo cortado: no se ve en el video
    ctx.strokeStyle = a.color; ctx.lineWidth = Math.max(3, 0.4 * k); ctx.beginPath(); ctx.arc(x * k, y * k, 2.4 * k, 0, 7); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const a of anns.filter(a => a.type === 'pitchText')) {
    ctx.save(); ctx.translate(a.x * k, a.y * k); ctx.rotate(a.rotation * Math.PI / 180);
    ctx.font = `800 ${a.size * k * 0.8}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, 0.12 * a.size * k); ctx.strokeStyle = 'rgba(10,14,12,.45)'; ctx.strokeText(a.text, 0, 0);
    ctx.fillStyle = rgba(a.color, 0.92); ctx.fillText(a.text, 0, 0); ctx.restore();
  }
  for (const j of o.picking || []) {   // jugadores que se están eligiendo para una línea
    const [x, y] = slots[j]; ctx.beginPath(); ctx.arc(x * k, y * k, 1.15 * k + 0.045 * w, 0, 7); ctx.strokeStyle = LIME; ctx.lineWidth = Math.max(3, 0.4 * k); ctx.setLineDash([0.6 * k, 0.5 * k]); ctx.stroke(); ctx.setLineDash([]);
  }
}

/** Reflector sobre el video: se oscurece todo menos un óvalo (el círculo del suelo, en perspectiva) alrededor de cada jugador elegido, y un aro en el suelo. */
function drawSpotlightsOnVideo(g, cw, ch, P, spots, slots) {
  const ring = (x, y, r, n = 40) => { const pts = []; for (let i = 0; i < n; i++) { const p = P(x + r * Math.cos(i / n * 2 * Math.PI), y + r * Math.sin(i / n * 2 * Math.PI)); if (!p) return null; pts.push(p); } return pts; };
  const poly = pts => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); };
  const live = spots.filter(a => slots[a.slot][2] > 0.5);   // solo si el jugador se ve en el video
  if (!live.length) return;
  g.fillStyle = 'rgba(4,8,6,.58)'; g.fillRect(0, 0, cw, ch);
  g.save(); g.globalCompositeOperation = 'destination-out'; if ('filter' in g) g.filter = 'blur(14px)'; g.fillStyle = '#000';
  for (const a of live) { const pts = ring(slots[a.slot][0], slots[a.slot][1], 4.6); if (pts) { poly(pts); g.fill(); } }
  g.restore();
  for (const a of live) {
    const [x, y] = slots[a.slot];
    for (const [r, wd, al] of [[1.7, 5, 1], [2.5, 2.5, 0.55]]) { const pts = ring(x, y, r); if (!pts) continue; poly(pts); g.lineWidth = wd + 3; g.strokeStyle = 'rgba(10,14,12,.6)'; g.stroke(); g.lineWidth = wd; g.strokeStyle = rgba(a.color, al); g.stroke(); }
  }
}

/** Líneas de jugadores sobre el video, pegadas al suelo. */
function drawLinesOnVideo(g, P, lines, slots) {
  for (const a of lines) {
    const pts = a.slots.map(j => [slots[j][0], slots[j][1]]).sort((p, q) => p[1] - q[1]).map(([x, y]) => P(x, y));
    if (pts.some(p => !p)) continue;
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const [wd, col] of [[8, 'rgba(10,14,12,.6)'], [4.5, a.color]]) { g.lineWidth = wd; g.strokeStyle = col; g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke(); }
    for (const p of pts) { g.beginPath(); g.arc(p[0], p[1], 5, 0, 7); g.fillStyle = a.color; g.fill(); g.lineWidth = 2; g.strokeStyle = INK; g.stroke(); }
  }
}

/** Los textos escritos en la cancha, como elementos HTML con la perspectiva del cuadro (matrix3d): crea, mueve y quita los de `layer`. */
export function syncPitchTexts(layer, bundle, f, anns, cw, ch) {
  const H = bundle.H[f], Hinv = H && invert3(H), want = new Map();
  if (Hinv) {
    const sign = wSignOf(H, Hinv, bundle.clip.width, bundle.clip.height);
    for (const a of anns.filter(a => a.type === 'pitchText')) {
      const [tw, th] = textureSize(a.text), M = textHomography(Hinv, sign, a, tw, th, bundle.clip.width, bundle.clip.height, cw, ch);
      if (M) want.set(a.id, {a, M, tw, th});
    }
  }
  for (const el of [...layer.children]) if (!want.has(el.dataset.id)) el.remove();
  for (const [id, {a, M, tw, th}] of want) {
    let el = [...layer.children].find(e => e.dataset.id === id);
    if (!el) { el = document.createElement('div'); el.className = 'pitch-text'; el.dataset.id = id; layer.appendChild(el); }
    if (el.textContent !== a.text) el.textContent = a.text;
    el.style.width = `${tw}px`; el.style.height = `${th}px`; el.style.color = a.color; el.style.transform = cssMatrix3d(M);
  }
  return want.size;
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
    drawMapAnnotations(ctx, bundle, f, o, k, w);
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
  const anns = o.annotations || [], slotsNow = bundle.slots[f];
  drawSpotlightsOnVideo(g, cw, ch, P, anns.filter(a => a.type === 'spotlight'), slotsNow);
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
  drawLinesOnVideo(g, P, anns.filter(a => a.type === 'line'), slotsNow);
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
