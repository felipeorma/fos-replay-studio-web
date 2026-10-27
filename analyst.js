import {playbackRange, cameraLabel, isVideo} from './pages-core.js';
async function pagesNetworkUnavailable() { throw new Error('Esta web no conecta con el servidor del PC. Importa archivos locales.'); }
// FOS Analyst: tactical analysis over tracking data, in the browser. Loads the output of the tracker (tools/tracking) or any tracking data of the same shape, optionally with its
// video, and draws over the pitch (and over the video when the camera is known): the space each team gets to first (Voronoi, or Apollonius with the speeds), the pass network,
// the defensive line that follows its players, the shape of the team, and the analyst's own drawings (zones, arrows, circles, text). The logic is in analysis.js (tested).
import {PITCH, normalize, withSpeeds, lastSpeeds, fromMetrica, frameAt, dominance, teamBorder, control, detectPasses, passNetwork, tagToPass, defensiveLine, attackDirections, clockOf, clockToS, offsideLine, teamShape, teamNetwork, playerStats, coordinatesCsv, homography, invert3, project, hom, clipToFront, assignTrack, expectedPlayers, teamProfile} from './analysis.js';
import {complete} from './prediction.js';
import {displayAt, keyMap, predictionsForDisplay} from './display.js';
import {newUnit, toggleMember, unitShape, labelOf, setPlayer, pack, unpack} from './lines.js';
import {prepareSlots, slotsAt, slotLabel, slotOfTrack} from './slots.js';
import {mlModel} from './prediction_ml.js';
import {analystTrackingSha,prepareAnalystContinuity,analystContinuityFrame,analystContinuityStatus,readAnalystResult} from './analyst-continuity.js';
import {frameAtOrBefore} from './analysis.js';
import {markerColor} from './marker-colors.js';
import {createTacticalAnnotationPanel} from './tactical-annotation-ui.js';

const $ = id => document.getElementById(id);
const COLORS = ['#3f8fd2', '#e8780f'], DPR = Math.min(2, globalThis.devicePixelRatio || 1);
const LANDMARKS = [['Córner arriba-izquierda', 0, 0], ['Córner arriba-derecha', 105, 0], ['Córner abajo-derecha', 105, 68], ['Córner abajo-izquierda', 0, 68], ['Medio campo arriba', 52.5, 0], ['Medio campo abajo', 52.5, 68], ['Centro', 52.5, 34],
  ['Área izq. arriba (esquina)', 16.5, 13.84], ['Área izq. abajo (esquina)', 16.5, 54.16], ['Área izq. arriba (línea de fondo)', 0, 13.84], ['Área izq. abajo (línea de fondo)', 0, 54.16], ['Penal izquierdo', 11, 34],
  ['Área der. arriba (esquina)', 88.5, 13.84], ['Área der. abajo (esquina)', 88.5, 54.16], ['Área der. arriba (línea de fondo)', 105, 13.84], ['Área der. abajo (línea de fondo)', 105, 54.16], ['Penal derecho', 94, 34]];

const S = {data: null, auto: {passes: [], turnovers: [], hasBall: false}, manual: [], i: 0, t: 0, playing: false, live: false, tool: 'select', shapes: [], sel: null, draft: null, lineIds: {0: [], 1: []}, passTag: null,
  view: 'both', focus: null, rev: 0, H: null, Hmap: null, calibPts: [], calibOn: false, hover: null, undo: [], redo: [], nextId: 1, cache: {}, reds: [], fixes: {}, swapped: false, match: null, chunk: null, stale: false, loadingChunk: null};
Object.assign(S, {slots: null, units: [], armed: null, names: {}, look: {num: false, name: true, speed: 'off', measure: true}});   // the lines the analyst makes by clicking, the numbers and names he gives, and what is written on the players (lines.js)
const pitchCv = $('pitch'), pctx = pitchCv.getContext('2d'), vover = $('vover'), vctx = vover.getContext('2d'), video = $('video');
let map = null, lastTs = 0, raf = 0;

// ---------- controls ----------
const C = () => ({
  vor: {on: $('vorOn').checked, mode: $('vorMode').value, gain: $('vorMode').value === 'voronoi' ? 0 : +$('vorGain').value, edges: $('vorEdges').checked, alpha: +$('vorAlpha').value},
  net: {on: $('netOn').checked, team: +$('netTeam').value, win: $('netWin').value, min: +$('netMin').value},
  line: {on: $('lineOn').checked, team: +$('lineTeam').value, method: $('lineMethod').value, dir: $('lineDir').value, gk: $('lineGk').checked, trail: $('lineTrail').checked, off: $('offOn').checked, last: $('lineLast').checked},
  shape: {on: $('shapeOn').checked, team: +$('shapeTeam').value, net: $('shapeNet').checked, fill: $('shapeFill').checked, max: +$('shapeMax').value, len: $('shapeLen').checked, hull: $('shapeHull').checked}});
let dirMemo = {key: '', v: null}, lastSure = null;   // the estimate is made once per frame and picture; when there is not enough to be sure, what was known before stays
const autoDir = () => {   // {dir0, sep, n, sure} over the stretch around the playhead (see `attackDirections`)
  const fr = S.data, key = `${S.rev}|${S.i}`; if (dirMemo.key === key) return dirMemo.v; if (!fr) return {dir0: 1, sep: 0, n: 0, sure: false};
  const d = attackDirections(fr, fr.frames[Math.min(S.i, fr.frames.length - 1)].t, {window: S.match ? 60 : 600}); if (d.sure) lastSure = {rev: S.rev, dir0: d.dir0}; else if (lastSure && lastSure.rev === S.rev) d.dir0 = lastSure.dir0;
  dirMemo = {key, v: d}; return d;
};
const attackDir = (team, c = C()) => {   // +1: it attacks towards x = L. Automatic: from where the two teams stand over the stretch around the playhead (not frame by frame)
  if (c.line.dir !== 'auto') return team === c.line.team ? +c.line.dir : -c.line.dir;   // the direction picked is the one of the team whose line is drawn
  if (!S.data) return team === 0 ? 1 : -1;
  const d = autoDir().dir0; return team === 0 ? d : -d;
};
const teamName = k => (S.data && S.data.teams[k] && S.data.teams[k].name) || `Equipo ${k ? 'B' : 'A'}`;
const teamColor = k => (S.data && S.data.teams[k] && S.data.teams[k].color) || COLORS[k] || '#888';
const fmt = (v, d = 1) => v === null || v === undefined || Number.isNaN(v) ? '–' : v.toFixed(d).replace('.', ',');
const clock = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const status = m => { $('status').textContent = m; };
const effPasses = () => S.auto.passes.concat(S.manual).sort((a, b) => a.t0 - b.t0);
const tacticalAnnotations = createTacticalAnnotationPanel({container: $('tacticalAnnotations'),
  getContext: tacticalAnnotationContext, onChange: () => render(),
  onArm: () => { S.playing = false; setPlayUI(false); video.pause(); S.draft = null; S.armed = null; S.tool = 'select'; drag = null;
    document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select')); renderUnits(); }});
function tacticalAnnotationContext() {
  const fr = S.shown, mode = fr?.slotMode ? 'slot' : S.continuitySession && $('predOn').checked ? 'continuity' : 'track',
    revision = S.match ? S.match.annotation_revision : S.annotationRevision,
    source = S.match ? `match:${S.videoId}` : S.annotationSource;
  return {scope: source && revision ? {source, revision: `${revision}|${mode}`} : null,
    t: fr?.t ?? S.t ?? 0, mode, duration: S.match?.duration ?? S.data?.frames.at(-1)?.t,
    calibrationUrl: S.videoId ? `calibration-review.html?${new URLSearchParams({video: S.videoId, time_s: String(Math.max(0, video.currentTime || 0))})}` : 'calibration-review.html',
    segment: (S.match ? (S.chunk ?? 0) * 100000 : 0) + (S.data?.cuts || []).filter(f => f <= (fr?.f ?? 0)).length,
    players: !S.stale && fr ? [...fr.p, ...(fr.o || []), ...(fr.virtual_players || [])].filter(q => q.state !== 'ultimo_estado' && q.kind !== 'snapshot') : []};
}
function prepareTacticalAnnotationRevision(raw, chunk) {
  S.annotationRevision = null;
  S.annotationSource = `tracking:${typeof raw === 'object' && (raw.source || raw.video) || S.label || 'local'}`;
  const token = (S.annotationLoadToken || 0) + 1; S.annotationLoadToken = token;
  if (chunk) { tacticalAnnotations.sync(); return; }
  analystTrackingSha(typeof raw === 'string' ? raw : JSON.stringify(raw)).then(sha => {
    if (token !== S.annotationLoadToken) return;
    S.annotationRevision = sha; tacticalAnnotations.sync(); render();
  }).catch(() => status('No pude verificar la revisión del tracking para guardar anotaciones.'));
}

// ---------- data ----------
function setData(raw, label, chunk = null) {   // `chunk` = {i, h, t}: a stretch of the whole match: the red cards, the team corrections and the teams swapped by the analyst stay
  S.label = label;
  S.rawTracking=raw;S.continuitySession=null;S.continuityBundle=null;
  const d = withSpeeds(normalize(raw)); if (!d.frames.length) throw new Error('el archivo no trae cuadros');
  $('cameraFootprintLayer').hidden = !d.frames.some(f => f.camera_footprint_m);
  if (chunk) { for (const [id, team] of Object.entries(S.fixes)) assignTrack(d, id, team); if (S.swapped) for (const f of d.frames) for (const q of f.p) q.team = 1 - q.team; withSpeeds(d); }
  S.slots = prepareSlots(chunk ? chunk.slots : raw.slots);   // the eleven of each team that never disappear (team_state.py), if the analysis made them
  S.slotModelVersion = (chunk ? chunk.slots : raw.slots)?.version || null;
  if(chunk?.slots?.policy)$('slotsOn').checked=true;
  S.data = d; S.manual = []; if (!chunk) { S.reds = []; S.fixes = {}; S.swapped = false; S.focus = null; } S.lineIds = {0: [], 1: []}; if (!(chunk && S.slots && S.keptSlots)) { S.names = {}; S.armed = null; for (const u of S.units) u.ids = []; } S.keptSlots = !!(chunk && S.slots); S.passTag = null;   // with slots the ids are the same in every stretch: the names and the lines stay
  S.i = 0; S.t = d.frames[0].t; S.cache = {}; S.rev++;
  if (typeof prepareTacticalAnnotationRevision === 'function') prepareTacticalAnnotationRevision(raw, chunk);
  S.auto = detectPasses(d);
  for (const id of ['netTeam', 'lineTeam', 'shapeTeam', 'redTeam', 'unitTeam']) { const el = $(id), keep = el.value; el.innerHTML = [0, 1].map(k => `<option value="${k}">${teamName(k)}</option>`).join(''); el.value = keep || (id === 'netTeam' || id === 'redTeam' || id === 'unitTeam' ? '0' : '1'); }
  $('timeline').max = d.frames.length - 1; $('timeline').value = 0;
  $('dataInfo').innerHTML = `<b>${label}</b><br>${d.frames.length} cuadros · ${fmt(d.fps)} cuadros/s · ${fmt(d.frames[d.frames.length - 1].t - d.frames[0].t)} s<br>${d.frames[0].p.length} jugadores en el primer cuadro · ${d.hasBall ? `balón: sí · ${S.auto.passes.length} pases detectados · ${S.auto.turnovers.length} pérdidas` : 'sin balón (los pases se marcan a mano)'}`;
  $('labelConfirm').disabled = !d.tracks; refreshLabelInfo(); stageTitle(label); $('clockTotal').textContent = chunk && S.match ? `/ ${fmtMin(S.match.duration)}` : `/ ${clock(d.frames[d.frames.length - 1].t)}`; if (!chunk) setPlayUI(false);
  syncTeamInputs(); updateNetInfo(); renderReds(); renderPredNote();
  if (chunk) {   // a stretch of the match: its own camera, and the playhead stays where the video is
    const byFrame = {}; for (const [k, v] of Object.entries(chunk.h)) byFrame[+k] = v; const keys = Object.keys(byFrame).map(Number).sort((a, b) => a - b);
    S.Hmap = {byFrame, keys, fps: raw.fps,exact:!!raw.segment_artifacts}; S.H = null; S.calib = null; S.camJob = null; S.blocked = false; S.chunk = chunk.i; S.stale = false;
    S.i = frameAtOrBefore(d, chunk.t); S.t = chunk.t; $('timeline').value = S.i; render(); drawMarkers(); return;
  }
  seek(0); drawMarkers(); status(`Datos cargados: ${label}`);
}
async function loadFile(file) {
  const text = await file.text();
  try { setData(file.name.toLowerCase().endsWith('.csv') ? text : JSON.parse(text), file.name); } catch (e) { status(`No pude leer ${file.name}: ${e.message}`); }
}
function installContinuity(bundle) {
  S.continuitySession=prepareAnalystContinuity(S.rawTracking,S.data,bundle);
  S.continuityBundle=S.continuitySession?bundle:null;
  if(!S.continuitySession)return;
  // The reviewed result's continuity is the default for this dataset. The user
  // can explicitly return to observations with the existing prediction switch.
  $('predOn').checked=bundle.settings?.continuity?.enabled!==false;$('slotsOn').checked=false;
  const colors={...bundle.settings?.colors,...(bundle.colors?.colors||bundle.colors||{})};
  S.continuitySession.markerColors=colors;
  for(const k of [0,1])if(/^#[a-f0-9]{6}$/i.test(colors[`team${k}`]||''))S.data.teams[k].color=colors[`team${k}`];
  S.look.num=false;S.look.speed='off';$('lookNum').checked=false;$('lookSpeed').value='off';
  S.cache={};S.rev++;syncTeamInputs();renderPredNote();render();
}
function rebuildEditedContinuity(){
  if(!S.continuitySession||!S.continuityBundle)return;
  const bundle=S.continuityBundle,roles={...bundle.settings?.roles};
  for(const frame of S.rawTracking.frames||[]){
    const f=frame.frame??frame.f,segment=(S.rawTracking.cuts||[]).filter(c=>c<=f).length;
    for(const q of frame.players||[]){
      const id=String(q.track_id??q.id),fixed=Object.hasOwn(S.fixes,id);
      if(!fixed&&!S.swapped)continue;
      const original=Number(q.team),team=fixed?Number(S.fixes[id]):S.swapped&&original>=0?1-original:original;
      const keeper=['portero','goalkeeper'].includes(q.rol||q.role);
      roles[JSON.stringify([segment,id,q.identity_segment??null])]=[0,1].includes(team)?`${keeper?'goalkeeper':'team'}${team}`:'unknown';
    }
  }
  const colors=S.continuitySession.markerColors;
  S.continuitySession=prepareAnalystContinuity(S.rawTracking,S.data,{...bundle,settings:{...bundle.settings,roles}});
  S.continuitySession.markerColors=colors;
}
async function openReviewedResult() { throw new Error('Importa tracking desde tu dispositivo.'); }
const updateNetInfo = () => { $('netInfo').textContent = !S.data ? '' : S.auto.hasBall ? `${S.auto.passes.length} pases detectados con el balón${S.manual.length ? ` + ${S.manual.length} marcados a mano` : ''}.` : `Sin balón en los datos: ${S.manual.length} pases marcados a mano. Usa «Marcar pase».`; };
/** A live source (a tracking reader on a socket, for example) pushes frames of the same shape as the tracker's JSON. */
function push(rawFrame) {
  if (!S.data) { S.data = withSpeeds(normalize({fps: 25, pitch: [PITCH.L, PITCH.W], frames: [rawFrame]})); S.auto = detectPasses(S.data); $('timeline').max = 0; seek(0); return; }
  const n = normalize({fps: S.data.fps, pitch: [S.data.L, S.data.W], frames: [{...rawFrame, frame: S.data.frames.length}]}).frames[0]; if (rawFrame.t === undefined) n.t = S.data.frames.length / S.data.fps;
  S.data.frames.push(n); if (n.b) S.data.hasBall = true; lastSpeeds(S.data);
  if (S.data.frames.length % Math.round(S.data.fps * 2) === 0) { withSpeeds(S.data); S.auto = detectPasses(S.data); updateNetInfo(); drawMarkers(); }   // the passes are looked for again every two seconds of data
  $('timeline').max = S.data.frames.length - 1; if (S.live) seek(S.data.frames.length - 1);
  if (S.data.frames.length % Math.round(S.data.fps) === 0) $('dataInfo').innerHTML = `<b>En vivo</b><br>${S.data.frames.length} cuadros · ${fmt(S.data.fps)} cuadros/s · ${fmt(S.t)} s<br>${S.auto.passes.length} pases detectados · ${S.auto.turnovers.length} pérdidas`;
}

// ---------- the pitch canvas ----------
function sizePitch() {
  const pane = $('pitchPane'), w = Math.max(320, pane.clientWidth - 16), M = 3.5, ratio = (PITCH.L + 2 * M) / (PITCH.W + 2 * M), h = w / ratio;
  pitchCv.style.width = `${w}px`; pitchCv.style.height = `${h}px`; pitchCv.width = Math.round(w * DPR); pitchCv.height = Math.round(h * DPR);
  const k = w / (PITCH.L + 2 * M);
  map = {affine: true, k, pt: (x, y) => ({x: (x + M) * k, y: (y + M) * k}), inv: (px, py) => ({x: px / k - M, y: py / k - M}), r: m => m * k, w, h};
}
function drawPitchMarks(ctx, m) { drawPitch(ctx, m, true, true); }
function drawPitch(ctx, m, lines = true, marksOnly = false) {
  if (!marksOnly) { ctx.fillStyle = '#2a8049'; ctx.fillRect(0, 0, m.w, m.h); }
  const P = (x, y) => m.pt(x, y);
  if (!marksOnly) for (let i = 0; i < 12; i += 2) { const a = P(i * PITCH.L / 12, 0), b = P((i + 1) * PITCH.L / 12, PITCH.W); ctx.fillStyle = 'rgba(255,255,255,.035)'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); }
  if (!lines) return;
  ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1.6; ctx.beginPath();
  const rect = (x0, y0, x1, y1) => { const a = P(x0, y0), b = P(x1, y1); ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y); };
  rect(0, 0, PITCH.L, PITCH.W); const mid = P(52.5, 0), mid2 = P(52.5, PITCH.W); ctx.moveTo(mid.x, mid.y); ctx.lineTo(mid2.x, mid2.y);
  rect(0, 13.84, 16.5, 54.16); rect(0, 24.84, 5.5, 43.16); rect(88.5, 13.84, PITCH.L, 54.16); rect(99.5, 24.84, PITCH.L, 43.16);
  const c = P(52.5, 34); ctx.moveTo(c.x + m.r(9.15), c.y); ctx.arc(c.x, c.y, m.r(9.15), 0, Math.PI * 2);
  for (const [px, sx] of [[11, 1], [94, -1]]) { const s = P(px, 34), half = Math.acos(5.5 / 9.15); ctx.moveTo(s.x + m.r(9.15) * Math.cos(sx > 0 ? -half : Math.PI - half), s.y + m.r(9.15) * Math.sin(sx > 0 ? -half : Math.PI - half)); ctx.arc(s.x, s.y, m.r(9.15), sx > 0 ? -half : Math.PI - half, sx > 0 ? half : Math.PI + half); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,.75)'; for (const [x, y] of [[52.5, 34], [11, 34], [94, 34]]) { const p = P(x, y); ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill(); }
}

function drawPitchLines() { drawPitchMarks(pctx, map); }
// ---------- layers ----------
const key = (...a) => a.join('|');
function domAt(fr, c, res) {
  const k = key(S.i, fr.t, c.vor.gain, S.data.frames.length,fr.continuity_mode||'observations'), slot = S.cache[res] || (S.cache[res] = {}); if (slot.k === k) return slot.v;   // one entry per resolution and evidence layer
  const v = dominance(fr.p, {res, gain: c.vor.gain}); slot.k = k; slot.v = v; return v;
}
// The space of each team, drawn as light and not as cells: a field computed on a fine grid (colour of the nearest team, fading into each other across the border and
// glowing around each player), painted smooth, and the line between the teams a curve found between the grid points (`teamBorder`), never the staircase of the cells.
const tints = {}, clamp01 = v => Math.max(0, Math.min(1, v)), smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
function tintOf(hex) {   // the team colour a little more alive and never muddy (the players keep the exact one): the wash is made from this
  if (tints[hex]) return tints[hex];
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0; if (sat < .12) { const v = Math.round(255 * Math.max(.16, Math.min(.9, l))); return tints[hex] = [v, v, v]; }   // a white or a black shirt stays neutral: raising its saturation would paint it red
  if (d) h = 60 * (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  sat = Math.max(.62, Math.min(.92, sat * 1.15 + .12)); const L = Math.max(.54, Math.min(.68, l + .1)), a = sat * Math.min(L, 1 - L), f = k => { const q = (k + h / 30) % 12; return Math.round(255 * (L - a * Math.max(-1, Math.min(q - 3, 9 - q, 1)))); };
  return tints[hex] = [f(0), f(8), f(4)];
}
const fieldCv = document.createElement('canvas'), warpCv = document.createElement('canvas');
function fieldImage(dom, c) {   // one pixel per cell of the grid: colour from who is nearer, strength from how close the nearest player is and how far from the border; over a dark neutral base, so the grass does not muddy the colours
  const {nx, ny, margin, near} = dom; fieldCv.width = nx; fieldCv.height = ny; const g = fieldCv.getContext('2d'), img = g.createImageData(nx, ny), d = img.data;
  const A = tintOf(teamColor(0)), B = tintOf(teamColor(1)), D = [7, 18, 15], SOFT = 2.6, REACH = 10, top = Math.min(.95, c.vor.alpha * 2.6), base = Math.min(.5, c.vor.alpha * 1.2);
  for (let k = 0; k < nx * ny; k++) {
    const m = margin[k], u = smooth(-SOFT, SOFT, m), glow = Math.exp(-((near[k] / REACH) ** 2)), seam = .74 + .26 * smooth(0, SOFT, Math.abs(m)), a = top * (.4 + .6 * glow) * seam, ao = a + base * (1 - a), o = k * 4;
    for (let q = 0; q < 3; q++) d[o + q] = ((B[q] + (A[q] - B[q]) * u) * a + D[q] * base * (1 - a)) / ao;
    d[o + 3] = 255 * ao;
  }
  g.putImageData(img, 0, 0); return fieldCv;
}
function warpField(ctx, tex, dom, m, S = 4) {   // the field through the camera: the grid cut in triangles of S cells, each one stretched onto the picture, then painted once
  const {nx, ny, res} = dom, W = ctx.canvas.width, H = ctx.canvas.height; if (!W || !H) return;   // a picture with no size (the pane is collapsed or hidden): nothing to paint, and drawing a 0-size canvas throws
  if (warpCv.width !== W || warpCv.height !== H) { warpCv.width = W; warpCv.height = H; }
  const g = warpCv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H); g.setTransform(DPR, 0, 0, DPR, 0, 0); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.globalCompositeOperation = 'copy';
  const pt = (i, j) => m.pt(i * res, j * res), cw = W / DPR, ch = H / DPR, pad = 2;
  const tri = (s0, s1, s2, d0, d1, d2) => {
    const sx1 = s1[0] - s0[0], sy1 = s1[1] - s0[1], sx2 = s2[0] - s0[0], sy2 = s2[1] - s0[1], det = sx1 * sy2 - sx2 * sy1; if (!det) return;
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3, grow = q => { const dx = q.x - cx, dy = q.y - cy, n = Math.hypot(dx, dy) || 1; return {x: q.x + dx / n * .7, y: q.y + dy / n * .7}; };   // a little larger, so no seam is left between neighbours
    const e0 = grow(d0), e1 = grow(d1), e2 = grow(d2), dx1 = d1.x - d0.x, dy1 = d1.y - d0.y, dx2 = d2.x - d0.x, dy2 = d2.y - d0.y;
    const a = (dx1 * sy2 - dx2 * sy1) / det, b = (dy1 * sy2 - dy2 * sy1) / det, cc = (dx2 * sx1 - dx1 * sx2) / det, dd = (dy2 * sx1 - dy1 * sx2) / det, e = d0.x - a * s0[0] - cc * s0[1], f = d0.y - b * s0[0] - dd * s0[1];
    const x0 = Math.min(s0[0], s1[0], s2[0]) - 1, y0 = Math.min(s0[1], s1[1], s2[1]) - 1, x1 = Math.max(s0[0], s1[0], s2[0]) + 1, y1 = Math.max(s0[1], s1[1], s2[1]) + 1, sx = Math.max(0, x0), sy = Math.max(0, y0), sw = Math.min(nx, x1) - sx, sh = Math.min(ny, y1) - sy;
    if (sw <= 0 || sh <= 0) return;
    g.save(); g.beginPath(); g.moveTo(e0.x, e0.y); g.lineTo(e1.x, e1.y); g.lineTo(e2.x, e2.y); g.closePath(); g.clip(); g.transform(a, b, cc, dd, e, f); g.drawImage(tex, sx, sy, sw, sh, sx, sy, sw, sh); g.restore();
  };
  for (let j0 = 0; j0 < ny; j0 += S) for (let i0 = 0; i0 < nx; i0 += S) {
    const i1 = Math.min(i0 + S, nx), j1 = Math.min(j0 + S, ny), p00 = pt(i0, j0), p10 = pt(i1, j0), p11 = pt(i1, j1), p01 = pt(i0, j1); if (!p00 || !p10 || !p11 || !p01) continue;
    const xs = [p00.x, p10.x, p11.x, p01.x], ys = [p00.y, p10.y, p11.y, p01.y]; if (Math.max(...xs) < -pad || Math.min(...xs) > cw + pad || Math.max(...ys) < -pad || Math.min(...ys) > ch + pad) continue;   // off the picture
    tri([i0, j0], [i1, j0], [i1, j1], p00, p10, p11); tri([i0, j0], [i1, j1], [i0, j1], p00, p11, p01);
  }
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(warpCv, 0, 0); ctx.restore();
}
function drawDominance(ctx, m, dom, c) {
  const tex = fieldImage(dom, c), {nx, ny, res} = dom;
  if (m.affine) { const a = m.pt(0, 0), b = m.pt(nx * res, ny * res); ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(tex, a.x, a.y, b.x - a.x, b.y - a.y); ctx.restore(); }
  else warpField(ctx, tex, dom, m);
  if (c.vor.edges) {   // where the two teams meet: a soft light under a fine white line
    const line = teamBorder(dom); if (!line.length) return;
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const [w, a] of [[m.affine ? 7 : 5, .1], [m.affine ? 3.2 : 2.4, .16], [m.affine ? 1.4 : 1.1, .92]]) {
      ctx.strokeStyle = `rgba(255,255,255,${a})`; ctx.lineWidth = w; ctx.beginPath();
      for (const q of line) { const p = m.pt(q.x1, q.y1), r = m.pt(q.x2, q.y2); if (p && r) { ctx.moveTo(p.x, p.y); ctx.lineTo(r.x, r.y); } }
      ctx.stroke();
    }
    ctx.restore();
  }
}
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; }
function drawLineLayer(ctx, m, fr, c) {
  const team = c.line.team, opts = {dir: attackDir(team, c), method: c.line.method, ids: S.lineIds[team], includeGK: c.line.gk}, col = teamColor(team);
  const path = (line, a, dash) => { ctx.save(); ctx.strokeStyle = hexA('#ffffff', a); ctx.lineWidth = dash ? 2 : 3.5; ctx.setLineDash(dash ? [8, 7] : []); ctx.beginPath(); const p0 = m.pt(line.x, 0), p1 = m.pt(line.x, PITCH.W); if (p0 && p1) { ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); } ctx.stroke(); ctx.restore(); };
  if (c.line.trail && S.data) for (let s = 1; s <= 8; s++) { const g = S.data.frames[frameAt(S.data, fr.t - s * .75)], l = g && defensiveLine(g, team, opts); if (l) path(l, .5 * (1 - s / 9), true); }
  const line = defensiveLine(fr, team, opts); if (!line) return null;
  ctx.save(); const a = m.pt(line.x, 0), b = m.pt(line.x, PITCH.W); if (a && b) { ctx.strokeStyle = col; ctx.lineWidth = 3.5; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.4; ctx.setLineDash([9, 7]); ctx.stroke(); }
  ctx.setLineDash([]); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fillStyle = col;
  const pts = line.points.slice().sort((p, q) => p.y - q.y).map(p => m.pt(p.x, p.y)).filter(Boolean); ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.stroke();   // the players that make it, joined
  if (a && m.affine) { const t = `${fmt(line.d)} m`; ctx.font = '600 12px system-ui'; const w = ctx.measureText(t).width + 12; ctx.fillStyle = col; ctx.fillRect(a.x - w / 2, a.y + 4, w, 18); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(t, a.x, a.y + 17); }
  ctx.restore();
  if (c.line.last && opts.method !== 'last') {   // the last man, alongside the average of the back four
    const lm = defensiveLine(fr, team, {...opts, method: 'last'}), a2 = lm && m.pt(lm.x, 0), b2 = lm && m.pt(lm.x, PITCH.W), who = lm && m.pt(lm.points[0].x, lm.points[0].y);
    if (a2 && b2) {
      ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.95)'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.setLineDash([2, 6]); ctx.beginPath(); ctx.moveTo(a2.x, a2.y); ctx.lineTo(b2.x, b2.y); ctx.stroke(); ctx.setLineDash([]);
      if (who) { ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(who.x, who.y, m.affine ? 13 : 12, 0, Math.PI * 2); ctx.stroke(); }
      if (m.affine) { const tx = `último · ${fmt(lm.d)} m`; ctx.font = '600 12px system-ui'; const w = ctx.measureText(tx).width + 12; ctx.fillStyle = 'rgba(20,24,28,.85)'; ctx.fillRect(b2.x - w / 2, b2.y - 22, w, 18); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(tx, b2.x, b2.y - 9); }
      ctx.restore();
    }
  }
  if (c.line.off) { const od = offsideLine(fr, team, {dir: opts.dir}); if (od !== null) { const x = opts.dir > 0 ? od : PITCH.L - od, p0 = m.pt(x, 0), p1 = m.pt(x, PITCH.W); if (p0 && p1) { ctx.save(); ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.setLineDash([3, 6]); ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke(); ctx.restore(); } } }
  return line;
}
function netWindow(c) { const t1 = S.t, t0 = c.net.win === 'all' ? 0 : Math.max(0, t1 - +c.net.win); return {t0, t1}; }
function drawNetwork(ctx, m, c) {
  const w = netWindow(c), net = passNetwork(S.data, effPasses(), c.net.team, {...w, minPasses: c.net.min}), col = teamColor(c.net.team); if (!net.nodes.length) return net;
  const byId = new Map(net.nodes.map(n => [n.id, n])), maxN = Math.max(1, ...net.edges.map(e => e.n)), maxT = Math.max(1, ...net.nodes.map(n => n.touches));
  ctx.save(); ctx.lineCap = 'round';
  for (const e of net.edges) { const a = byId.get(e.a), b = byId.get(e.b), p = m.pt(a.x, a.y), q = m.pt(b.x, b.y); if (!p || !q) continue; ctx.strokeStyle = hexA('#ffffff', .25 + .6 * e.n / maxN); ctx.lineWidth = 1.5 + 7 * e.n / maxN; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
  for (const n of net.nodes) { const p = m.pt(n.x, n.y); if (!p) continue; const r = 8 + 10 * n.touches / maxT; ctx.fillStyle = col; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = '700 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(n.id, p.x, p.y + 4); }
  ctx.restore(); return net;
}
function drawShape(ctx, m, s, fr, sel) {
  const P = q => m.pt(q.x, q.y), col = s.color, a = s.alpha;
  const pts = s.pts.map(q => { const o = followPos(s, fr); return o ? {x: q.x + o.dx, y: q.y + o.dy} : q; });
  ctx.save(); ctx.lineWidth = sel ? 4 : 2.8; ctx.strokeStyle = col; ctx.fillStyle = hexA(col, a); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const poly = list => { ctx.beginPath(); list.forEach((q, i) => { const p = P(q); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }); };
  if (s.type === 'zone') { poly(pts); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  else if (s.type === 'rect') { const [p, q] = pts; poly([p, {x: q.x, y: p.y}, q, {x: p.x, y: q.y}]); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  else if (s.type === 'circle') { const [c0, e] = pts, r = Math.hypot(e.x - c0.x, e.y - c0.y), ring = Array.from({length: 49}, (_, i) => ({x: c0.x + r * Math.cos(i / 48 * Math.PI * 2), y: c0.y + r * Math.sin(i / 48 * Math.PI * 2)})); poly(ring); ctx.closePath(); ctx.fill(); ctx.stroke(); }
  else if (s.type === 'pen') { poly(pts); ctx.stroke(); }
  else if (s.type === 'line' || s.type === 'arrow') {
    poly(pts); ctx.stroke();
    if (s.type === 'arrow') { const p = P(pts[0]), q = P(pts[1]), ang = Math.atan2(q.y - p.y, q.x - p.x), h = 14; ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x - h * Math.cos(ang - .45), q.y - h * Math.sin(ang - .45)); ctx.lineTo(q.x - h * Math.cos(ang + .45), q.y - h * Math.sin(ang + .45)); ctx.closePath(); ctx.fill(); }
  } else if (s.type === 'text') { const p = P(pts[0]); ctx.font = '700 16px system-ui'; ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 4; ctx.strokeText(s.text, p.x, p.y); ctx.fillText(s.text, p.x, p.y); }
  if (sel && s.type !== 'text') { ctx.fillStyle = '#fff'; for (const q of pts) { const p = P(q); ctx.fillRect(p.x - 3, p.y - 3, 6, 6); } }
  ctx.restore();
}
const followPos = (s, fr) => { if (!s.follow || !fr) return null; const p = fr.p.find(q => q.id === s.follow); return p ? {dx: p.x - s.anchor.x, dy: p.y - s.anchor.y} : null; };
const visible = s => (s.t0 === null || s.t0 === undefined || S.t >= s.t0) && (s.t1 === null || s.t1 === undefined || S.t <= s.t1);
// the player picked in the table: where he went over the whole stretch (the path, and on the pitch a heat map of where he spent his time) and a ring around him now
const trackCache = {key: '', pts: []};
function trackOf(id) {
  const key = `${id}:${S.rev}:${S.data.frames.length}`; if (trackCache.key === key) return trackCache.pts;
  const pts = []; for (const f of S.data.frames) { const q = f.p.find(o => o.id === id); if (q) pts.push({t: f.t, x: q.x, y: q.y, team: q.team}); }
  trackCache.key = key; trackCache.pts = pts; return pts;
}
function drawFocus(ctx, m, fr) {
  const pts = trackOf(S.focus); if (!pts.length) return; const col = teamColor(pts[0].team);
  ctx.save(); ctx.lineCap = ctx.lineJoin = 'round';
  if (m.affine) {   // heat: every half second he stood somewhere paints a soft spot; the busy places add up
    const R = m.r(4.5) || 40;
    for (let i = 0; i < pts.length; i += Math.max(1, Math.round(S.data.fps / 2))) { const p = m.pt(pts[i].x, pts[i].y); if (!p) continue; const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R); g.addColorStop(0, hexA(col, .16)); g.addColorStop(1, hexA(col, 0)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.strokeStyle = hexA(col, .9); ctx.lineWidth = m.affine ? 2.5 : 2; ctx.setLineDash([]); ctx.beginPath(); let pen = false;
  for (const q of pts) { const p = m.pt(q.x, q.y); if (!p) { pen = false; continue; } if (pen) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); pen = true; }
  ctx.stroke();
  const now = fr.p.find(o => o.id === S.focus), p = now && m.pt(now.x, now.y); if (p) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, m.affine ? 16 : 13, 0, Math.PI * 2); ctx.stroke(); }
  ctx.restore();
}
// a red card: from that instant the team has 10, so 10 seen is the whole team and the 11th is neither expected nor predicted
const expectedAt = (team, t) => expectedPlayers(S.reds, team, t);
function renderReds() {
  $('redList').innerHTML = S.reds.length ? S.reds.map((r, i) => `<button data-i="${i}" title="Quitar esta expulsión"><span class="dot" style="background:${teamColor(r.team)}"></span>${teamName(r.team)} desde ${clock(r.t)} <span class="muted">· quitar ✕</span></button>`).join('') : '<p class="muted small">Ninguna.</p>';
}
const redsChanged = () => { S.rev++; S.cache = {}; renderReds(); renderPredNote(); drawMarkers(); render(); };
$('redAdd').onclick = () => {
  if (!S.data) { status('Primero abre datos o analiza un video'); return; }
  S.reds.push({team: +$('redTeam').value, t: S.t}); S.reds.sort((a, b) => a.t - b.t); redsChanged(); status(`${teamName(+$('redTeam').value)} juega con 10 desde ${clock(S.t)}`);
};
$('redList').onclick = e => { const b = e.target.closest('button[data-i]'); if (!b) return; S.reds.splice(+b.dataset.i, 1); redsChanged(); };
// players the video does not show but that it showed a moment before or after, placed by prediction.js; off unless the switch is on
const predCache = {key: '', val: null};
let mlM = null, mlB = null, mlLoading = null;   // the learned models of the players who leave the picture and of those who come into it (models/prediction_*.json), fetched the first time the switch is on
function loadMl() { mlM = mlB = null; return mlLoading ||= Promise.resolve(null); }
const dirCache = new Map();
const mlDir = (team, t) => {   // which way the team attacks, from the stretch around the moment (a bucket of 10 s: the estimate is not made again for every player)
  const key = `${S.rev}|${S.match ? S.chunk : 0}|${Math.round(t / 10)}`; let d = dirCache.get(key);
  if (d === undefined) { d = attackDirections(S.data, Math.round(t / 10) * 10, {window: S.match ? 60 : 600}).dir0; if (dirCache.size > 400) dirCache.clear(); dirCache.set(key, d); }
  return team === 0 ? d : -d;
};
function predicted() {
  if (!S.data || !$('predOn').checked) return null;
  if(S.continuitySession)return null; // reviewed engine replaces the old short forecast
  if (!mlLoading) loadMl();
  const key = `${S.data.frames.length}:${S.rev}:${mlM ? 'ml' : 'plain'}${mlB ? 'b' : ''}`;
  if (predCache.key !== key) { predCache.key = key; predCache.val = complete(S.data, {perTeam: expectedAt, ml: mlM ? {model: mlM, back: mlB, dirOf: mlDir} : null}); }
  return predCache.val;
}
function renderPredNote() {
  if(S.continuitySession){const el=$('predNote');el.hidden=!$('predOn').checked;
    el.textContent='Continuidad 2D revisada: conserva las personas ya vistas. Borde discontinuo = posición estimada; punteado = último estado fechado. No confirma el movimiento oculto ni añade detecciones al video.';return;}
  const el = $('predNote'), p = predicted(); el.hidden = !p; if (!p) return;
  const held = m => m && m.held_out ? Object.values(m.held_out) : [], at = (m, h) => held(m).map(rows => rows.find(r => r.h === h)).filter(Boolean);
  const range = (rows, k) => { const v = rows.map(r => r[k][0]); return v.length ? (Math.min(...v) === Math.max(...v) ? `${fmt(v[0])}` : `${fmt(Math.min(...v))} a ${fmt(Math.max(...v))}`) : ''; };
  const sent = (m, who) => `${who}: a 1 s la mediana del error es ${range(at(m, 1), 'modelo')} m (con la extrapolación simple, ${range(at(m, 1), 'cinematica')} m), a 2 s ${range(at(m, 2), 'modelo')} m (${range(at(m, 2), 'cinematica')} m)`;
  const how = p.method === 'ml'
    ? ` Se los ubica con modelos aprendidos de seguimientos de este mismo sistema (${Object.keys(mlM.sources).length} fuentes: ${mlM.note}), que corrigen la extrapolación de su velocidad con lo que se ve en el cuadro: uno para los que salen de la toma${mlB ? ' y otro, el mismo con el tiempo invertido, para los que entran' : ''}. Medido en tramos y tomas que los modelos no vieron, ${sent(mlM, 'los que salen')}${mlB ? `; ${sent(mlB, 'los que entran')}` : ''}.`
    : ' Se los ubica extrapolando su velocidad (que se apaga en un segundo).';
  el.innerHTML = `Se coloca a ${p.players} jugadores que el video dejó de mostrar, en ${p.frames} de ${S.data.frames.length} cuadros (círculos huecos; en la exportación llevan <i>predicho</i>). Solo se usa lo que este mismo video mostró: a quien nunca se vio no se le inventa un lugar.${how} Un hueco dentro de un recorrido se rellena con una recta entre sus dos extremos que se curva un poco cuando el hueco es largo (de 1 s o menos, recta; de 3 s en adelante, la mitad de la curva).`;
}
$('predOn').onchange = () => { renderPredNote(); render(); };
$('slotsOn').onchange = () => { render(); };
let slotsNoteAt = 0;
function renderSlotsLayer() {   // the switch is there only when the analysis made the eleven of each team; the note says how many of the twenty-two are seen right now
  const has = !!S.slots; $('slotsLayer').hidden = !has; if (!has || !S.shown || !S.shown.slotMode) return;
  const now = performance.now(); if (now - slotsNoteAt < 250) return; slotsNoteAt = now;
  const count=S.shown.p.length,seen = S.shown.p.filter(q => q.evidence_state==='detectado'||!q.position_source&&q.est < .5).length;
  $('slotsNote').textContent = `${modelReviewMessage(S.match,S.slotModelVersion)} ${count} posiciones activas; ${seen} con detección actual y ${count-seen} sin detección actual. El movimiento 2D usa hipótesis anónimas por equipo: un dorsal o una identidad real requiere revisión. Borde discontinuo: posición estimada o suavizada; los tramos largos sin cámara tienen mayor incertidumbre. Los eventos revisados reducen el número desde su segundo exacto.`.trim();
}
/** The lines the analyst made: each one joins its players from one touchline to the other. Its name and, if asked, how far it is from its own goal and how wide it is, go in a label drawn after the players (`drawUnitLabels`) so nothing covers it. */
function drawUnits(ctx, m, fr, c) {
  for (const u of S.units) {
    if (!u.on) continue;
    const sh = unitShape(fr, u, {dir: attackDir(u.team, c), L: S.data ? S.data.L : PITCH.L}); if (!sh || sh.visible < 2) continue;
    const pts = sh.members.map(q => m.pt(q.x, q.y)).filter(Boolean); if (pts.length < 2) continue;
    ctx.save(); ctx.lineCap = ctx.lineJoin = 'round'; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = 'rgba(8,12,16,.55)'; ctx.lineWidth = 6; ctx.stroke();   // a dark edge, so it reads over the pale and over the coloured space
    ctx.strokeStyle = u.color; ctx.lineWidth = 3; ctx.setLineDash(S.armed === u.id ? [7, 5] : []); ctx.stroke(); ctx.restore();
  }
}
function drawUnitLabels(ctx, m, fr, c) {
  if (!m.affine) return;
  let row = 0;
  for (const u of S.units) {
    if (!u.on) continue;
    const sh = unitShape(fr, u, {dir: attackDir(u.team, c), L: S.data ? S.data.L : PITCH.L}); if (!sh) continue;
    const pts = sh.members.map(q => m.pt(q.x, q.y)).filter(Boolean); if (!pts.length) continue;
    const a = pts.reduce((o, p) => ({x: o.x + p.x / pts.length, y: o.y + p.y / pts.length}), {x: 0, y: 0}), t = `${u.name}${S.look.measure ? ` · ${fmt(sh.depth)} m${sh.visible > 1 ? ` · ancho ${fmt(sh.width)} m` : ''}` : ''}${sh.visible < sh.total ? ` · ${sh.visible} de ${sh.total}` : ''}`;
    ctx.save(); ctx.font = '600 11px system-ui'; const w = ctx.measureText(t).width + 12, x = Math.max(w / 2 + 3, Math.min(m.w - w / 2 - 3, a.x)), y = Math.max(20, Math.min(m.h - 6, a.y - 28 - row++ * 20));
    ctx.fillStyle = 'rgba(14,18,22,.88)'; ctx.fillRect(x - w / 2, y - 12, w, 17); ctx.strokeStyle = u.color; ctx.lineWidth = 1.2; ctx.strokeRect(x - w / 2, y - 12, w, 17); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(t, x, y); ctx.restore();
  }
}
const ROLE_STYLE = {arbitro: {color: '#ffd23f', letter: 'A'}, juez_linea: {color: '#ffb02e', letter: 'L'}, calentando: {color: '#7cc4ff', letter: 'C'}, recogepelotas: {color: '#7dffb3', letter: 'R'}, fotografo: {color: '#c7a6ff', letter: 'F'}, personal: {color: '#c7c7cc', letter: 'P'}, dudoso: {color: '#6b6b73', letter: '?'}};
const ROLE_NAME = {arbitro: 'árbitro', juez_linea: 'juez de línea', calentando: 'suplente calentando', recogepelotas: 'recogepelotas', fotografo: 'fotógrafo', personal: 'personal', dudoso: 'sin decidir', portero: 'portero'};
const roleOn = role => { const el = document.getElementById('role_' + role); return !el || el.checked; };
for (const id of ['arbitro', 'juez_linea', 'calentando', 'recogepelotas', 'fotografo', 'personal', 'dudoso']) document.getElementById('role_' + id).addEventListener('change', () => render());
function predictedAt(pr, t) {   // the hollow ones at time t: between two data frames each one moves a little, like the solid ones
  const fs = S.data.frames; let a = Math.min(S.i, fs.length - 1); if (fs[a].t > t && a > 0) a--;
  const cur = pr.byFrame.get(a) || [], nxt = pr.byFrame.get(a + 1), f0 = fs[a], f1 = fs[a + 1];
  if (!S.playing || !nxt || !f1 || t <= f0.t || t >= f1.t) return cur;
  const u = (t - f0.t) / (f1.t - f0.t), by = new Map(nxt.map(q => [q.id, q]));
  return cur.map(q => { const r = by.get(q.id); return r ? {...q, x: q.x + (r.x - q.x) * u, y: q.y + (r.y - q.y) * u} : q; });
}
function drawPlayers(ctx, m, fr, c, net) {
  const lineIds = S.lineIds[c.line.team] || [], pr = fr.slotMode ? null : predicted();
  const playerColor=q=>q.role==='portero'||q.role==='goalkeeper'
    ?markerColor(q,S.data?.teams,{...S.match?.marker_colors,...S.continuitySession?.markerColors}):teamColor(q.team);
  if ($('othersOn').checked) for (const q of fr.o || []) {   // whoever has no team: the referee, the linesmen, the ones who warm up, the photographers, the ball boys, the staff: each in its own colour with a letter
    const role = q.role || (q.ref ? 'arbitro' : 'dudoso'), st = ROLE_STYLE[role] || ROLE_STYLE.dudoso; if (!roleOn(role)) continue;
    const p = m.pt(q.x, q.y); if (!p) continue; const r = m.affine ? 7 : Math.max(4, Math.min(11, (m.r(.9) || 8) * .8));
    ctx.save(); ctx.globalAlpha = .85 * (q.alpha ?? 1); ctx.strokeStyle = st.color; ctx.fillStyle = hexA(st.color, .16); ctx.lineWidth = 1.8; ctx.setLineDash(role === 'arbitro' ? [] : [3, 2.5]); ctx.beginPath();
    if (m.affine) ctx.arc(p.x, p.y, r, 0, Math.PI * 2); else ctx.ellipse(p.x, p.y, r * 1.1, r * .6, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke(); if (m.affine) { ctx.setLineDash([]); ctx.fillStyle = st.color; ctx.font = '700 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(st.letter, p.x, p.y + 2.8); }
    ctx.restore();
  }
  for (const q of predictionsForDisplay((pr && predictedAt(pr, fr.t)) || [], fr, S.data ? keyMap(S.data, S.rev) : new Map())) {
    const p = m.pt(q.x, q.y); if (!p) continue; const r = m.affine ? 9 : Math.max(5, Math.min(14, m.r(.9) || 8)), col = teamColor(q.team);
    ctx.save(); ctx.globalAlpha = Math.max(.55, 1 - q.h / 3); ctx.strokeStyle = col; ctx.fillStyle = hexA(col, .22); ctx.lineWidth = 2.6; ctx.setLineDash([4, 3]); ctx.beginPath();
    if (m.affine) ctx.arc(p.x, p.y, r, 0, Math.PI * 2); else ctx.ellipse(p.x, p.y, r * 1.1, r * .6, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    if (m.affine && S.look.num) { ctx.setLineDash([]); ctx.fillStyle = col; ctx.font = '700 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText(q.id.length > 3 ? q.id.slice(-3) : q.id, p.x, p.y + 3); }
    ctx.restore();
  }
  // Continuity estimates only belong on the pitch. They keep the same opaque
  // body as an observed player; the border carries the evidence state.
  if(m.affine)for(const q of fr.virtual_players||[]){
    const p=m.pt(q.x,q.y);if(!p)continue;
    const snapshot=q.state==='ultimo_estado'||q.kind==='snapshot',ref=q.role==='arbitro'||q.role==='referee';
    ctx.save();ctx.globalAlpha=1;ctx.fillStyle=ref?ROLE_STYLE.arbitro.color:playerColor(q);ctx.strokeStyle='#fff';ctx.lineWidth=2;
    ctx.setLineDash(snapshot?[1,4]:[4,3]);ctx.beginPath();ctx.arc(p.x,p.y,ref?7:9,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore();
  }
  for (const q of fr.p) {
    const p = m.pt(q.x, q.y); if (!p) continue; const r = m.affine ? 9 : Math.max(5, Math.min(14, m.r(.9) || 8)), col = playerColor(q), e = q.est || 0;   // e: 0 in view, 1 estimated (slots)
    if (!m.affine && e >= .5) continue;   // over the video nobody is estimated: a circle there would hang over the grass with no player under it (the estimates are on the 2D pitch)
    const opaqueSlot=m.affine&&q.slot!==undefined;
    if (m.affine && !opaqueSlot && e > .15 && q.r > 1.2) { const R = m.r(q.r) || 0; if (R > r) { ctx.save(); ctx.fillStyle = hexA(col, .09 * e); ctx.strokeStyle = hexA(col, .3 * e); ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore(); } }
    ctx.save(); ctx.globalAlpha = opaqueSlot?1:(q.alpha ?? 1) * (1 - .3 * e) * (m.affine ? 1 : Math.max(0, 1 - 2 * e)); ctx.fillStyle = opaqueSlot?col:e > 0 ? hexA(col, 1 - .78 * e) : col; ctx.strokeStyle = opaqueSlot?'#fff':e > .5 ? col : '#fff'; ctx.lineWidth = 2; ctx.setLineDash(e > .5 || m.affine&&q.position_source ? [4, 3] : []); ctx.beginPath();
    if (m.affine) ctx.arc(p.x, p.y, r, 0, Math.PI * 2); else ctx.ellipse(p.x, p.y, r * 1.1, r * .6, 0, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    const lab = labelOf(S.names, e > 0 ? {...q, s: e > .5 ? NaN : q.s, id: q.id} : q, S.look, S.units.some(u => u.on && u.ids.includes(q.id)));
    if (q.slot !== undefined && !S.names[q.id]) lab.inner = S.look.num === false ? '' : slotLabel(q.slot);   // until the analyst gives him a number: POR for the goalkeeper, his place in the team for the rest
    if (m.affine) {
      ctx.fillStyle = e > .5 ? col : '#fff'; ctx.font = `700 ${lab.inner.length > 2 ? 8 : 9}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(lab.inner, p.x, p.y + 3);
      lab.below.forEach((t, i) => { ctx.font = `${i ? 500 : 600} 10px system-ui`; const w = ctx.measureText(t).width + 8, y = p.y + r + 3 + i * 13; ctx.fillStyle = 'rgba(14,18,22,.78)'; ctx.fillRect(p.x - w / 2, y, w, 12); ctx.fillStyle = i ? 'rgba(255,255,255,.82)' : '#fff'; ctx.fillText(t, p.x, y + 9.5); });
    }
    for (const [k, u] of S.units.filter(u => u.on && u.ids.includes(q.id)).entries()) { ctx.strokeStyle = u.color; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.arc(p.x, p.y, r + 3 + 3 * k, 0, Math.PI * 2); ctx.stroke(); }   // the lines he is in, as rings of their colours
    if (S.tool === 'pick' ? lineIds.includes(q.id) || S.lineIds[1 - c.line.team].includes(q.id) : c.line.method === 'selected' && lineIds.includes(q.id)) { ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2); ctx.stroke(); }
    if (S.passTag && S.passTag.id === q.id) { ctx.strokeStyle = '#7CFC8E'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
  if (fr.b) { const p = m.pt(fr.b.x, fr.b.y); if (p) { ctx.save(); ctx.fillStyle = '#ffcf40'; ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, m.affine ? 5 : 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.restore(); } }
}
/** The whole scene of a frame through a mapper (the pitch seen from above, or the camera). Returns the numbers the side panel shows. */
// the net of a team: every player joined to his natural neighbours (a Delaunay triangulation), the triangles that show the passing figures, and the pass options of the player with the ball
function drawShapeLayer(ctx, m, fr, c) {
  const k = c.shape.team, col = teamColor(k), sh = teamShape(fr, k); if (!sh) return;
  ctx.save(); ctx.lineCap = ctx.lineJoin = 'round';
  const net = c.shape.net ? teamNetwork(fr, k, {maxEdge: c.shape.max}) : null;
  if (net) {
    const at = new Map(net.nodes.map(n => [n.id, m.pt(n.x, n.y)])), thin = m.affine ? 1 : .75;
    if (c.shape.fill) { ctx.fillStyle = hexA(col, .14); for (const t of net.triangles) { const a = at.get(t.a), b = at.get(t.b), d = at.get(t.c); if (!a || !b || !d) continue; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill(); } }
    const label = (a, b, len, strong) => { const t = `${fmt(len, 0)} m`; ctx.font = '600 11px -apple-system, system-ui, sans-serif'; const w = ctx.measureText(t).width + 10, x = (a.x + b.x) / 2, y = (a.y + b.y) / 2; ctx.fillStyle = strong ? 'rgba(255,255,255,.95)' : 'rgba(20,22,24,.78)'; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 9, w, 18, 9); ctx.fill(); ctx.fillStyle = strong ? '#111' : '#fff'; ctx.textAlign = 'center'; ctx.fillText(t, x, y + 4); };
    for (const e of net.links) {   // the short links are the strong ones: they are drawn thicker
      const a = at.get(e.a), b = at.get(e.b); if (!a || !b) continue;
      ctx.strokeStyle = e.carrier ? 'rgba(255,255,255,.96)' : hexA(col, .92); ctx.lineWidth = thin * (3.4 - 2.2 * Math.min(1, e.len / net.maxEdge)) + (e.carrier ? 1.2 : 0);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const e of net.links) { if (!(c.shape.len || e.carrier)) continue; const a = at.get(e.a), b = at.get(e.b); if (a && b) label(a, b, e.len, e.carrier); }
    const who = net.carrier !== null && at.get(net.carrier); if (who) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.5 * thin; ctx.beginPath(); ctx.arc(who.x, who.y, m.affine ? 14 : 12, 0, Math.PI * 2); ctx.stroke(); }
  }
  if (c.shape.hull) {
    const pts = sh.hull.map(q => m.pt(q.x, q.y));
    if (pts.every(Boolean)) {
      ctx.strokeStyle = col; ctx.fillStyle = hexA(col, net && c.shape.fill ? 0 : .12); ctx.lineWidth = 2.5; ctx.setLineDash([10, 6]); ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath(); ctx.fill(); ctx.stroke();
      const cc = m.pt(sh.cx, sh.cy); ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(cc.x - 7, cc.y); ctx.lineTo(cc.x + 7, cc.y); ctx.moveTo(cc.x, cc.y - 7); ctx.lineTo(cc.x, cc.y + 7); ctx.stroke();
    }
  }
  ctx.restore();
}
const SEEN_MIN = 8;   // of the 22: with fewer in view the analysis layers are not drawn (slots)
function scene(ctx, m, fr, c, afterSpace) {
  const out = {};
  if (!fr) { if (afterSpace) afterSpace(); return out; }
  const blind = !!fr.slotMode && fr.p.filter(q => q.est < .5).length < SEEN_MIN;   // a close-up or a shot without the pitch: everybody is a guess, and the space, the lines and the net drawn from guesses would look like an analysis
  out.blind = blind;
  const freshVirtual=m.affine?(fr.virtual_players||[]).filter(p=>p.state!=='ultimo_estado'&&p.kind!=='snapshot'&&[0,1].includes(p.team)):[],
    spaceFrame=freshVirtual.length?{...fr,p:[...fr.p,...freshVirtual]}:fr;
  const estimatedSpace=m.affine&&fr.slotMode&&S.slots?.policy?.identity_status==='anonymous_slot_hypothesis';
  if (c.vor.on && spaceFrame.p.length && (!blind||estimatedSpace)) { const dom = domAt(spaceFrame, c, m.affine ? .5 : .75); out.dom = dom; drawDominance(ctx, m, dom, c); }
  if (m.affine && $('cameraFootprintOn').checked && fr.camera_footprint_m) {
    const points = fr.camera_footprint_m.map(([x, y]) => m.pt(x, y));
    if (points.every(Boolean)) {
      ctx.save(); ctx.beginPath(); points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
      ctx.fillStyle = 'rgba(190,198,205,.22)'; ctx.fill(); ctx.strokeStyle = 'rgba(230,236,240,.7)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
    }
  }
  if (afterSpace) afterSpace();   // the markings of the pitch go over the coloured regions
  if (c.shape.on && !blind) drawShapeLayer(ctx, m, fr, c);
  for (const s of S.shapes) if (visible(s) && ['zone', 'rect', 'circle'].includes(s.type)) drawShape(ctx, m, s, fr, s === S.sel);
  if (c.line.on && !blind) out.line = drawLineLayer(ctx, m, fr, c);
  if (c.net.on && !blind) out.net = drawNetwork(ctx, m, c);
  if (S.focus) drawFocus(ctx, m, fr);
  drawUnits(ctx, m, fr, c);
  if (m.affine) tacticalAnnotations.draw(ctx, (x, y) => m.pt(x, y), {phase: 'under'});
  drawPlayers(ctx, m, fr, c, out.net);
  drawUnitLabels(ctx, m, fr, c);
  if (m.affine) tacticalAnnotations.draw(ctx, (x, y) => m.pt(x, y), {phase: 'over'});
  if(estimatedSpace&&c.vor.on){ctx.save();ctx.fillStyle='rgba(14,18,22,.84)';ctx.fillRect(10,map.h-30,215,22);ctx.fillStyle='#fff';ctx.font='600 12px system-ui';ctx.textAlign='left';ctx.fillText('Voronoi ESTIMADO · modelo de posiciones',18,map.h-15);ctx.restore();}
  if (blind && m.affine) { ctx.save(); ctx.font = '600 12px system-ui'; const t = 'Plano cercano o sin cancha a la vista: todas las posiciones son estimadas', w = ctx.measureText(t).width + 16; ctx.fillStyle = 'rgba(14,18,22,.82)'; ctx.fillRect(10, 10, w, 24); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(t, 18, 26); ctx.restore(); }
  for (const s of S.shapes) if (visible(s) && !['zone', 'rect', 'circle'].includes(s.type)) drawShape(ctx, m, s, fr, s === S.sel);
  if (S.draft) drawShape(ctx, m, S.draft, fr, false);
  return out;
}

// ---------- rendering ----------
let panelsAt = -1, markedAt = -1, drawnAt = null, vclock = null;
/** The time of the picture the video is really showing: the frame its last frame callback reported while it plays (its clock runs ahead of the frame on screen), its own time otherwise. */
const vnow = () => !video.paused && !video.seeking && vclock !== null && Math.abs(vclock - video.currentTime) < .25 ? vclock : video.currentTime;   // a callback that stopped coming (a hidden page) does not freeze the clock
function render() {
  if (!map) sizePitch();
  const c = C(), real = S.data && !S.stale && S.data.frames[Math.min(S.i, S.data.frames.length - 1)];
  const drawTime=Number.isFinite(S.t)?S.t:real?.t;
  let fr = real ? displayAt(S.data, S.i, drawTime, S.rev, {fade: 0}) : real;
  const slotMode = !!(S.slots && real && $('slotsOn').checked);
  if (slotMode) {   // eleven against eleven, always: the slots (slots.js) in place of the tracker's players; the rest (referees, the ball...) as they are
    const tt = S.playing ? S.t : S.match ? Math.max(0, video.currentTime - vOffset()) : real.t, base = displayAt(S.data, S.i, tt, S.rev, {fade: 0});
    fr = {...base, t: tt, slotMode: true, o:(base.o||[]).filter(q=>q.ref||q.role==='arbitro'),
      p: slotsAt(S.slots, tt).map(q => ({...q, rid: q.id,role:q.slot%11===0?'portero':'jugador',role_source:'anonymous_slot_prior'}))};
  }
  const observedFrame=slotMode&&real?displayAt(S.data,S.i,drawTime,S.rev,{fade:0}):fr;
  if(fr&&!slotMode&&S.continuitySession&&$('predOn').checked){
    const segment=(S.data.cuts||[]).filter(f=>f<=fr.f).length;
    fr=analystContinuityFrame(S.continuitySession.report,fr,{segment,t:drawTime,settings:S.continuitySession.settings});
  }
  S.shown = fr;   // virtual markers remain separate and cannot create measured labels
  renderSlotsLayer();
  pctx.setTransform(DPR, 0, 0, DPR, 0, 0); pctx.clearRect(0, 0, map.w, map.h); drawPitch(pctx, map, false);
  const out = scene(pctx, map, fr, c, () => drawPitchLines());
  const continuityNote=$('continuityNote');
  if(continuityNote){continuityNote.hidden=!fr?.virtual_players;
    const label=fr?.virtual_players?analystContinuityStatus(fr).label:'';
    if(continuityNote.textContent!==label)continuityNote.textContent=label;}
  if (stateNow() !== shownState) { applyView(); return; }
  renderVideoOverlay(observedFrame, c);
  if (!S.playing || S.i !== panelsAt) {
    const measuredOut=slotMode||fr?.virtual_players?{...out,dom:c.vor.on&&real?.p.length?domAt(real,c,.5):null}:out;
    renderMetrics(real, c, measuredOut); renderStats(); renderShapeList(); panelsAt = S.i;
  }   // numerical panels use observations, never roster snapshots or estimates
  $('clock').textContent = S.match ? clock(vnow()) : fr ? clock(fr.t) : '0:00.0'; $('timeline').value = S.i;
  { const note = $('lineDirNote'); if (note) note.textContent = !S.data || C().line.dir !== 'auto' ? '' : (() => { const d = autoDir(), side = k => (k === 0 ? d.dir0 : -d.dir0) > 0 ? 'derecha →' : '← izquierda'; return d.n ? `${teamName(0)} ataca hacia la ${side(0)}, ${teamName(1)} hacia la ${side(1)}${d.sure ? '' : ' (poca diferencia entre los equipos: elígelo a mano si no es así)'}.` : 'Sin los dos equipos a la vez no se puede saber hacia dónde atacan: elígelo a mano.'; })(); }
  $('staleNote').hidden = !S.stale; if (S.match) matchHead();
}
function currentH() {
  if (S.Hmap) {   // a camera that moves: one matrix per video frame; with no data loaded the frame is the one the video is showing
    const f = video.readyState > 0 && S.Hmap.fps ? (S.Hmap.exact?Math.floor(vnow()*S.Hmap.fps+1e-7):Math.round(vnow() * S.Hmap.fps)) : S.data ? S.data.frames[Math.min(S.i, S.data.frames.length - 1)].f : S.Hmap.keys[0], keys = S.Hmap.keys;   // the frame the video is showing: the lines move with the camera whoever plays it
    if(S.Hmap.exact)return S.Hmap.byFrame[f]||null; // no old homography across an uncalibrated TV cut
    if (f < keys[0] || f > keys[keys.length - 1] + 2) return null;   // outside the stretch that was followed: no calibration there
    let lo = 0, hi = keys.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (keys[m] <= f) lo = m; else hi = m - 1; }
    return S.Hmap.byFrame[keys[lo]];
  }
  return S.H;
}
function renderVideoOverlay(fr, c) {
  const vb = video.parentElement; if ($('videoPane').hidden || !video.videoWidth) return;
  const w = vb.clientWidth, h = Math.round(w * video.videoHeight / video.videoWidth); if (vover.width !== w * DPR || vover.height !== h * DPR) { vover.width = w * DPR; vover.height = h * DPR; }
  vctx.setTransform(1, 0, 0, 1, 0, 0); vctx.clearRect(0, 0, vover.width, vover.height); vctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const H = currentH(), inv = H && invert3(H); if (S.calibOn) drawCalibration(); if (!inv) return;
  const sx = w / video.videoWidth, sy = h / video.videoHeight, ref = project(H, video.videoWidth / 2, video.videoHeight * .75);   // a point of the ground the camera is looking at: which side of the horizon is "in front"
  const side = ref && Math.sign(inv[2][0] * ref.x + inv[2][1] * ref.y + inv[2][2]) || 1;
  const front = (x, y) => hom(inv, x, y, side), eps = ref ? .01 * Math.abs(front(ref.x, ref.y).w) : 1e-6;
  // a pitch point behind the camera has no place in the picture: drawn anyway it would land mirrored, and a line joining it to a point in front crossed the whole frame
  const m = {affine: false, w, h, sx, sy, r: q => q * 8, front, eps, pt: (x, y) => { const q = front(x, y); return q.w > eps ? {x: q.x / q.w * sx, y: q.y / q.w * sy} : null; }};
  if ($('trkLines').checked) drawProjectedPitch(vctx, m);   // the lines of the pitch through the camera: the way to check a calibration by eye
  if (fr) scene(vctx, m, fr, c);
}
function drawProjectedPitch(ctx, m) {
  const L = PITCH.L, W = PITCH.W, lines = [], arc = (cx, cy, r, a0, a1) => Array.from({length: 49}, (_, i) => [cx + r * Math.cos(a0 + (a1 - a0) * i / 48), cy + r * Math.sin(a0 + (a1 - a0) * i / 48)]), rect = (x0, y0, x1, y1) => lines.push([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]), half = Math.acos(5.5 / 9.15);
  rect(0, 0, L, W); lines.push([[52.5, 0], [52.5, W]]); rect(0, 13.84, 16.5, 54.16); rect(0, 24.84, 5.5, 43.16); rect(L - 16.5, 13.84, L, 54.16); rect(L - 5.5, 24.84, L, 43.16);
  lines.push(arc(52.5, 34, 9.15, 0, Math.PI * 2), arc(11, 34, 9.15, -half, half), arc(L - 11, 34, 9.15, Math.PI - half, Math.PI + half));
  ctx.save(); ctx.strokeStyle = 'rgba(124,252,142,.95)'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const line of lines) { ctx.beginPath(); for (let i = 1; i < line.length; i++) { const s = clipToFront(m.front(...line[i - 1]), m.front(...line[i]), m.eps); if (!s) continue; ctx.moveTo(s[0] * m.sx, s[1] * m.sy); ctx.lineTo(s[2] * m.sx, s[3] * m.sy); } ctx.stroke(); }
  ctx.restore();
}
function drawCalibration() {
  const vb = video.parentElement, w = vb.clientWidth, sx = w / (video.videoWidth || w);
  vctx.setTransform(DPR, 0, 0, DPR, 0, 0); vctx.fillStyle = '#ffd23f'; vctx.strokeStyle = '#000'; vctx.font = '600 12px system-ui';
  S.calibPts.forEach((p, i) => { vctx.beginPath(); vctx.arc(p.px * sx, p.py * sx, 6, 0, Math.PI * 2); vctx.fill(); vctx.stroke(); vctx.fillStyle = '#fff'; vctx.fillText(`${i + 1}`, p.px * sx + 9, p.py * sx - 7); vctx.fillStyle = '#ffd23f'; });
}
const rec = k => { const w = S.auto.turnovers.filter(t => t.won_by === k), d = w.filter(t => t.kind === 'duelo').length; return `<div class="kv"><span>Balones recuperados</span><span>${w.length}</span></div><div class="kv"><span>· en duelo / por intercepción</span><span>${d} / ${w.length - d}</span></div>`; };
// how many of the team are in view now, the last man, and how compact/long/wide the team is over the frames where all of it is seen
const expectedNow = k => expectedAt(k, S.data.frames[Math.min(S.i, S.data.frames.length - 1)].t);
const seenRow = (k, sh) => { if (S.shown && S.shown.slotMode) { const mine = S.shown.p.filter(q => q.team === k), modern = S.slots?.policy?.identity_status === 'anonymous_slot_hypothesis', seen = mine.filter(q => modern ? q.evidence_state === 'detectado' : q.est < .5).length; return `<div class="kv"><span>${modern ? 'Con detección actual' : 'A la vista'}</span><span>${seen} de ${mine.length}</span></div><div class="kv"><span>${modern ? 'Sin detección actual' : 'Estimados (borde discontinuo)'}</span><span>${mine.length - seen}</span></div>`; }
  const e = expectedNow(k), pr = predicted(), est = pr ? (pr.byFrame.get(Math.min(S.i, S.data.frames.length - 1)) || []).filter(q => q.team === k).length : 0; return `<div class="kv"><span>A la vista</span><span>${sh.n} de ${e}</span></div>${est ? `<div class="kv"><span>Estimados (círculos huecos)</span><span>${est}</span></div>` : ''}${sh.n !== e ? '<p class="muted small">La forma de abajo es la de los que se ven, no la del equipo completo.</p>' : ''}`; };
const lastRow = (fr, k, c) => { if (!c.line.last) return ''; const lm = defensiveLine(fr, k, {dir: attackDir(k, c), method: 'last', includeGK: c.line.gk}); return `<div class="kv"><span>Último hombre</span><span>${lm ? fmt(lm.d) + ' m' : '–'}</span></div>`; };
const profCache = {key: '', rows: {}};
const profile = k => { const key = `${S.data.frames.length}:${S.rev}`; if (profCache.key !== key) { profCache.key = key; profCache.rows = {}; } return profCache.rows[k] || (profCache.rows[k] = teamProfile(S.data, k, t => expectedAt(k, t))); };
const profileRows = k => {
  const p = profile(k); if (!p) return '';
  if (!p.complete) return `<p class="muted small">En este tramo nunca se vieron los ${expectedNow(k)} a la vez: no hay medida de la forma del equipo completo.</p>`;
  const m = (s, d = 0) => `${fmt(s.mean, d)} <span class="muted">(${fmt(s.min, d)}–${fmt(s.max, d)})</span>`;
  return `<div class="kv"><span>Con todos a la vista</span><span>${fmt(p.share * 100, 0)} % de los cuadros</span></div><div class="kv"><span>· ancho medio</span><span>${m(p.width)} m</span></div><div class="kv"><span>· largo medio</span><span>${m(p.depth)} m</span></div><div class="kv"><span>· distancia media al centro</span><span>${m(p.spread)} m</span></div><div class="kv"><span>· área media</span><span>${m(p.area)} m²</span></div>`;
};
function renderMetrics(fr, c, out) {
  const el = $('metrics'); if (!fr) { el.innerHTML = '<p class="muted small">Sin datos todavía.</p>'; return; }
  const ctl = out.dom ? control(out.dom) : null, rows = [];
  if (c.vor.on && ctl) rows.push(`<div class="metric"><h3>${c.vor.mode === 'voronoi' ? 'ESPACIO · VORONOI' : 'ESPACIO · APOLONIO'}</h3><div class="bar"><i style="width:${((ctl[0] || 0) * 100).toFixed(1)}%;background:${teamColor(0)}"></i><i style="width:${((ctl[1] || 0) * 100).toFixed(1)}%;background:${teamColor(1)}"></i></div><div class="bar-l"><span>${teamName(0)} ${fmt((ctl[0] || 0) * 100)}%</span><span>${fmt((ctl[1] || 0) * 100)}% ${teamName(1)}</span></div></div>`);
  for (const k of [0, 1]) {
    const sh = teamShape(fr, k), nw = c.shape.on && c.shape.net && k === c.shape.team ? teamNetwork(fr, k, {maxEdge: c.shape.max}) : null, ln = defensiveLine(fr, k, {dir: attackDir(k, c), method: c.line.method === 'selected' && !S.lineIds[k].length ? 'back4' : c.line.method, ids: S.lineIds[k], includeGK: c.line.gk});
    if (sh) rows.push(`<div class="metric"><h3><span class="dot" style="background:${teamColor(k)}"></span>${teamName(k).toUpperCase()}</h3>${seenRow(k, sh)}<div class="kv"><span>Línea defensiva</span><span>${ln ? fmt(ln.d) + ' m' : '–'}</span></div><div class="kv"><span>Ancho de la línea</span><span>${ln ? fmt(ln.width) + ' m' : '–'}</span></div>${lastRow(fr, k, c)}<div class="kv"><span>Ancho del equipo</span><span>${fmt(sh.width)} m</span></div><div class="kv"><span>Largo del equipo</span><span>${fmt(sh.depth)} m</span></div><div class="kv"><span>Área de la envolvente</span><span>${fmt(sh.area, 0)} m²</span></div>${profileRows(k)}${S.auto.hasBall ? rec(k) : ''}${nw ? `<div class="kv"><span>Triángulos de la red</span><span>${nw.triangles.length}</span></div><div class="kv"><span>Distancia media entre vecinos</span><span>${fmt(nw.meanLen)} m</span></div><div class="kv"><span>Área media por triángulo</span><span>${fmt(nw.meanArea, 0)} m²</span></div>${nw.carrier !== null ? `<div class="kv"><span>Opciones de pase del que tiene el balón</span><span>${nw.links.filter(l => l.carrier).length}</span></div>` : ''}` : ''}</div>`);
  }
  const net = out.net; if (c.net.on && net) rows.push(`<div class="metric"><h3>RED DE PASES · ${teamName(c.net.team).toUpperCase()}</h3><div class="kv"><span>Pases en la ventana</span><span>${net.total}</span></div><div class="kv"><span>Jugadores en la red</span><span>${net.nodes.length}</span></div><div class="kv"><span>Densidad</span><span>${fmt(net.density * 100, 0)}%</span></div><div class="kv"><span>Conexión más fuerte</span><span>${net.strongest ? `${net.strongest.a} ↔ ${net.strongest.b} (${net.strongest.n})` : '–'}</span></div></div>`);
  if (S.data.hasBall && fr.b) { let before = null; for (let j = S.i - 1; j >= Math.max(0, S.i - 8) && !before; j--) if (S.data.frames[j].b) before = S.data.frames[j];   // the ball is often not seen in the frame before: the last one where it was, within half a second or so
    const sp = before ? Math.hypot(fr.b.x - before.b.x, fr.b.y - before.b.y) / Math.max(1e-3, fr.t - before.t) : null; rows.push(`<div class="metric"><h3>BALÓN</h3><div class="kv"><span>Posición</span><span>${fmt(fr.b.x)} · ${fmt(fr.b.y)} m</span></div><div class="kv"><span>Velocidad</span><span>${sp === null ? '–' : `${fmt(sp * 3.6, 0)} km/h`}</span></div></div>`); }
  el.innerHTML = rows.join('');
}
// the table of what every player ran
const statsCache = {key: '', rows: []};
const stats = () => { const key = `${S.data.frames.length}:${S.rev}`; if (statsCache.key !== key) { statsCache.key = key; statsCache.rows = playerStats(S.data); } return statsCache.rows; };
function renderStats() {
  const el = $('stats'); if (!S.data) { el.innerHTML = '<p class="muted small">Sin datos todavía.</p>'; return; }
  const by = $('statsSort').value, team = $('statsTeam').value, rows = stats().filter(r => team === 'all' || r.team === +team).sort((a, b) => ({distance: b.distance - a.distance, top: b.top - a.top, sprints: b.sprints - a.sprints || b.hi - a.hi, hi: b.hi - a.hi})[by]).slice(0, 14);
  const span = S.data.frames[S.data.frames.length - 1].t - S.data.frames[0].t, keys = keyMap(S.data, S.rev), who = id => { const w = S.names[slotOfTrack(S.slots, id) ?? keys.get(id) ?? id]; return w ? [w.num && `#${w.num}`, w.name].filter(Boolean).join(' ').replace(/</g, '&lt;') : id; };   // the name the analyst gave, or the tracker's number
  el.innerHTML = `<div class="stat-row head"><span>Jugador</span><span>Dist.</span><span>Vel. máx.</span><span>Sprints</span></div>` + rows.map(r => `<button class="stat-row${S.focus === r.id ? ' sel' : ''}" data-id="${r.id}" title="Alta intensidad (más de 20 km/h): ${fmt(r.hi, 0)} m · velocidad media ${fmt(r.avg * 3.6, 1)} km/h · visto ${fmt(r.seconds, 0)} s"><span><i class="dot" style="background:${teamColor(r.team)}"></i>${who(r.id)}</span><span>${fmt(r.distance, 0)} m</span><span>${fmt(r.top, 1)} km/h</span><span>${r.sprints}</span></button>`).join('') + `<p class="muted small">En los ${fmt(span, 0)} s analizados. Elige un jugador para ver su recorrido y dónde estuvo.</p>`;
}
$('stats').addEventListener('click', e => { const b = e.target.closest('.stat-row[data-id]'); if (!b) return; S.focus = S.focus === b.dataset.id ? null : b.dataset.id; render(); });
$('statsSort').onchange = $('statsTeam').onchange = () => renderStats();
function renderShapeList() {
  const el = $('shapeList'), names = {zone: 'Zona', rect: 'Rectángulo', circle: 'Círculo', arrow: 'Flecha', line: 'Línea', pen: 'Trazo', text: 'Texto'};
  el.innerHTML = S.shapes.length ? S.shapes.map(s => `<button data-id="${s.id}" class="${s === S.sel ? 'sel' : ''}"><span class="dot" style="background:${s.color}"></span>${names[s.type]}${s.text ? ': ' + s.text : ''}${s.t0 !== null && s.t0 !== undefined || s.t1 !== null && s.t1 !== undefined ? ` · ${fmt(s.t0 ?? 0)}–${s.t1 === null || s.t1 === undefined ? '∞' : fmt(s.t1)} s` : ''}</button>`).join('') : '<p class="muted small">Todavía no dibujas nada.</p>';
  $('shapeProps').hidden = !S.sel; if (S.sel) { $('shT0').value = S.sel.t0 ?? ''; $('shT1').value = S.sel.t1 ?? ''; }
}
function drawMarkers() {
  const cv = $('markers'), w = cv.clientWidth || 600; cv.width = w * DPR; cv.height = 26 * DPR; const g = cv.getContext('2d'); g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, w, 26);
  if (!S.data) return; const t0 = S.data.frames[0].t, t1 = S.data.frames[S.data.frames.length - 1].t, X = t => (t - t0) / Math.max(1e-6, t1 - t0) * w;
  for (const p of effPasses()) { g.fillStyle = teamColor(p.team); g.fillRect(X(p.t1) - 1, 4, 2, 9); }
  for (const p of S.auto.turnovers) { g.fillStyle = '#e8646f'; g.fillRect(X(p.t) - 1, 15, 2, 8); }
  for (const r of S.reds) { g.fillStyle = '#ff3b30'; g.fillRect(X(r.t) - 2, 0, 4, 7); g.fillRect(X(r.t) - .75, 0, 1.5, 26); }   // red cards
  g.fillStyle = '#fff'; g.fillRect(X(S.data.frames[Math.min(S.i, S.data.frames.length - 1)].t) - 1, 0, 2, 26);
}

// ---------- time ----------
function seek(i) {
  if (!S.data) return; S.i = Math.max(0, Math.min(S.data.frames.length - 1, Math.round(i))); S.t = S.data.frames[S.i].t;
  if (video.src && video.readyState > 0 && Math.abs(video.currentTime - (S.t + vOffset())) > .08) video.currentTime = Math.max(0, S.t + vOffset());
  render(); drawMarkers();
}
const vOffset = () => +$('vOffset').value || 0;
function step(t) {   // the picture of the moment t: the data at that time on the pitch and over the video
  const end = S.data.frames[S.data.frames.length - 1].t;
  if (S.match) followMatch(t);   // the next stretch is loaded as the video reaches it
  else if (t >= end && !S.live) { S.playing = false; setPlayUI(false); video.pause(); t = end; }
  S.t = t; S.i = frameAtOrBefore(S.data, t);
  try { render(); if (S.i !== markedAt) { drawMarkers(); markedAt = S.i; } } catch (e) { console.error(e); status(`No pude dibujar este cuadro: ${e.message}`); }   // a layer that fails must not stop everything else from playing
}
function tick(ts) {
  raf = 0; if (!S.playing || !S.data) return;
  const dt = (ts - lastTs) / 1000, speed = S.live ? 1 : +$('speed').value; lastTs = ts;
  const driven = video.src && (S.match || (!video.paused && video.readyState > 1));   // the video is the clock: a whole match has none of its own, and a picture only changes when the video shows another frame
  const t = driven ? vnow() - vOffset() : S.t + dt * speed;
  if (!driven || t !== drawnAt) { drawnAt = t; step(t); }
  if (S.playing) raf = requestAnimationFrame(tick);
}
function play() {
  if (!S.data) return; if (S.i >= S.data.frames.length - 1 && !S.live && !S.match) seek(0);
  S.playing = !S.playing; setPlayUI(S.playing);
  if (video.src) { if (S.playing) { if (!S.match) video.currentTime = Math.max(0, S.t + vOffset()); video.playbackRate = +$('speed').value; video.play().catch(() => {}); } else video.pause(); }
  lastTs = performance.now(); if (S.playing && !raf) raf = requestAnimationFrame(tick);
}

// ---------- drawing tools ----------
const snap = () => JSON.stringify(S.shapes.map(({...s}) => s));
function pushUndo() { S.undo.push(snap()); if (S.undo.length > 80) S.undo.shift(); S.redo = []; }
function restore(json) { S.shapes = JSON.parse(json); S.sel = null; render(); }
function undo() { if (!S.undo.length) return; S.redo.push(snap()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length) return; S.undo.push(snap()); restore(S.redo.pop()); }
function addShape(s) { pushUndo(); s.id = S.nextId++; S.shapes.push(s); S.sel = s; render(); }
const pos = e => { const r = pitchCv.getBoundingClientRect(); return map.inv(e.clientX - r.left, e.clientY - r.top); };
const nearestAny = (p, maxD = 3) => {   // a player of a team or somebody without one (grey): what the "team" tool can be pointed at
  const fr = S.shown || (S.data && S.data.frames[S.i]); if (!fr) return null; let best = null, bd = maxD;
  for (const q of fr.p) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = {...q}; } }
  if ($('othersOn').checked) for (const q of fr.o || []) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = {...q, team: -1}; } }
  return best;
};
const nearestPlayer = (p, maxD = 3) => { const fr = S.shown || (S.data && S.data.frames[S.i]); if (!fr) return null; let best = null, bd = maxD; for (const q of fr.p) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < bd) { bd = d; best = q; } } return best; };
function distSeg(p, a, b) { const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)); return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy); }
function inPoly(p, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c; } return c; }
function hit(s, p) {
  const pts = s.pts, tol = 1.6;
  if (s.type === 'zone') return inPoly(p, pts) || pts.some((q, i) => distSeg(p, q, pts[(i + 1) % pts.length]) < tol);
  if (s.type === 'rect') return inPoly(p, [pts[0], {x: pts[1].x, y: pts[0].y}, pts[1], {x: pts[0].x, y: pts[1].y}]);
  if (s.type === 'circle') return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) + tol;
  if (s.type === 'text') return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < 4;
  return pts.some((q, i) => i && distSeg(p, pts[i - 1], q) < tol);
}
const newShape = (type, pts) => ({type, pts, color: $('color').value, alpha: +$('alpha').value, t0: null, t1: null, text: '', follow: null, anchor: null});
let drag = null;
pitchCv.addEventListener('pointerdown', e => {
  if (!S.data) return; const p = pos(e), tool = S.tool;
  if (tacticalAnnotations.pickAt(p)) { e.preventDefault(); return; }
  pitchCv.setPointerCapture(e.pointerId);
  if (tool === 'select') {
    S.sel = [...S.shapes].reverse().find(s => visible(s) && hit(s, p)) || null; if (S.sel) { pushUndo(); drag = {last: p, moved: false}; } render(); return;
  }
  if (tool === 'pick' && S.armed !== null) { const q = nearestPlayer(p, 2.5), u = S.units.find(x => x.id === S.armed); if (q && u) { const r = toggleMember(S.units, u, q.id, q.team); status(r ? `${u.name} de ${teamName(u.team)}: ${r === 'added' ? 'se sumó' : 'se quitó'} el jugador ${labelOf(S.names, q, {}).inner}` : `${u.name} es de ${teamName(u.team)}: ese jugador es del otro equipo`); renderUnits(); render(); } return; }
  if (tool === 'pick') { const q = nearestPlayer(p, 2.5); if (q) { const ids = S.lineIds[q.team], at = ids.indexOf(q.id); if (at >= 0) ids.splice(at, 1); else ids.push(q.id); $('lineTeam').value = q.team; $('lineMethod').value = 'selected'; $('lineOn').checked = true; render(); status(`Línea de ${teamName(q.team)}: ${ids.length} jugadores elegidos`); } return; }
  if (tool === 'team') { const q = nearestAny(p, 2.5); if (q) openTeamMenu(e, q); else closeTeamMenu(); return; }
  if (tool === 'pass') {
    const q0 = nearestPlayer(p, 2.5); if (!q0) return; const q = {...q0, id: q0.rid ?? q0.id};   // the passes are written with the tracker's number of the moment, as the detected ones are
    if (!S.passTag) { S.passTag = q; status(`Pasa ${q.id}… elige a quién se la da`); } else if (S.passTag.id !== q.id && S.passTag.team === q.team) { S.manual.push(tagToPass(S.t, S.passTag.id, q.id, q.team, S.data.fps)); status(`Pase ${S.passTag.id} → ${q.id} marcado en ${clock(S.t)}`); S.passTag = null; updateNetInfo(); drawMarkers(); } else { S.passTag = null; status('El receptor debe ser del mismo equipo'); }
    render(); return;
  }
  if (tool === 'text') { const t = prompt('Texto'); if (t) addShape({...newShape('text', [p]), text: t}); return; }
  if (tool === 'zone') {
    if (!S.draft) S.draft = newShape('zone', [p, p]); else S.draft.pts[S.draft.pts.length - 1] = p, S.draft.pts.push(p);
    render(); return;
  }
  S.draft = newShape(tool, tool === 'pen' ? [p] : [p, p]); drag = {start: p}; render();
});
pitchCv.addEventListener('pointermove', e => {
  if (!map) return; const p = pos(e), q = S.data && nearestPlayer(p, 2.5);
  $('hover').textContent = `${fmt(p.x)} · ${fmt(p.y)} m${q ? ` · ${q.id} (${teamName(q.team)}) ${fmt(q.s || 0)} m/s` : ''}`;
  if (!S.data) return;
  if (S.tool === 'select' && drag && drag.last && S.sel) { const dx = p.x - drag.last.x, dy = p.y - drag.last.y; for (const q2 of S.sel.pts) { q2.x += dx; q2.y += dy; } if (S.sel.anchor) { S.sel.anchor.x += dx; S.sel.anchor.y += dy; } drag.last = p; drag.moved = true; render(); return; }
  if (S.draft) { if (S.draft.type === 'zone') S.draft.pts[S.draft.pts.length - 1] = p; else if (S.draft.type === 'pen') S.draft.pts.push(p); else S.draft.pts[1] = p; render(); }
});
pitchCv.addEventListener('pointerup', () => {
  if (S.tool === 'select' && drag) { if (!drag.moved) S.undo.pop(); drag = null; return; }
  if (S.draft && S.draft.type !== 'zone') {
    const d = S.draft; S.draft = null; drag = null;
    if (d.type === 'pen' ? d.pts.length > 2 : Math.hypot(d.pts[1].x - d.pts[0].x, d.pts[1].y - d.pts[0].y) > .6) {
      if (d.type === 'circle' && $('follow').checked) { const q = nearestPlayer(d.pts[0], 4); if (q) { d.follow = q.id; d.anchor = {x: q.x, y: q.y}; } }
      addShape(d);
    } else render();
  }
});
pitchCv.addEventListener('dblclick', e => { if (tacticalAnnotations.armed) return; if (!S.draft && S.data && ['select', 'pick', 'team'].includes(S.tool)) { const q = nearestPlayer(pos(e), 2.5); if (q) { openPlayerEditor(e, q); return; } } if (S.draft && S.draft.type === 'zone') { S.draft.pts.pop(); S.draft.pts.pop(); const d = S.draft; S.draft = null; if (d.pts.length >= 3) addShape(d); else render(); } });
const refresh = () => { S.cache = {}; S.rev++; S.auto = detectPasses(S.data); S.manual = []; withSpeeds(S.data); rebuildEditedContinuity();updateNetInfo(); drawMarkers(); renderPredNote(); render(); };
const piecesOf = key => { const raw = [...keyMap(S.data, S.rev)].filter(([, k]) => k === key).map(([id]) => id); return raw.length ? raw : [key]; };   // the player the page draws may be several tracks of the tracker: a correction is for all of them
function fixTrack(id, team) {   // one track, whole: to a team, or out of both
  const n = assignTrack(S.data, id, team); if (!n) return; S.fixes[id] = team; refresh();
  const said = team < 0 ? `${id} ya no cuenta como jugador (${n} cuadros)` : `${id} ahora es de ${teamName(team)} (${n} cuadros)`;
  saveLabels([labelRecord(id, team, 'corregido')]).then(ok => status(ok === null ? `${said}. Este análisis no trae los rasgos de cada track: no se guardó como etiqueta` : ok ? `${said}. Guardado como etiqueta para entrenar` : `${said}. No pude guardar la etiqueta`));
}
// what the analyst corrects is saved, with the features of the track, as a label to train on (tools/tracking/identity_labels.py): nothing leaves this computer
const trackerIdx = k => k < 0 ? k : S.swapped ? 1 - k : k;   // the labels use the numbering of the tracker, not the one the analyst may have swapped
function labelRecord(id, team, source) {
  const f = S.data.tracks && S.data.tracks[id]; if (!f) return null;
  const {tracker_team: tt, ...features} = f, colours = S.swapped ? [teamColor(1), teamColor(0)] : [teamColor(0), teamColor(1)];
  return {video: S.data.video || S.label || 'video', run: `${S.data.start_s || 0}:${S.data.frames[0].f}:${S.data.frames.length}`, track_id: +id, label: trackerIdx(team), tracker_team: tt, source, features, teams: {0: colours[0], 1: colours[1]}};
}
async function saveLabels() { return false; }
function refreshLabelInfo() { $('labelInfo').textContent = 'Las correcciones se conservan al guardar el proyecto; no entrenan modelos.'; }
$('labelConfirm').onclick = async () => {   // the teams as they are now, corrected or not, given as right: one label per track
  if (!S.data || !S.data.tracks) return;
  const cur = new Map(); for (const fr of S.data.frames) { for (const q of fr.p) if (!cur.has(q.id)) cur.set(q.id, q.team); for (const q of fr.o || []) if (!q.ref && !cur.has(q.id)) cur.set(q.id, -1); }
  const recs = [...cur].filter(([id]) => S.data.tracks[id]).map(([id, team]) => labelRecord(id, team, id in S.fixes ? 'corregido' : 'confirmado'));
  const ok = await saveLabels(recs); status(ok ? `${recs.length} tracks guardados como etiquetas (${recs.filter(r => r.source === 'corregido').length} corregidos, el resto confirmados)` : ok === null ? 'Este análisis no trae los rasgos de cada track' : 'No pude guardar las etiquetas');
};
let teamMenu = null;
function closeTeamMenu() { if (teamMenu) { teamMenu.remove(); teamMenu = null; } }
function openTeamMenu(e, q) {   // a small menu where the analyst clicked: to which team does this player belong
  closeTeamMenu();
  if (q.ref) { status('Es el árbitro: no es un jugador de ningún equipo'); return; }
  const m = document.createElement('div'); m.className = 'pop-menu'; m.setAttribute('role', 'menu');
  const item = (label, team, color) => `<button role="menuitem" data-team="${team}"${q.team === team ? ' aria-current="true"' : ''}>${color ? `<span class="dot" style="background:${color}"></span>` : '<span class="dot none"></span>'}${label}</button>`;
  m.innerHTML = `<div class="pop-head">Jugador ${q.id}</div>${item(teamName(0), 0, teamColor(0))}${item(teamName(1), 1, teamColor(1))}${item('Sin equipo (no es un jugador)', -1, null)}`;
  m.style.left = `${Math.min(e.clientX, innerWidth - 240)}px`; m.style.top = `${Math.min(e.clientY, innerHeight - 170)}px`;
  m.addEventListener('click', ev => { const b = ev.target.closest('button[data-team]'); if (b) { for (const id of piecesOf(q.id)) fixTrack(id, +b.dataset.team); closeTeamMenu(); } });
  document.body.appendChild(m); teamMenu = m; m.querySelector('button').focus();
}
addEventListener('pointerdown', e => { if (teamMenu && !teamMenu.contains(e.target) && e.target !== pitchCv) closeTeamMenu(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closeTeamMenu(); });
$('othersOn').onchange = render;
$('cameraFootprintOn').onchange = render;
function setTool(t) { tacticalAnnotations.cancelSelection(); S.tool = t; S.draft = null; S.passTag = null; if (t !== 'pick' && S.armed !== null) { S.armed = null; renderUnits(); } document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('active', b.dataset.tool === t)); pitchCv.style.cursor = t === 'select' ? 'default' : 'crosshair'; $('hint').textContent = {team: 'Haz clic en un jugador, o en uno gris que no tiene equipo, y elige su equipo: vale para toda su trayectoria.', select: 'Haz clic en un dibujo para moverlo; Supr lo borra.', arrow: 'Arrastra de un punto a otro.', line: 'Arrastra de un punto a otro.', zone: 'Un clic por vértice; doble clic cierra la zona.', rect: 'Arrastra la diagonal.', circle: 'Arrastra desde el centro hasta el borde (activa «sigue al jugador» para que lo acompañe).', pen: 'Mantén presionado y dibuja.', text: 'Haz clic donde va el texto.', pick: 'Haz clic en los jugadores que forman la línea: la línea los sigue cuadro a cuadro. Otro clic los quita.', pass: 'Clic en el que pasa y luego en el que recibe (mismo equipo), en el momento del pase.'}[t]; render(); }

// ---------- the screen follows what there is: nothing, a video that has not been analysed, or data ----------
function setPlayUI(on) { const b = $('play'); b.dataset.playing = on ? 'true' : 'false'; b.setAttribute('aria-label', on ? 'Pausa' : 'Reproducir'); b.title = on ? 'Pausa (espacio)' : 'Reproducir (espacio)'; }
const stateNow = () => S.data ? 'ready' : video.src ? 'video' : 'empty';
let shownState = '';
function applyView() {   // which panes are on, from the state and from the Cancha / Video / Ambos switch
  const state = stateNow(); shownState = state; document.body.dataset.state = state;
  const showPitch = state === 'ready' && S.view !== 'video', showVideo = state === 'video' || (state === 'ready' && S.view !== 'cancha' && S.view !== 'pitch' && !!video.src);   // the two screens by default: the 2D pitch and the original video, side by side; the video one only if there is a video
  $('pitchPane').hidden = !showPitch; $('videoPane').hidden = !showVideo; $('empty').hidden = state !== 'empty'; $('cta').hidden = state !== 'video'; $('dock').hidden = state !== 'ready';
  $('stage').className = `an-stage${showPitch && showVideo ? ' both' : ''}`;
  document.querySelectorAll('.view-switch button').forEach(b => { b.disabled = b.dataset.view !== 'pitch' && !video.src; });   // Video and Ambos need a video
  video.controls = state !== 'ready';   // once analysed, the player below is the only one
  if (!S.busy) $('trkAll').disabled = state === 'empty';   // nothing to analyse yet
  sizePitch(); render(); placeThumbs();
}
const stageTitle = text => { $('stageTitle').textContent = text || ''; };
// the panel on the right can be put away so the two screens (2D pitch and original video) get the whole width; the choice is remembered
{
  const btn = $('panelToggle'), set = on => { document.body.classList.toggle('no-panel', !on); btn.setAttribute('aria-pressed', String(on)); try { localStorage.setItem('fos.panel', on ? '1' : '0'); } catch (e) { /* private window: it just starts open */ } requestAnimationFrame(() => { sizePitch(); render(); placeThumbs(); }); };
  btn.onclick = () => set(document.body.classList.contains('no-panel'));
  try { if (localStorage.getItem('fos.panel') === '0') { document.body.classList.add('no-panel'); btn.setAttribute('aria-pressed', 'false'); } } catch (e) { /* no storage */ }
}
// the selectors (Cancha / Video / Ambos and the five tabs) have a thumb that slides to the chosen one: its place is written as two variables the style reads
function placeThumb(box, sel) { const on = box && box.querySelector(sel); if (!on || !box.offsetWidth || !on.offsetWidth) return; box.style.setProperty('--tx', `${on.offsetLeft}px`); box.style.setProperty('--tw', `${on.offsetWidth}px`); box.classList.add('has-thumb'); }
const placeThumbs = () => { placeThumb(document.querySelector('.view-switch'), 'button.active'); placeThumb(document.querySelector('.tabs'), '[aria-selected=true]'); };
function selectTab(name) {
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tab-panel').forEach(p => { p.hidden = p.dataset.panel !== name; });
  placeThumbs();
}
if (window.ResizeObserver) { const ro = new ResizeObserver(placeThumbs); for (const sel of ['.view-switch', '.tabs']) { const el = document.querySelector(sel); if (el) ro.observe(el); } }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeThumbs);
requestAnimationFrame(placeThumbs);
document.querySelector('.tabs').addEventListener('click', e => { const b = e.target.closest('[role=tab]'); if (b) selectTab(b.dataset.tab); });
document.querySelector('.tabs').addEventListener('keydown', e => {   // arrows move between the tabs, as in any tab bar
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; const tabs = [...document.querySelectorAll('.tabs [role=tab]')], i = tabs.findIndex(b => b.getAttribute('aria-selected') === 'true'), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  selectTab(n.dataset.tab); n.focus(); e.preventDefault();
});

// ---------- panels and events ----------
$('tools').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTool(b.dataset.tool); });
$('inspector').addEventListener('input', () => { $('gainOut').textContent = fmt(+$('vorGain').value, 2); $('netMinOut').textContent = $('netMin').value; $('shapeMaxOut').textContent = `${$('shapeMax').value} m`; $('gainRow').hidden = $('vorMode').value === 'voronoi'; render(); });
$('shapeList').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { S.sel = S.shapes.find(s => s.id === +b.dataset.id) || null; render(); } });
for (const id of ['shT0', 'shT1']) $(id).addEventListener('change', () => { if (!S.sel) return; pushUndo(); const v = $(id).value === '' ? null : +$(id).value; if (id === 'shT0') S.sel.t0 = v; else S.sel.t1 = v; render(); });
$('shDelete').onclick = () => { if (S.sel) { pushUndo(); S.shapes = S.shapes.filter(s => s !== S.sel); S.sel = null; render(); } };
$('play').onclick = play; $('prev').onclick = () => seek(S.i - 1); $('next').onclick = () => seek(S.i + 1);
$('timeline').addEventListener('input', () => { S.playing = false; setPlayUI(false); video.pause(); seek(+$('timeline').value); });
$('live').addEventListener('change', () => { S.live = $('live').checked; $('liveBadge').hidden = !S.live; if (S.live && S.data) { $('netWin').value = '60'; } });
$('speed').addEventListener('change', () => { video.playbackRate = +$('speed').value; });
for (const b of document.querySelectorAll('.view-switch button')) b.onclick = () => { S.view = b.dataset.view; document.querySelectorAll('.view-switch button').forEach(x => x.classList.toggle('active', x === b)); placeThumbs(); applyView(); };
addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox') return;
  if (e.code === 'Space') { e.preventDefault(); play(); } else if (e.key === 'ArrowLeft') seek(S.i - (e.shiftKey ? 10 : 1)); else if (e.key === 'ArrowRight') seek(S.i + (e.shiftKey ? 10 : 1));
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { pushUndo(); S.shapes = S.shapes.filter(s => s !== S.sel); S.sel = null; render(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === 'Escape') { S.draft = null; S.passTag = null; if (S.armed !== null) { S.armed = null; renderUnits(); } closePlayerEditor(); render(); }
  else if (e.key === 'Enter' && S.draft && S.draft.type === 'zone') pitchCv.dispatchEvent(new MouseEvent('dblclick'));
  else { const t = {v: 'select', a: 'arrow', l: 'line', z: 'zone', r: 'rect', c: 'circle', p: 'pen', t: 'text'}[e.key.toLowerCase()]; if (t && !e.ctrlKey && !e.metaKey) setTool(t); }
});
addEventListener('resize', () => { sizePitch(); render(); drawMarkers(); });

// files
const pick = (btn, input) => { $(btn).onclick = () => $(input).click(); };
pick('openData', 'fileData'); pick('openVideo', 'fileVideo'); pick('openH', 'fileH'); pick('loadProject', 'fileProject');
$('fileData').onchange = async e => {
  const files = [...e.target.files]; if (!files.length) return;
  const home = files.find(f => /home/i.test(f.name)), away = files.find(f => /away/i.test(f.name));
  if (files.length >= 2 && home && away) {   // the Metrica sample data: Home and Away, a whole match is too big for the browser, so a range of minutes
    const a = prompt('Datos de Metrica: ¿desde qué minuto? (el partido completo pesa demasiado)', '0'), b = a === null ? null : prompt('¿Hasta qué minuto?', String(+a + 5)); if (a === null || b === null) return;
    try { status('Leyendo los archivos de Metrica…'); setData(fromMetrica(await home.text(), await away.text(), {t0: +a * 60, t1: +b * 60}), `Metrica · minutos ${a}–${b} (local: azul, visita: naranja)`); } catch (err) { status(`No pude leer los datos de Metrica: ${err.message}`); }
  } else if(files.length>1&&files.every(f=>/\.json$/i.test(f.name))){
    try{
      const rows=await Promise.all(files.map(async file=>{const text=await file.text();return{file,text,raw:JSON.parse(text)};}));
      const datasets=rows.filter(r=>Array.isArray(r.raw.frames));
      if(datasets.length!==1)throw new Error('Selecciona un tracking y sus archivos reconstruction.json y continuity.json de la misma revisión.');
      const tracked=datasets[0],reconstruction=rows.find(r=>r.raw.report?.estimates)?.raw||{},
        continuity=rows.find(r=>Array.isArray(r.raw.report?.segments))?.raw||{},
        settings=rows.find(r=>r.file.name==='dashboard_settings.json')?.raw||{};
      const trackingSha=await analystTrackingSha(tracked.text);
      setData(tracked.raw,tracked.file.name);installContinuity({reconstruction,continuity,settings,trackingSha});
      status(S.continuitySession?'Tracking y continuidad revisada cargados.':'Tracking cargado sin asociaciones de cámara revisadas.');
    }catch(err){status(`No pude abrir la revisión: ${err.message}`);}
  }else return loadFile(files[0]);
};
// the coordinates of every player in every frame, out: a CSV the tracker's reader opens again, or the same in JSON
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], {type})); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
const baseName = () => (($('trkName').textContent && $('trkName').textContent !== 'Ningún video' ? $('trkName').textContent : (S.label || 'partido')).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60)) + (S.data ? `_${Math.round(S.data.frames[0].t)}-${Math.round(S.data.frames[S.data.frames.length - 1].t)}s` : '');
$('exportCsv').onclick = () => {
  if (!S.data) { status('Todavía no hay datos de jugadores: analiza un video o abre datos de tracking'); return; }
  download(`coordenadas_${baseName()}.csv`, coordinatesCsv(S.data, {teamName, predicted: predicted() && predicted().byFrame}), 'text/csv'); const np = predicted() ? [...predicted().byFrame.values()].reduce((n, l) => n + l.length, 0) : 0; status(`Coordenadas exportadas: ${S.data.frames.reduce((n, f) => n + f.p.length, 0)} posiciones de jugadores en ${S.data.frames.length} cuadros${np ? ` y ${np} predichas (marcadas «predicho»)` : ''}`);
};
$('exportJson').onclick = () => {
  if (!S.data) { status('Todavía no hay datos de jugadores: analiza un video o abre datos de tracking'); return; }
  const pr = predicted(), fr = S.data.frames.map((f, i) => ({frame: f.f, t: +f.t.toFixed(3), players: f.p.map(q => ({track_id: q.id, team: q.team, x_m: +q.x.toFixed(2), y_m: +q.y.toFixed(2), speed_m_s: q.s === undefined ? null : +q.s.toFixed(2), source: 'detectado'})).concat(((pr && pr.byFrame.get(i)) || []).map(q => ({track_id: q.id, team: q.team, x_m: +q.x.toFixed(2), y_m: +q.y.toFixed(2), speed_m_s: null, source: 'predicho', horizon_s: +q.h.toFixed(2)}))), ball: f.b ? {x_m: +f.b.x.toFixed(2), y_m: +f.b.y.toFixed(2), estado:f.b.est || 'detectado', ...(Number.isFinite(f.b.conf) ? {conf:f.b.conf} : {}), ...(f.b.trajectory_id !== undefined ? {trajectory_id:f.b.trajectory_id} : {}), ...(f.b.quality_checked ? {quality_checked:true} : {})} : null, ...(f.camera_footprint_m ? {camera_footprint_m:f.camera_footprint_m} : {})}));
  download(`coordenadas_${baseName()}.json`, JSON.stringify({fps: S.data.fps, pitch: [PITCH.L, PITCH.W], teams: S.data.teams, cuts: S.data.cuts || [], frames: fr}), 'application/json'); status('Coordenadas exportadas en JSON');
};
$('realClip').onclick = async () => { try { const r = await pagesNetworkUnavailable('fixtures/tracking/aravena-sea-por.json'); setData(await r.json(), 'Clip real · Aravena vs Portugal (tracker, 10 jugadores)'); } catch (e) { status(`No pude abrir el clip: ${e.message}`); } };
// the stretch to analyse: from and to, as min:seg (the minute can pass 60, like the clock of the player). Plain seconds and h:mm:ss are understood too.
const MAX_RANGE = 600;   // s: what one analysis of the pitch follows (longer: the whole match, in stretches)
function analysisRange() {   // {start, dur, why}: why says what is wrong (or what was adjusted) in plain words
  const total = video.duration > 0 ? video.duration : Infinity, a = clockToS($('trkFrom').value), b = clockToS($('trkTo').value);
  if (Number.isNaN(a) || Number.isNaN(b)) return {start: 0, dur: 0, why: 'Escribe el principio y el final como minuto:segundo, por ejemplo 77:40.', bad: true};
  const start = Math.min(a, total), end = b >= total - 1 ? total : b;   // within a second of the end is the end: the clock rounds, the last moments are not lost
  if (start >= total) return {start, dur: 0, why: `El video dura ${clockOf(total)}: el principio tiene que ser antes.`, bad: true};
  if (end <= start) return {start, dur: 0, why: 'El final tiene que ser después del principio.', bad: true};
  let dur = end - start, why = '';   // `end` is where the video ends when the text goes past it, with its fraction of a second: the last moments are analysed too
  if (dur > MAX_RANGE) { dur = MAX_RANGE; why = `Máximo ${clockOf(MAX_RANGE)} por análisis: se analiza hasta ${clockOf(start + dur)}. Para más tiempo usa «Todo el partido».`; }
  else if (b > total + .5) why = `El video termina en ${clockOf(total)}: se analiza hasta ahí.`;
  return {start, dur, why, end: start + dur};
}
const endText = (r, total) => r.end >= total - .01 && Number.isFinite(total) ? clockOf(Math.round(total)) : clockOf(r.end);   // a video of 8,96 s ends at 0:09 on the clock, one of 6706,1 s at 111:46 (like the player)
function showRange() {
  const r = analysisRange(), note = $('rangeNote'); for (const id of ['trkFrom', 'trkTo']) $(id).setAttribute('aria-invalid', r.bad ? 'true' : 'false');
  note.textContent = r.bad ? r.why : `${clockOf(r.start)} a ${endText(r, video.duration)}: ${clockOf(Math.ceil(r.dur - 1e-6))} de video${video.duration > 0 ? ` (el video dura ${endText({end: video.duration}, video.duration)})` : ''}.${r.why ? ` ${r.why}` : ''}`;
  note.className = `small ${r.bad ? 'q-bad' : 'muted'}`;
  const cr = $('ctaRange'); if (cr) cr.textContent = r.bad ? 'sin definir' : `${clockOf(r.start)} a ${endText(r, video.duration)}`;   // the same stretch, said where the one button is
}
const rangeOrThrow = () => { const r = analysisRange(); if (r.bad) throw new Error(r.why); return r; };
for (const id of ['trkFrom', 'trkTo']) { $(id).addEventListener('input', showRange); $(id).addEventListener('change', () => { const r = analysisRange(); if (!r.bad) { $('trkFrom').value = clockOf(r.start); $('trkTo').value = endText(r, video.duration); } showRange(); }); }
$('fromHere').onclick = () => { const t = video.currentTime || 0; $('trkFrom').value = clockOf(t); if (clockToS($('trkTo').value) <= t) $('trkTo').value = clockOf(Math.min(video.duration || t + 60, t + 60)); showRange(); };
$('toHere').onclick = () => { const t = video.currentTime || 0; $('trkTo').value = clockOf(t); if (clockToS($('trkFrom').value) >= t) $('trkFrom').value = clockOf(Math.max(0, t - 60)); showRange(); };
const mmss = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const openVideoPane = () => {
  $('trkSub').textContent = `${video.videoWidth}×${video.videoHeight} · ${mmss(video.duration || 0)}`; if (!S.data) stageTitle($('trkName').textContent);
  $('rangeCard').hidden = false;
  if (video.duration > 0) { $('trkFrom').value = '0:00'; $('trkTo').value = video.duration <= 120 ? endText({end: video.duration}, video.duration) : '1:00'; showRange(); }   // a short clip is analysed whole by default: from its first second to its last, so the pitch and the lines follow it from the moment it starts to play
  if (S.view === 'pitch') document.querySelector('[data-view="both"]').click(); applyView();
};
$('fileVideo').onchange = e => {
  const f = e.target.files[0]; if (!f) return; if (S.videoURL) URL.revokeObjectURL(S.videoURL);
  S.videoURL = URL.createObjectURL(f); S.videoFile = f; S.videoId = null; $('trkPath').value = ''; video.src = S.videoURL; $('trkName').textContent = f.name;
  $('videoInfo').textContent = `${f.name}: ${currentH() ? 'cámara lista' : 'sin cámara: calíbrala, o abre la matriz del tracker'}`; video.onloadedmetadata = openVideoPane;
};
$('fileH').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; const raw = JSON.parse(await f.text());
  try {
    if (raw.image && raw.pitch) { S.H = homography(raw.image, raw.pitch); S.Hmap = null; setCalib({image: raw.image, pitch: raw.pitch}); } else if (Array.isArray(raw) && raw.length === 3) { S.H = raw; S.Hmap = null; }
    else { const byFrame = {}; for (const [k, v] of Object.entries(raw)) if (/^\d+$/.test(k)) byFrame[+k] = v; const keys = Object.keys(byFrame).map(Number).sort((a, b) => a - b); if (!keys.length) throw new Error('el archivo no tiene matrices'); S.Hmap = {byFrame, keys}; S.H = null; }
    $('videoInfo').textContent = `Cámara: ${f.name}`; status('Cámara cargada: las capas se dibujan sobre el video'); render();
  } catch (err) { status(`No pude leer la cámara: ${err.message}`); }
};
$('calib').onclick = () => {
  if (!video.src) { status('Abre primero el video'); return; } S.calibOn = !S.calibOn; S.calibPts = []; if (S.view === 'pitch') document.querySelector('[data-view="both"]').click();
  $('videoInfo').innerHTML = S.calibOn ? `Calibración: haz clic en el video sobre cada punto conocido de la cancha. <select id="lmSel">${LANDMARKS.map((l, i) => `<option value="${i}">${l[0]}</option>`).join('')}</select> <button id="lmDone">Calcular (4+ puntos)</button> <span id="lmCount">0 puntos</span>` : '';
  if (S.calibOn) { $('lmDone').onclick = finishCalibration; status('Calibrando: elige el punto de la lista y haz clic en el video'); }
  render();
};
$('vover').parentElement.addEventListener('click', e => {
  if (!S.calibOn) return; const r = $('vover').getBoundingClientRect(), s = video.videoWidth / r.width, px = (e.clientX - r.left) * s, py = (e.clientY - r.top) * s, lm = LANDMARKS[+$('lmSel').value];
  S.calibPts.push({px, py, X: lm[1], Y: lm[2], name: lm[0]}); $('lmCount').textContent = `${S.calibPts.length} puntos`; $('lmSel').selectedIndex = Math.min(LANDMARKS.length - 1, +$('lmSel').value + 1); render();
});
function finishCalibration() {
  try { S.H = homography(S.calibPts.map(p => [p.px, p.py]), S.calibPts.map(p => [p.X, p.Y])); S.Hmap = null; S.calibOn = false; setCalib({image: S.calibPts.map(p => [p.px, p.py]), pitch: S.calibPts.map(p => [p.X, p.Y])}); $('videoInfo').textContent = `Calibrado con ${S.calibPts.length} puntos (una sola cámara: sirve si la cámara no se mueve).`; status('Video calibrado'); } catch (err) { status(`No se pudo calibrar: ${err.message}`); }
  render();
}
// project
function projectJson() { return {version: 1, tacticalAnnotations: tacticalAnnotations.export(), annotationView: {slots: $('slotsOn').checked, prediction: $('predOn').checked}, ...pack(S.units, S.names, S.look), shapes: S.shapes, lineIds: S.lineIds, manual: S.manual, reds: S.reds, fixes: S.fixes, offset: vOffset(), H: S.H, controls: C()}; }
$('saveProject').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(projectJson())], {type: 'application/json'})); a.download = 'analisis-fos.json'; a.click(); status('Proyecto guardado'); };
$('fileProject').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; const p = JSON.parse(await f.text()); if (p.version !== 1) { status('Ese archivo no es un proyecto de FOS Analyst'); return; }
  { const u = unpack(p); S.units = u.units; S.names = u.names; S.look = u.look; S.armed = null; for (const [k, id] of [['num', 'lookNum'], ['name', 'lookName'], ['measure', 'lookMeasure']]) $(id).checked = !!S.look[k]; $('lookSpeed').value = S.look.speed; renderUnits(); }
  S.shapes = p.shapes || []; S.lineIds = p.lineIds || {0: [], 1: []}; S.manual = p.manual || []; S.reds = p.reds || []; S.fixes = {}; for (const [id, team] of Object.entries(p.fixes || {})) { assignTrack(S.data, id, team); S.fixes[id] = team; } S.H = p.H || S.H; $('vOffset').value = p.offset || 0; S.nextId = 1 + Math.max(0, ...S.shapes.map(s => s.id || 0));
  const c = p.controls; if (c) { $('vorOn').checked = c.vor.on; $('vorMode').value = c.vor.mode; $('vorGain').value = c.vor.gain || .9; $('vorEdges').checked = c.vor.edges; $('vorAlpha').value = c.vor.alpha; $('netOn').checked = c.net.on; $('netTeam').value = c.net.team; $('netWin').value = c.net.win; $('netMin').value = c.net.min; $('lineOn').checked = c.line.on; $('lineTeam').value = c.line.team; $('lineMethod').value = c.line.method; $('lineDir').value = c.line.dir; $('lineGk').checked = c.line.gk; $('lineTrail').checked = c.line.trail; $('offOn').checked = c.line.off; $('shapeOn').checked = c.shape.on; $('shapeTeam').value = c.shape.team; $('shapeNet').checked = c.shape.net !== false; $('shapeFill').checked = c.shape.fill !== false; $('shapeMax').value = c.shape.max || 35; $('shapeLen').checked = !!c.shape.len; $('shapeHull').checked = c.shape.hull !== false; $('shapeMaxOut').textContent = `${$('shapeMax').value} m`; }
  if (p.annotationView) { $('slotsOn').checked = p.annotationView.slots === true && !!S.slots; $('predOn').checked = p.annotationView.prediction === true; }
  S.rev++; S.cache = {}; S.auto = detectPasses(S.data); withSpeeds(S.data);rebuildEditedContinuity();renderReds(); updateNetInfo(); drawMarkers(); render();
  let annotationWarning = '';
  if (p.tacticalAnnotations) { try { tacticalAnnotations.import(p.tacticalAnnotations); } catch (error) { annotationWarning = `; anotaciones no importadas: ${error.message}`; } }
  status(`Proyecto cargado${annotationWarning}`);
};
$('snapshot').onclick = () => { render(); pitchCv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `analisis-${S.data ? clock(S.t).replace(/[:.]/g, '-') : 'vacio'}.png`; a.click(); status('Imagen exportada'); }); };

// ---------- lines of players, numbers and names ----------
function renderUnits() {   // the list of the lines of the chosen team; rebuilt when a line is added, taken out, armed or its members change, not for every picture
  const team = +$('unitTeam').value || 0, mine = S.units.filter(u => u.team === team);
  $('unitList').innerHTML = mine.map(u => `<div class="unit" data-id="${u.id}" data-armed="${S.armed === u.id}"><input type="color" value="${u.color}" aria-label="Color de ${u.name}"><input type="text" value="${u.name.replace(/"/g, '&quot;')}" maxlength="24" aria-label="Nombre de la línea" spellcheck="false"><span class="count">${u.ids.length} jug.</span><button type="button" class="mini ${S.armed === u.id ? 'primary' : ''}" data-act="arm">${S.armed === u.id ? 'Listo' : 'Elegir'}</button><span class="row-actions"><button type="button" class="mini ghost eye" data-act="eye" aria-pressed="${u.on}" title="Mostrar u ocultar la línea">${u.on ? 'Ver' : 'Oculta'}</button><button type="button" class="mini ghost" data-act="del" title="Borrar la línea" aria-label="Borrar ${u.name.replace(/"/g, '&quot;')}">×</button></span></div>`).join('');
  $('unitHint').textContent = S.armed !== null ? 'Haz clic en los jugadores de la cancha que forman la línea (otro clic en uno lo saca). Esc o «Listo» para terminar.' : 'Crea una línea, pulsa «Elegir» y haz clic en los jugadores de la cancha que la forman. Doble clic en un jugador: su número y su nombre.';
}
$('unitTeam').addEventListener('change', () => { S.armed = null; renderUnits(); });
$('unitAdd').addEventListener('click', e => { const b = e.target.closest('button[data-kind]'); if (!b || !S.data) { if (b) status('Primero abre un video o unos datos.'); return; } const u = newUnit(S.units, +$('unitTeam').value || 0, b.dataset.kind); S.units.push(u); S.armed = u.id; setTool('pick'); renderUnits(); render(); });
$('unitList').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'), row = e.target.closest('.unit'); if (!b || !row) return; const u = S.units.find(x => x.id === +row.dataset.id); if (!u) return;
  if (b.dataset.act === 'arm') { S.armed = S.armed === u.id ? null : u.id; if (S.armed !== null) setTool('pick'); else if (S.tool === 'pick') setTool('select'); }
  else if (b.dataset.act === 'eye') u.on = !u.on;
  else if (b.dataset.act === 'del') { S.units = S.units.filter(x => x !== u); if (S.armed === u.id) S.armed = null; }
  renderUnits(); render();
});
$('unitList').addEventListener('input', e => { const row = e.target.closest('.unit'), u = row && S.units.find(x => x.id === +row.dataset.id); if (!u) return; if (e.target.type === 'color') u.color = e.target.value; else u.name = e.target.value.slice(0, 24) || u.name; render(); });
for (const [id, k] of [['lookNum', 'num'], ['lookName', 'name'], ['lookMeasure', 'measure']]) $(id).addEventListener('change', () => { S.look[k] = $(id).checked; render(); });
$('lookSpeed').addEventListener('change', () => { S.look.speed = $('lookSpeed').value; render(); });
let playerEditor = null;
function closePlayerEditor() { if (playerEditor) { playerEditor.remove(); playerEditor = null; } }
function openPlayerEditor(e, q) {   // double click on a player: his shirt number and his name, and the lines he is in
  closePlayerEditor(); closeTeamMenu();
  const w = S.names[q.id] || {}, m = document.createElement('div'); m.className = 'player-editor'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-label', 'Número y nombre del jugador');
  const lines = S.units.filter(u => u.team === q.team);
  m.innerHTML = `<div class="pop-head">${teamName(q.team)} · jugador ${String(q.id).slice(-3)}</div><label>Número de camiseta<input id="peNum" inputmode="numeric" maxlength="3" autocomplete="off" value="${(w.num || '').replace(/"/g, '&quot;')}"></label><label>Nombre<input id="peName" maxlength="24" autocomplete="off" spellcheck="false" value="${(w.name || '').replace(/"/g, '&quot;')}"></label>${lines.length ? `<div class="chips">${lines.map(u => `<button type="button" class="mini" data-unit="${u.id}" aria-pressed="${u.ids.includes(q.id)}">${u.name}</button>`).join('')}</div>` : ''}<div class="btn-row"><button type="button" class="mini primary" data-act="save">Guardar</button><button type="button" class="mini ghost" data-act="clear">Quitar</button></div>`;
  m.style.left = `${Math.max(8, Math.min(e.clientX + 10, innerWidth - 264))}px`; m.style.top = `${Math.max(8, Math.min(e.clientY + 10, innerHeight - 250))}px`;
  const save = () => { setPlayer(S.names, q.id, {num: m.querySelector('#peNum').value, name: m.querySelector('#peName').value}); closePlayerEditor(); render(); };
  m.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    if (b.dataset.unit) { const u = S.units.find(x => x.id === +b.dataset.unit); if (u) { toggleMember(S.units, u, q.id, q.team); b.setAttribute('aria-pressed', String(u.ids.includes(q.id))); renderUnits(); render(); } }
    else if (b.dataset.act === 'save') save(); else if (b.dataset.act === 'clear') { setPlayer(S.names, q.id, {}); closePlayerEditor(); render(); }
  });
  m.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); save(); } else if (ev.key === 'Escape') { ev.stopPropagation(); closePlayerEditor(); } });
  document.body.appendChild(m); playerEditor = m; m.querySelector('#peNum').focus();
}
addEventListener('pointerdown', e => { if (playerEditor && !playerEditor.contains(e.target) && e.target !== pitchCv) closePlayerEditor(); });
renderUnits();

// with a followed pitch and no tracking data, the video itself is the clock: the lines are redrawn for every frame shown
const overlayNow = () => { if (S.Hmap && !S.playing) renderVideoOverlay(S.data && !S.stale ? S.data.frames[Math.min(S.i, S.data.frames.length - 1)] : null, C()); };   // while S.playing, tick() redraws everything
if (video.requestVideoFrameCallback) { const loop = (now, md) => { video.requestVideoFrameCallback(loop); vclock = md.mediaTime; try { overlayNow(); } catch (e) { console.error(e); } }; video.requestVideoFrameCallback(loop); }   // asked for again first: a picture that fails to draw must not stop the next ones else video.addEventListener('timeupdate', overlayNow);
// the video's own controls drive the analysis too: playing it plays the data, pausing stops it, and moving its bar moves the frame of the data
video.addEventListener('play', () => { if (!S.data) return; if (!S.playing) { S.playing = true; setPlayUI(true); lastTs = performance.now(); } if (!raf) raf = requestAnimationFrame(tick); });   // the loop runs whoever started the video
const videoStopped = () => { if (!S.playing || video.seeking) return; S.playing = false; setPlayUI(false); render(); };
video.addEventListener('pause', videoStopped); video.addEventListener('ended', videoStopped);
video.addEventListener('seeked', () => {
  if (S.match) followMatch(video.currentTime);
  if (S.data && !S.playing) { S.t = video.currentTime - vOffset(); S.i = frameAtOrBefore(S.data, S.t); render(); drawMarkers(); } else overlayNow();
});

// the start card and the menu
new MutationObserver(() => { $('trkName').title = $('trkName').textContent; }).observe($('trkName'), {childList: true, characterData: true, subtree: true});   // a long file name is cut with an ellipsis: the full one shows on hover
$('emptyVideo').onclick = () => $('openVideo').click(); $('emptyData').onclick = () => $('openData').click(); $('emptyDemo').onclick = () => $('realClip').click();
const menus = [...document.querySelectorAll('details.menu')];
for (const m of menus) m.addEventListener('click', e => { if (e.target.closest('.menu-pop button')) m.open = false; });
document.addEventListener('click', e => { for (const m of menus) if (m.open && !m.contains(e.target)) m.open = false; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') for (const m of menus) if (m.open) { m.open = false; m.querySelector('summary').focus(); } });
// a video or a data file dropped anywhere on the page
const dropZone = $('drop');
dropZone.onclick = () => $('openVideo').click();
for (const ev of ['dragenter', 'dragover']) addEventListener(ev, e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dropZone.classList.add('over'); } });
for (const ev of ['dragleave', 'drop']) addEventListener(ev, e => { if (ev === 'drop' || e.target === document.documentElement || !e.relatedTarget) dropZone.classList.remove('over'); });
addEventListener('drop', e => {
  const files = [...(e.dataTransfer?.files || [])]; if (!files.length) return; e.preventDefault();
  const send = (input, list) => { const dt = new DataTransfer(); list.forEach(f => dt.items.add(f)); input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles: true})); };
  const vid = files.find(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)), data = files.filter(f => /\.(json|csv)$/i.test(f.name));
  if (vid) send($('fileVideo'), [vid]); else if (data.length) send($('fileData'), data); else status('Ese archivo no es un video ni datos de tracking');
});
// the call to action over a video that has just been opened
$('ctaAnalyze').onclick = () => $('trkAll').click();
$('ctaRangeEdit').onclick = () => { selectTab('analisis'); $('inspector').scrollTo({top: 0, behavior: 'smooth'}); $('trkFrom').focus(); $('trkFrom').select(); };
$('ctaSettings').onclick = () => { selectTab('analisis'); const d = document.querySelector('[data-panel=analisis] details.disclosure'); if (d) d.open = true; $('inspector').scrollTo({top: 0, behavior: 'smooth'}); };
$('ctaCancel').onclick = () => $('trkCancel').click();
video.addEventListener('click', () => { if (S.data) play(); });

// start
globalThis.fosAnalyst = {get map() { return map; }, S, push, setData, render, seek, C, loadRaw: raw => setData(raw, 'datos'), loadResult:openReviewedResult, project: projectJson};
sizePitch(); $('gainRow').hidden = $('vorMode').value === 'voronoi'; setTool('select'); render();

// ---------- video -> tracking (the server runs tools/tracking/track_players.py) ----------
const api = async (path, body, method) => { const r = await pagesNetworkUnavailable(`/api/analyst/${path}`, body === undefined ? {} : {method: method || 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `error ${r.status}`); return j; };
function setCalib(c, how) { S.calib = c; S.camJob = null; S.blocked = false; $('trkUseAnyway').hidden = true; $('trkCalibState').textContent = `calibrada ${how || 'con'} ${c.image.length} puntos`; $('trkLinesRow').hidden = false; $('trkFlip').hidden = false; render(); }
$('swapTeams').onclick = () => { if (!S.data) return; S.swapped = !S.swapped; for (const fr of S.data.frames) for (const q of fr.p) q.team = 1 - q.team;refresh();status('Equipos intercambiados'); };
$('trkPick').onclick = () => $('fileVideo').click();
$('trkCalib').onclick = () => $('calib').click();
$('trkLines').onchange = render;
$('trkPath').onchange = async () => {   // the video where it is on this computer: nothing is copied
  const p = $('trkPath').value.trim().replace(/^["']|["']$/g, ''); if (!p) return;
  try { const r = await api('register', {path: p}); S.videoId = r.id; S.videoFile = null; S.match = null; S.chunk = null; $('trkName').textContent = r.name; refreshMatch(); video.src = `/api/analyst/video?id=${r.id}`; video.onloadedmetadata = openVideoPane; $('videoInfo').textContent = `${r.name}: ${currentH() ? 'cámara lista' : 'sin cámara: calíbrala'}`; status('Video registrado'); }
  catch (e) { status(e.message); }
};
function ensureVideoId() { return Promise.reject(new Error('El análisis automático requiere el PC con Python/GPU.')); }
let trkSpan = [0, 1];   // the part of the bar a phase has: the whole of it alone, the first or the second half when the pitch and the players run one after the other
function trkProgress(p, msg) {
  const w = `${Math.round((trkSpan[0] + p * (trkSpan[1] - trkSpan[0])) * 100)}%`; $('trkBarWrap').hidden = false; $('trkBar').style.width = w; $('ctaBar').style.width = w;
  if (msg) { $('trkMsg').textContent = msg; $('ctaMsg').textContent = msg; }
  $('ctaStep').textContent = trkSpan[0] >= .5 ? 'Detectando a los jugadores…' : trkSpan[1] < 1 ? 'Buscando la cancha…' : 'Analizando…';
}
let trkJob = null;
async function waitJob(job, base, span) {   // follows a server job: the bar moves from `base` by `span`; resolves with the final status ('done' or 'cancelled')
  for (;;) {
    await new Promise(r => setTimeout(r, 900)); const st = await api(`status?job=${job}`);
    trkProgress(base + st.progress * span, st.message);
    if (st.status === 'error') throw new Error(st.error || 'el trabajo falló');
    if (st.status === 'done' || st.status === 'cancelled') return st;
  }
}
const trkBusy = on => { S.busy = on; $('trkRun').disabled = $('trkAuto').disabled = $('trkAll').disabled = $('ctaAnalyze').disabled = on; $('trkCancel').hidden = !on; $('ctaIdle').hidden = on; $('ctaBusy').hidden = !on; if (on) $('ctaBar').style.width = '0'; };
const guarded = fn => async () => {   // one job at a time; whatever fails is said in the message line
  if (trkJob) return;
  try { trkBusy(true); trkSpan = [0, 1]; trkProgress(0, 'Preparando…'); await fn(); }
  catch (e) { $('trkMsg').textContent = e.message; status(e.message); }
  finally { trkJob = null; trkBusy(false); trkSpan = [0, 1]; }
};
async function detectPlayers() {   // 'done' or 'cancelled'
  if (!S.calib && !S.camJob) throw new Error('Primero calibra la cancha: pulsa «Detectar la cancha sola» o elige 4 o más puntos conocidos en el video (esquinas, áreas, círculo central).');
  if (S.blocked) throw new Error('La calibración salió mala: revisa las líneas sobre el video y, si aun así quieres analizar con ella, pulsa «Usar igual».');
  const {start, dur} = rangeOrThrow(), id = await ensureVideoId();
  const {job} = await api('track', {video: id, start, duration: dur, stride: +$('trkStride').value, ball: $('trkBall').checked, device: $('trkDevice').value, ...(S.camJob ? {camera_job: S.camJob} : {calib: S.calib})}); trkJob = job;
  const st = await waitJob(job, .1, .9);
  if (st.status === 'cancelled') { trkProgress(0, 'Análisis cancelado.'); return 'cancelled'; }
  const resultUrl=new URL(st.result,location.href);
  if(resultUrl.origin===location.origin&&resultUrl.pathname==='/api/dashboard/result'&&resultUrl.searchParams.has('job')){
    await openReviewedResult(resultUrl.searchParams.get('job'));
  }else{
    const raw = await (await pagesNetworkUnavailable(st.result)).json(); $('vOffset').value = 0; setData(raw, `Video analizado: ${S.videoFile ? S.videoFile.name : $('trkName').textContent} · ${clockOf(start)}–${clockOf(start + dur)}`);
  }
  trkProgress(1, 'Listo: ya puedes ver las capas sobre el video y la cancha.'); return 'done';
}
$('trkRun').onclick = guarded(async () => { await detectPlayers(); });
// the pitch found by itself: a model looks for the corners, the boxes and the centre circle in a few frames of the stretch and the server fits the camera
const QLEVEL = {buena: 'good', débil: 'weak', mala: 'bad'};
function showQuality(c) {
  const q = c.quality, el = $('trkQuality'); el.hidden = false;
  if (!c.ok || !q) { el.className = 'small q-bad'; el.textContent = c.message || 'No se pudo calibrar.'; return; }
  el.className = `small q-${QLEVEL[q.level] || 'weak'}`; el.innerHTML = `<b>Calidad ${q.level}</b>${q.why}<span class="rest">${c.message}</span>`;
}
function applyAutoCalib(c) {   // true when the calibration was taken
  showQuality(c); if (!c.ok) { status('No encontré la cancha en ese tramo'); return false; }
  S.H = homography(c.image, c.pitch); S.Hmap = null; setCalib({image: c.image, pitch: c.pitch}, 'sola con'); $('trkLines').checked = true;
  if (c.quality && c.quality.level === 'mala') { S.blocked = true; $('trkUseAnyway').hidden = false; }   // visible to judge by eye; analysing with it needs a yes
  if (S.view === 'pitch') document.querySelector('[data-view="both"]').click();
  if (c.fps && c.frame != null && video.readyState) video.currentTime = c.frame / c.fps;   // the frame where the model saw the most: the one to check the lines against
  $('videoInfo').textContent = `Cancha detectada sola (calidad ${c.quality.level}): revisa que las líneas verdes calcen con las del video${c.static ? '' : ' (la cámara se mueve: vale cerca de este cuadro)'}.`;
  status(`Cancha detectada (${c.quality.level})`); render(); return true;
}
// a camera that pans: one calibration is not enough, the pitch is followed frame by frame
async function followCamera(id, start, dur) {
  trkProgress(.02, 'La cámara se mueve: sigo la cancha cuadro a cuadro…');
  const {job} = await api('camtrack', {video: id, start, duration: Math.min(dur, 300)}); trkJob = job;
  const st = await waitJob(job, .02, .98);
  if (st.status === 'cancelled') return null;
  return applyCameraTrack(job, await (await pagesNetworkUnavailable(st.result)).json(), start);
}
async function applyCameraTrack(job, cam, start) {
  showQuality(cam); if (!cam.ok) { status('No pude seguir la cancha en ese tramo'); return false; }
  const hom = await (await pagesNetworkUnavailable(`/api/analyst/homographies?job=${job}`)).json(), byFrame = {};
  for (const [k, v] of Object.entries(hom)) byFrame[+k] = v;
  const keys = Object.keys(byFrame).map(Number).sort((a, b) => a - b);
  S.Hmap = {byFrame, keys, fps: cam.fps}; S.H = null; S.calib = null; S.camJob = job; S.camRange = [keys[0], keys[keys.length - 1]];
  S.blocked = !!(cam.quality && cam.quality.level === 'mala'); $('trkUseAnyway').hidden = !S.blocked;
  $('trkCalibState').textContent = `cancha seguida en ${keys.length} cuadros`; $('trkLinesRow').hidden = false; $('trkFlip').hidden = false; $('trkLines').checked = true;
  if (S.view === 'pitch') document.querySelector('[data-view="both"]').click();
  if (video.readyState) video.currentTime = start;
  $('videoInfo').textContent = `Cancha seguida (calidad ${cam.quality.level}): las líneas verdes se mueven con la cámara. Reproduce el video para revisarlas.`;
  status(`Cancha seguida (${cam.quality.level})`); renderVideoOverlay(null, C()); return true;
}
async function detectPitch() {   // 'ok', 'failed' (the reason is on screen) or 'cancelled'
  const range = rangeOrThrow(), start = range.start, id = await ensureVideoId(), dur = Math.min(range.dur, 60);
  const known = await api(`camera_known?video=${id}`, undefined, 'GET').catch(() => ({bank: false}));   // a video whose camera is already known (it moves: there is a bank of reference frames) is followed directly
  if (known.bank) {
    trkProgress(.02, 'Este video ya tiene referencias de su cámara: sigo la cancha cuadro a cuadro…');
    const ok = await followCamera(id, start, range.dur);
    if (ok === null) { trkProgress(0, 'Cancelado.'); return 'cancelled'; }
    if (ok) { trkProgress(1, 'Listo: reproduce el video y mira cómo las líneas siguen a la cámara.'); return 'ok'; }
    trkProgress(0, 'No quedó calibrada: mira el motivo abajo.'); return 'failed';
  }
  const {job} = await api('autocalib', {video: id, start, duration: dur, samples: 16}); trkJob = job;
  const st = await waitJob(job, .05, .45);
  if (st.status === 'cancelled') { trkProgress(0, 'Cancelado.'); return 'cancelled'; }
  const c = await (await pagesNetworkUnavailable(st.result)).json();
  if (c.ok && c.static) { if (applyAutoCalib(c)) { trkProgress(1, 'Listo: mira las líneas de la cancha sobre el video.'); return 'ok'; } trkProgress(0, 'No quedó calibrada: mira el motivo abajo.'); return 'failed'; }
  const ok = await followCamera(id, start, range.dur);   // not fixed (or nothing seen in the samples): follow it over the whole stretch asked for
  if (ok === null) { trkProgress(0, 'Cancelado.'); return 'cancelled'; }
  if (ok) { trkProgress(1, 'Listo: reproduce el video y mira cómo las líneas siguen a la cámara.'); return 'ok'; }
  trkProgress(0, 'No quedó calibrada: mira el motivo abajo.'); return 'failed';
}
$('trkAuto').onclick = guarded(async () => { await detectPitch(); });
// everything in one go: the pitch (followed if the camera moves), then the players, then the layers that answer "where is the space, how high is the line, how compact is the team"
function showEverything() {
  for (const id of ['vorOn', 'lineOn', 'lineLast', 'shapeOn']) $(id).checked = true;
  const predict = S.data && S.data.frames.length <= PREDICT_AUTO_FRAMES;   // 11 a side: who the video does not show is placed (hollow). Done for a stretch of up to ~2 minutes; for longer ones it takes seconds, so the switch stays the analyst's
  if (predict) { $('predOn').checked = true; renderPredNote(); }
  selectTab('capas'); render(); status(`Cancha y jugadores detectados: espacio, línea defensiva con el último hombre y red del equipo, sobre la cancha y el video${predict ? '; a quienes el video no muestra se los ubica con círculos huecos' : ''}`);
}
const PREDICT_AUTO_FRAMES = 2000;
$('trkAll').onclick = guarded(async () => {
  trkSpan = [0, .5]; if (await detectPitch() !== 'ok') return;
  if (S.blocked) { trkProgress(1, ''); throw new Error('La cancha salió con calidad mala: revisa las líneas sobre el video y, si quieres seguir con ella, pulsa «Usar igual» y después «Solo los jugadores».'); }
  trkSpan = [.5, 1]; trkProgress(0, 'Ahora, los jugadores…'); if (await detectPlayers() === 'done') showEverything();
});
$('trkUseAnyway').onclick = () => { S.blocked = false; $('trkUseAnyway').hidden = true; status('Se analizará con esta calibración'); };
$('trkFlip').onclick = () => {   // the model's left/right can come out reversed: a half turn of the pitch fixes it
  if (S.Hmap) {   // a followed pitch: the half turn is applied to every matrix
    const F = [[-1, 0, 105], [0, -1, 68], [0, 0, 1]], mul = (A, B) => A.map(r => [0, 1, 2].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    for (const k of S.Hmap.keys) S.Hmap.byFrame[k] = mul(F, S.Hmap.byFrame[k]);
    status('Cancha girada 180° (se aplica al seguimiento y se pierde si lo vuelves a calcular)'); S.flipped = !S.flipped; renderVideoOverlay(null, C()); return;
  }
  if (!S.calib) return; const pitch = S.calib.pitch.map(([X, Y]) => [105 - X, 68 - Y]);
  S.H = homography(S.calib.image, pitch); S.Hmap = null; setCalib({image: S.calib.image, pitch}, 'y girada con'); status('Cancha girada 180°'); render();
};
$('trkCancel').onclick = () => { if (trkJob) api(`cancel?job=${trkJob}`, {}).catch(() => {}); };
// the teams: names and colours the analyst can change (the tracker only knows two groups of shirts)
function syncTeamInputs() { for (const k of [0, 1]) { $(`team${k}Name`).value = teamName(k); $(`team${k}Color`).value = teamColor(k); } }
for (const k of [0, 1]) for (const f of ['Name', 'Color']) $(`team${k}${f}`).addEventListener('input', () => {
  if (!S.data) return; S.data.teams[k][f.toLowerCase()] = $(`team${k}${f}`).value;
  for (const id of ['netTeam', 'lineTeam', 'shapeTeam', 'unitTeam']) { const el = $(id), keep = el.value; el.innerHTML = [0, 1].map(j => `<option value="${j}">${teamName(j)}</option>`).join(''); el.value = keep; }
  render();
});
// ---------- the whole match: chunks of 5 minutes analysed in the background (tools/tracking/analyze_match.py), read one at a time ----------
let matchTimer = 0;
const processedMatchChunk=c=>!!c&&['listo','sin_cancha'].includes(c.status);
const matchReady = () => !!(S.match && S.match.chunks.some(processedMatchChunk));
const chunkAt = t => S.match && S.match.chunks.find(c => t >= c.start && t < c.start + c.duration);
const fmtMin = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function matchClock(t) {   // the minute of the match for a second of the video, from the periods the processor found (read from the scoreboard clock of the broadcast when there is one, else estimated from how many people are on the pitch)
  for (const p of (S.match && S.match.periods) || []) if (t >= p.start && t < p.end && (p.kind === 'primer_tiempo' || p.kind === 'segundo_tiempo')) return fmtMin(t - p.start + (p.clock0 || 0));
  return '';
}
async function refreshMatch() {
  clearTimeout(matchTimer);
  if (!S.videoId) { renderMatch(); return; }
  const m = await api(`match?video=${S.videoId}`, undefined, 'GET').catch(() => null);
  if (m) S.match = m.chunks && m.chunks.length ? m : null;
  renderMatch();
  if (S.match && video.src) followMatch(video.currentTime || 0, true);
  if (m && m.status === 'running') matchTimer = setTimeout(refreshMatch, 6000);
}
function modelReviewMessage(match, loadedVersion = null) {
  const review = match?.model_review;
  if (review?.status !== 'needs_revision' || !review.version || review.version !== match?.slots?.version || loadedVersion && loadedVersion !== review.version) return '';
  return `Movimiento 2D no validado (${review.version}). ${review.reason || 'Requiere revisión visual.'} Las posiciones del modelo no deben usarse como tracking preciso; las detecciones originales se conservan.`;
}
function renderModelReview() {
  const message = modelReviewMessage(S.match,S.slotModelVersion), note = $('modelReviewNote');
  note.hidden = !message; note.textContent = message;
}
function renderMatch() {
  const m = S.match, ready = matchReady(), running = !!m && m.status === 'running';
  renderModelReview();
  $('matchStart').disabled = !S.videoId || running; $('matchStop').hidden = !running; $('matchCsv').disabled = !ready; $('exportMatchCsv').disabled = !ready; $('exportSlotsCsv').disabled = !ready || !(S.match && S.match.slots);
  const total = m ? m.chunks.length : 0, done = m ? m.chunks.filter(c => c.status === 'listo').length : 0, sc = m ? m.chunks.filter(c => c.status === 'sin_cancha' || c.status === 'error').length : 0;
  const wantBall = $('trkBall').checked, noBall = m ? m.chunks.filter(c => c.status === 'listo' && !c.ball).length : 0, withBall = m ? m.chunks.filter(c => c.ball).length : 0;
  $('matchStart').textContent = !m ? 'Analizar todo el partido' : running ? 'Analizando…' : m.status === 'done' && !sc ? (wantBall && noBall ? 'Agregar el balón' : 'Analizado') : 'Continuar el análisis';
  $('matchProg').hidden = !m; $('chunkStrip').hidden = !m; $('matchProgBar').style.width = `${Math.round((m ? m.progress : 0) * 100)}%`;
  $('matchInfo').textContent = !m ? (S.videoId ? '' : 'Elige el video escribiendo su ruta (en «Ajustes del análisis»): así no se copia y el análisis lo puede leer.') :
    running ? `Analizando: ${done} de ${total} tramos listos (${Math.round(m.progress * 100)} %)${m.eta_s ? ` · quedan unos ${fmtMin(m.eta_s)} min` : ''}. Los tramos listos ya se pueden ver.` :
    m.status === 'done' ? `${done} de ${total} tramos listos${sc ? `, ${sc} sin cancha o con error` : ''}. Todo el partido se puede ver y descargar.${withBall ? ` Balón en ${withBall} de ${done} tramos.` : wantBall && noBall ? ' Sin balón todavía: «Agregar el balón» lo sigue en los tramos hechos.' : ''}` : `Detenido: ${done} de ${total} tramos listos. «Continuar» sigue donde iba.`;
  const pos = c => `left:${c.start / Math.max(1, m.duration) * 100}%;width:${c.duration / Math.max(1, m.duration) * 100}%`;   // by time, so a match analysed only in part still lines up with the video
  $('chunkStrip').innerHTML = m ? m.chunks.map(c => `<i class="st-${c.status}${c.status === 'listo' && c.quality === 'mala' ? ' q-mala' : ''}" style="${pos(c)}" title="${fmtMin(c.start)}–${fmtMin(c.start + c.duration)}: ${c.status.replace('_', ' ')}${c.quality ? ` · cancha ${c.quality}` : ''}${c.message ? ` · ${c.message}` : ''}"></i>`).join('') : '';
  $('gotoBox').hidden = !ready; if (ready) $('gotoBox').querySelector('label').firstChild.textContent = m.periods && m.periods.length ? 'Ir al minuto del partido ' : 'Ir al minuto del video ';
  const mb = $('matchBar'), on = ready && !!video.src;
  $('timeline').hidden = $('markers').hidden = on; mb.hidden = !on; $('clockTotal').textContent = on ? `/ ${fmtMin(m.duration)}` : $('clockTotal').textContent;
  if (on) mb.innerHTML = m.chunks.map(c => `<i class="st-${c.status}" style="${pos(c)}" title="${fmtMin(c.start)}–${fmtMin(c.start + c.duration)}"></i>`).join('') + '<b class="mb-head"></b>';
  matchHead();
}
function matchHead() {
  const m = S.match, h = $('matchBar').querySelector('.mb-head'); if (!m || !h) return; const t = video.currentTime || 0;
  h.style.left = `${Math.min(100, t / Math.max(1, m.duration) * 100)}%`; const mm = matchClock(t); $('matchMinute').hidden = !mm; $('matchMinute').textContent = mm ? `· min ${mm}` : '';
}
function followMatch(t, quiet) {   // the chunk that has the video's time is loaded; one that is not analysed yet leaves an empty pitch and says so
  const m = S.match; if (!m) return;
  const c = chunkAt(t);
  if (processedMatchChunk(c)) {
    if (S.chunk === c.i && S.data) { if (S.stale) { S.stale = false; stageTitle(S.label); render(); } } else if (S.loadingChunk !== c.i) loadChunk(c.i, t);
    const nx = m.chunks[c.i + 1]; if (processedMatchChunk(nx) && c.start + c.duration - t < 20) fetchChunk(nx.i).catch(() => {});
    return;
  }
  if (!S.data) { const near = m.chunks.filter(processedMatchChunk).sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0]; if (near && S.loadingChunk !== near.i) loadChunk(near.i, near.start).then(() => { S.stale = true; render(); }); return; }
  if (!S.stale) { S.stale = true; stageTitle('Tramo sin analizar'); if (!quiet) status('Ese tramo del partido todavía no está analizado'); render(); }
}
const chunkCache = new Map();   // video:i -> Promise([tracking, homographies, slots]); the two stretches around the playhead
function fetchChunk(i) {
  const key = `${S.videoId}:${i}`; if (chunkCache.has(key)) return chunkCache.get(key);
  const pr = Promise.all([pagesNetworkUnavailable(`/api/analyst/match/chunk?video=${S.videoId}&i=${i}`).then(r => r.ok ? r.json() : Promise.reject(new Error('el tramo no está listo'))), pagesNetworkUnavailable(`/api/analyst/match/h?video=${S.videoId}&i=${i}`).then(r => r.ok ? r.json() : {}), pagesNetworkUnavailable(`/api/analyst/match/slots?video=${S.videoId}&i=${i}`).then(r => r.ok ? r.json() : null).catch(() => null)]);
  chunkCache.set(key, pr); pr.catch(() => chunkCache.delete(key)); while (chunkCache.size > 2) chunkCache.delete(chunkCache.keys().next().value);
  return pr;
}
async function loadChunk(i, t) {
  S.loadingChunk = i;
  try {
    const [raw, h, slots] = await fetchChunk(i);
    const c = S.match.chunks[i], label = `${$('trkName').textContent} · tramo ${i + 1} de ${S.match.chunks.length} (video ${fmtMin(c.start)}–${fmtMin(c.start + c.duration)})`;
    setData(raw, label, {i, h, slots, t: t ?? c.start}); renderModelReview(); if (S.view === 'pitch' && video.src) document.querySelector('[data-view="both"]').click();
    $('videoInfo').textContent = `Tramo ${i + 1} de ${S.match.chunks.length}${c.quality ? ` · cancha ${c.quality}` : ''}${Object.keys(h).length?': revisa las líneas verdes sobre el video.':': sin calibración actual; las posiciones2D son estimadas.'}`;
    status(`Tramo ${i + 1} de ${S.match.chunks.length} cargado${c.quality ? ` · cancha ${c.quality}` : ''}`);
  } catch (e) { status(`No pude cargar el tramo: ${e.message}`); } finally { S.loadingChunk = null; }
  if (S.match && video.src) { const c = chunkAt(video.currentTime || 0); if (processedMatchChunk(c) && c.i !== S.chunk && S.loadingChunk !== c.i) loadChunk(c.i, video.currentTime); }
}
function seekMatchTo(t) { t = Math.max(0, Math.min(S.match.duration - .05, t)); video.currentTime = t; followMatch(t); if (S.data && !S.stale && chunkAt(t) && S.chunk === chunkAt(t).i) { S.i = frameAtOrBefore(S.data, t); S.t = t; } render(); drawMarkers(); }
(() => {   // the match bar: a click or a drag moves the video, and the stretch under it is loaded
  const bar = $('matchBar'); let down = false; const at = e => { const r = bar.getBoundingClientRect(); seekMatchTo((e.clientX - r.left) / r.width * S.match.duration); };
  bar.addEventListener('pointerdown', e => { if (!S.match) return; down = true; bar.setPointerCapture(e.pointerId); S.playing && (S.playing = false, setPlayUI(false), video.pause()); at(e); });
  bar.addEventListener('pointermove', e => { if (down && S.match) at(e); }); bar.addEventListener('pointerup', () => { down = false; });
  bar.addEventListener('keydown', e => { if (!S.match) return; const step = e.shiftKey ? 60 : 10; if (e.key === 'ArrowRight') { seekMatchTo(video.currentTime + step); e.preventDefault(); } if (e.key === 'ArrowLeft') { seekMatchTo(video.currentTime - step); e.preventDefault(); } });
})();
$('trkBall').addEventListener('change', () => { if (S.match) renderMatch(); });
$('matchStart').onclick = async () => {
  if (!S.videoId) { status('Primero elige el video escribiendo su ruta'); return; }
  try { const r = await api('match', {video: S.videoId, chunk: 300, from: Math.floor(video.currentTime || 0), ball: $('trkBall').checked}); S.match = r.chunks && r.chunks.length ? r : S.match; status(r.already ? 'El partido ya se está analizando' : 'Analizando el partido entero en segundo plano'); }
  catch (e) { status(e.message); }
  refreshMatch();
};
$('matchStop').onclick = async () => { try { await api(`match/stop?video=${S.videoId}`, {}); status('Deteniendo el análisis…'); } catch (e) { status(e.message); } setTimeout(refreshMatch, 1500); };
const downloadMatchCsv = () => { if (!S.videoId) return; const a = document.createElement('a'); a.href = `/api/analyst/match/csv?video=${S.videoId}${$('matchCsvHz').value ? `&hz=${$('matchCsvHz').value}` : ''}`; a.click(); status('Descargando las coordenadas de todo el partido'); };
$('matchCsv').onclick = $('exportMatchCsv').onclick = downloadMatchCsv;
$('exportSlotsCsv').onclick = () => { if (!S.videoId) return; const a = document.createElement('a'); a.href = `/api/analyst/match/csv?video=${S.videoId}&slots=1&hz=5`; document.body.appendChild(a); a.click(); a.remove(); status('Bajando los 11 de cada equipo (5 por segundo)'); };
$('gotoGo').onclick = () => {
  if (!S.match) return; const min = +$('gotoMin').value, p = S.match.periods || [], p1 = p.find(x => x.kind === 'primer_tiempo'), p2 = p.find(x => x.kind === 'segundo_tiempo');
  const t = p1 ? (min <= 45 || !p2 ? p1.start + min * 60 : p2.start + min * 60 - (p2.clock0 || 2700)) : min * 60; seekMatchTo(t);
};

// Added only to the static Analyst copy by the allowlist builder.
let pagesRange = null;
function pagesNote() {
  $('trkEnv').textContent = 'Visor estático: no detecta ni sube videos. Importa tracking calculado en el PC para ver el mapa 2D.';
  $('rangeNote').textContent = 'Tramo de reproducción; no ejecuta análisis automático.';
}
for (const id of ['trkAll', 'trkAuto', 'trkRun', 'ctaAnalyze', 'matchStart', 'matchStop', 'labelConfirm', 'realClip']) {
  $(id).onclick = () => status('Esta web reproduce y anota datos importados. El análisis automático requiere el PC con Python/GPU.');
  $(id).disabled = true;
}
$('trkPath').disabled = true;
$('empty').querySelector('h1').textContent = 'Video y tracking de tu dispositivo';
$('empty').querySelector('.hero-card > p').textContent = 'Abre un video local y sus datos de tracking para usar el mapa 2D. Esta web no ejecuta detección ni calibración automática.';
$('trkSub').textContent = 'Video local; sin subida';
for (const id of ['trkFrom', 'trkTo']) $(id).addEventListener('input', () => {
  try { pagesRange = playbackRange($('trkFrom').value, $('trkTo').value, video.duration); } catch { pagesRange = null; }
  pagesNote();
});
video.addEventListener('timeupdate', () => {
  if (pagesRange && !video.paused && video.currentTime >= pagesRange.end) { video.pause(); S.playing = false; setPlayUI(false); }
});
async function pagesOpen({video: file, tracking = [], camera = null, range, type = 'tv'}) {
  if (!isVideo(file)) throw new Error('Elige un video compatible.');
  cameraLabel(type);
  video.pause(); S.playing = false; S.data = null; S.rawTracking = null; S.continuitySession = null; S.continuityBundle = null;
  S.H = null; S.Hmap = null; S.match = null; S.chunk = null; S.slots = null; S.calib = null; S.camJob = null;
  S.shown = null; S.annotationSource = null; S.annotationRevision = null;
  S.shapes = []; S.units = []; S.names = {}; S.reds = []; S.fixes = {}; S.manual = []; S.lineIds = {0: [], 1: []};
  $('predOn').checked = false; $('slotsOn').checked = false;
  if (S.videoURL) URL.revokeObjectURL(S.videoURL);
  S.videoURL = URL.createObjectURL(file); S.videoFile = file; S.videoId = null;
  $('trkName').textContent = file.name;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.onloadedmetadata = null; video.onerror = null; };
    const fail = message => { cleanup(); reject(new Error(message)); };
    const timer = setTimeout(() => fail('El video tardó demasiado en abrirse. Vuelve a intentarlo.'), 25000);
    video.onloadedmetadata = () => { cleanup(); openVideoPane(); resolve(); };
    video.onerror = () => fail('El navegador no puede reproducir este formato. Prueba MP4 H.264/AAC.');
    video.src = S.videoURL;
  });
  if (tracking.length) {
    await $('fileData').onchange({target: {files: tracking}});
    if (!S.data) throw new Error('No se pudo leer el tracking. Revisa el formato de tus archivos.');
  }
  if (camera) await $('fileH').onchange({target: {files: [camera]}});
  const valid = playbackRange(String(range?.start ?? 0), String(range?.end ?? Math.min(30, video.duration)), video.duration);
  pagesRange = valid; $('trkFrom').value = clockOf(valid.start); $('trkTo').value = clockOf(valid.end);
  video.currentTime = valid.start;
  if (S.data) { S.i = frameAtOrBefore(S.data, valid.start - vOffset()); S.t = S.data.frames[S.i].t; $('timeline').value = S.i; }
  $('videoInfo').textContent = `${cameraLabel(type)} · archivo local · ${S.data ? 'mapa basado en el tracking importado; revisa su calibración' : 'sin tracking: no hay posiciones 2D'}`;
  pagesNote(); applyView(); render();
  status(S.data ? 'Tracking importado. Las estimaciones conservan su estado; la calidad depende de los datos.' : 'Video abierto. Para ver jugadores en 2D, importa tracking del mismo video.');
}
globalThis.fosPages = Object.freeze({open: pagesOpen});
const pagesDirectVideoChange = $('fileVideo').onchange;
$('fileVideo').onchange = event => {
  S.data = null; S.H = null; S.Hmap = null; S.match = null; S.slots = null; S.shown = null;
  S.continuitySession = null; S.continuityBundle = null; S.annotationSource = null; S.annotationRevision = null;
  S.shapes = []; S.units = []; S.names = {}; S.reds = []; S.fixes = {}; S.manual = []; S.lineIds = {0: [], 1: []};
  pagesRange = null; pagesDirectVideoChange(event); pagesNote();
};
globalThis.fosAnalyst.loadMatch = () => Promise.reject(new Error('Los partidos del PC no están publicados en esta web.'));
globalThis.fosAnalyst.loadResult = () => Promise.reject(new Error('Importa los archivos de tracking desde tu dispositivo.'));
pagesNote();
