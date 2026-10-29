// FOS Analyst: the football logic of the analysis tool, with no DOM (it runs in the browser and in the tests).
// Everything works on tracking data in metres: the pitch is 105 x 68 m, the origin is the top-left corner, x runs along the pitch and y across it.
// Data: players and, when the source has it, the ball, frame by frame (the output of tools/tracking/track_players.py, or any other tracking data brought to the same shape).
//
//   normalize(raw)               -> {fps, L, W, frames: [{f, t, p: [{id, team, x, y, s?}], b: {x, y} | null}], hasBall, teams}
//   dominance(players, opts)     -> who gets to each point of the pitch first: a Voronoi diagram, or an Apollonius diagram when the weights are the speeds
//   detectPasses(data, opts)     -> possession by the nearest player to the ball, the passes between team-mates and the turnovers (each one a duel won or an interception)
//   coordinatesCsv(data, opts)   -> the x, y (metres) of every player and the ball in every frame, as a CSV the tracker's own CSV reader opens again
//   playerStats(data, opts)      -> what every player ran: distance, top speed, sprints and high-intensity running, in metres and km/h
//   passNetwork(data, passes, team, window) -> the nodes (average position, touches) and the edges (passes between two players)
//   defensiveLine(frame, team, opts)        -> the line of the defence (the last outfield player, the back four, or the players the analyst picked)
//   teamShape(frame, team)       -> centroid, width, depth and hull area
//   delaunay(points)             -> the triangulation that joins every player with its natural neighbours (no point inside the circle of another triangle)
//   teamNetwork(frame, team, opts) -> the net of a team: triangles, links with their length, and the pass options of the ball carrier
import {confirmBallFrames} from './ball-display.js';
export const PITCH = {L: 105, W: 68};

// ---------- data ----------
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
/** The data of the tracker (JSON `{fps, pitch, frames: [{frame, t, players: [{track_id, team, is_referee, x_m, y_m}], ball?}]}`), its CSV text, or data already normalized. */
export function normalize(raw, {fps: fpsOpt} = {}) {
  if (typeof raw === 'string') raw = raw.trim().startsWith('{') ? JSON.parse(raw) : fromCsv(raw, fpsOpt);
  if (raw.frames && raw.frames[0] && raw.frames[0].p) return withMeta(raw);   // already normalized
  const fps = num(raw.fps) || fpsOpt || 25, L = num(raw.pitch && raw.pitch[0]) || PITCH.L, W = num(raw.pitch && raw.pitch[1]) || PITCH.W;
  const frames = (raw.frames || []).map((fr, i) => {
    const p = [], o = [];   // o: whoever is on the pitch but is not a player of either team (the referee, a goalkeeper the tracker could not place, the bench): kept so the analyst can say who they are
    for (const q of fr.players || []) {
      const x = num(q.x_m ?? q.x), y = num(q.y_m ?? q.y), team = num(q.team);
      if (q.source === 'predicho') continue;   // a prediction is not a sighting: it is made again from the real ones
      if (x === null || y === null) continue;
      const id = String(q.track_id ?? q.id);
      const role = q.role || q.rol || undefined;   // keep both role spellings and the original evidence for round-trip exports
      const metadata = Object.fromEntries(['source', 'state', 'estado', 'rol', 'source_track_id'].filter(k => Object.hasOwn(q, k)).map(k => [k, q[k]]));
      const identity = q.identity_segment !== undefined ? {identity_segment:String(q.identity_segment)} : {};
      const player = {id, x, y, ...identity, ...metadata, ...(role ? {role} : {})};
      if (q.is_referee === true || q.is_referee === 'True' || q.is_referee === 'true') { o.push({...player, team: team ?? -1, ref: true}); continue; }
      if (team === null || team < 0) { o.push({...player, team: team ?? -1, ref: false}); continue; }   // referees and players without a team are not part of the analysis
      p.push({...player, team});
    }
    const bx = fr.ball && num(fr.ball.x_m ?? fr.ball.x), by = fr.ball && num(fr.ball.y_m ?? fr.ball.y);
    const footprint = fr.camera_footprint_m;
    const validFootprint = Array.isArray(footprint) && footprint.length >= 3 && footprint.length <= 20 && footprint.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite) && q[0] >= 0 && q[0] <= L && q[1] >= 0 && q[1] <= W);
    return {f: num(fr.frame) ?? i, t: num(fr.t) ?? i / fps, p, o, b: fr.ball?.estado !== 'no_confirmado' && bx !== null && bx !== undefined && by !== null && by !== undefined ? {x: bx, y: by,
      ...(Number.isFinite(fr.ball.conf) ? {conf:fr.ball.conf} : {}),
      ...(fr.ball.trajectory_id !== undefined ? {trajectory_id:fr.ball.trajectory_id} : {}),
      ...(fr.ball.quality_checked ? {quality_checked:true} : {}),
      ...(fr.ball.estado === 'interpolado' ? {est: 'interpolado'} : {})} : null,
      ...(validFootprint ? {camera_footprint_m: footprint.map(q => [...q])} : {}),
      ...(Array.isArray(fr.hidden_player_ids) ? {hidden_player_ids:fr.hidden_player_ids.map(String)} : {})};   // only the footprint for this frame: never hold it across a missing calibration
  });
  // the real rate of the frames kept (a tracker that analyses one frame out of two writes half the frames of the video)
  const dts = frames.slice(1).map((f, i) => f.t - frames[i].t).filter(d => d > 0).sort((a, b) => a - b), eff = dts.length > 2 ? 1 / dts[dts.length >> 1] : fps;
  const cuts = Array.isArray(raw.cuts) ? raw.cuts.filter(Number.isFinite).sort((a,b)=>a-b) : [];
  return withMeta({fps: Number.isFinite(eff) && Math.abs(eff - fps) / fps > .05 ? +eff.toFixed(2) : fps, L, W, frames:confirmBallFrames(frames,cuts), cuts, source: raw.source || null, video: raw.video || null, start_s: raw.start_s || 0, teams: raw.teams, tracks: raw.tracks || null});
}
/** Says to which team a whole track belongs (0 or 1), or that it is nobody (-1): the player moves between `p` (the players of a team) and `o` (everyone else) in every frame where he is. Returns how many frames changed. */
export function assignTrack(data, id, team) {
  let n = 0;
  for (const fr of data.frames) {
    const k = fr.p.findIndex(q => q.id === id);
    if (team >= 0) {
      if (k >= 0) { if (fr.p[k].team !== team) { fr.p[k].team = team; n++; } continue; }
      const j = (fr.o || []).findIndex(q => q.id === id && !q.ref);
      if (j >= 0) { const [q] = fr.o.splice(j, 1), {ref, ...player} = q; fr.p.push({...player, team}); n++; }
    } else if (k >= 0) { const [q] = fr.p.splice(k, 1); (fr.o || (fr.o = [])).push({...q, team: -1, ref: false}); n++; }
  }
  return n;
}
/** The colour of the shirts that the tracker estimates is a guess (a small player is mostly grass): it is used only when it can be seen over a pitch, never a green or a very dark one. */
export function usableColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return false;
  const n = parseInt(m[1], 16), r = (n >> 16) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d < .08) return l > .55;   // a grey is a white shirt only if it is light
  const h = ((mx === r ? (g - b) / d % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360, s = d / (1 - Math.abs(2 * l - 1));
  return !(h >= 60 && h <= 180 && s > .15) && l > .18 && l < .9;
}
function withMeta(d) {
  d.L = d.L || PITCH.L; d.W = d.W || PITCH.W; d.fps = d.fps || 25;
  d.hasBall = d.frames.some(f => f.b);
  d.teams = d.teams || {};
  [[0, 'Equipo A', '#3f8fd2'], [1, 'Equipo B', '#e8780f']].forEach(([k, name, color]) => { d.teams[k] = {name, color, ...(d.teams[k] || {})}; if (!usableColor(d.teams[k].color)) d.teams[k].color = color; });   // a source may bring only the colours
  return d;
}
/** CSV with a header: frame, t, track_id, team, is_referee, x_m, y_m (the tracker's output); a row whose track_id is `ball` is the ball. */
export function fromCsv(text, fps = 25) {
  const lines = text.trim().split(/\r?\n/), head = lines.shift().split(',').map(s => s.trim()), at = k => head.indexOf(k);
  const iF = at('frame'), iT = at('t'), iId = at('track_id'), iTeam = at('team'), iRef = at('is_referee'), iX = at('x_m'), iY = at('y_m'), iSrc = at('source'), iIdentity = at('identity_segment');
  const metadataColumns = ['source', 'state', 'estado', 'rol', 'role', 'source_track_id'].map(key => [key, at(key)]);
  if ([iF, iId, iX, iY].some(i => i < 0)) throw new Error('el CSV necesita las columnas frame, track_id, x_m, y_m');
  const byFrame = new Map();
  for (const line of lines) {
    const c = line.split(','), f = Number(c[iF]);
    if (iSrc >= 0 && c[iSrc] === 'predicho') continue;   // a prediction is not a sighting: it is made again from the real ones
    if (!byFrame.has(f)) byFrame.set(f, {frame: f, t: iT >= 0 ? Number(c[iT]) : f / fps, players: [], ball: null});
    const fr = byFrame.get(f), x = Number(c[iX]), y = Number(c[iY]);
    if (c[iId] === 'ball') fr.ball = {x_m: x, y_m: y, ...(iSrc >= 0 && c[iSrc] ? {estado: c[iSrc]} : {})};
    else fr.players.push({track_id: c[iId], team: iTeam >= 0 ? Number(c[iTeam]) : 0, is_referee: iRef >= 0 ? c[iRef] : false, x_m: x, y_m: y,
      ...Object.fromEntries(metadataColumns.filter(([, index]) => index >= 0 && c[index]).map(([key, index]) => [key, c[index]])),
      ...(iIdentity >= 0 && c[iIdentity] ? {identity_segment:c[iIdentity]} : {})});
  }
  return {fps, pitch: [PITCH.L, PITCH.W], frames: [...byFrame.keys()].sort((a, b) => a - b).map(k => byFrame.get(k))};
}
/**
 * The open sample data of Metrica Sports (two CSV files, Home and Away, with the ball in both): three header rows (the third one names the columns: Period, Frame, Time [s],
 * Player11, (y), Player1, (y), ..., Ball, (y)) and one row per frame with x, y of every player normalised to 0-1 (origin top-left). Only the part between `t0` and `t1` seconds is
 * read (a whole match is about 145,000 frames), one frame out of `every`. Returns the tracker's JSON shape (the home team is team 0, the away team team 1).
 */
export function fromMetrica(homeText, awayText, {t0 = 0, t1 = Infinity, every = 1, fps = 25} = {}) {
  const frames = new Map();
  const readFile = (text, team) => {
    if (!text) return;
    let pos = 0; const next = () => { if (pos >= text.length) return null; let e = text.indexOf('\n', pos); if (e < 0) e = text.length; const line = text.slice(pos, e).replace(/\r$/, ''); pos = e + 1; return line; };
    next(); next(); const head = (next() || '').split(',');   // the third row names the columns
    const cols = []; let ball = -1;
    head.forEach((h, i) => { if (/^Player/i.test(h.trim())) cols.push({id: `${team ? 'A' : 'H'}${h.trim().replace(/^Player/i, '')}`, i}); else if (/^Ball/i.test(h.trim())) ball = i; });
    if (!cols.length) throw new Error('no encuentro las columnas Player en el CSV de Metrica');
    let n = 0, line;
    while ((line = next()) !== null) {
      if (!line) continue; const c = line.split(','), f = Number(c[1]), t = Number(c[2]);
      if (!Number.isFinite(t)) continue; if (t < t0) continue; if (t > t1) break;
      if ((n++) % every) continue;
      if (!frames.has(f)) frames.set(f, {frame: f, t, players: [], ball: null});
      const fr = frames.get(f);
      for (const col of cols) { const x = parseFloat(c[col.i]), y = parseFloat(c[col.i + 1]); if (Number.isFinite(x) && Number.isFinite(y)) fr.players.push({track_id: col.id, team, is_referee: false, x_m: x * PITCH.L, y_m: y * PITCH.W}); }
      if (ball >= 0 && !fr.ball) { const x = parseFloat(c[ball]), y = parseFloat(c[ball + 1]); if (Number.isFinite(x) && Number.isFinite(y)) fr.ball = {x_m: x * PITCH.L, y_m: y * PITCH.W}; }
    }
  };
  readFile(homeText, 0); readFile(awayText, 1);
  if (!frames.size) throw new Error('no hay cuadros en ese rango de tiempo');
  return {fps, pitch: [PITCH.L, PITCH.W], source: 'metrica', teams: {0: {name: 'Local', color: '#3f8fd2'}, 1: {name: 'Visita', color: '#e8780f'}}, frames: [...frames.values()].sort((a, b) => a.frame - b.frame)};
}
/** The speed of every player (m/s), from the positions k frames before and after (the tracks come with id switches and gaps: only the frames of the same id count). */
export function withSpeeds(data, k = 3) {
  const track = new Map();   // id -> [{i, x, y}]
  data.frames.forEach((fr, i) => fr.p.forEach(q => { if (!track.has(q.id)) track.set(q.id, []); track.get(q.id).push({i, x: q.x, y: q.y, q}); }));
  for (const list of track.values()) list.forEach((c, j) => {
    const a = list[Math.max(0, j - k)], b = list[Math.min(list.length - 1, j + k)], dt = data.frames[b.i].t - data.frames[a.i].t;
    c.q.s = dt > 0 && b.i - a.i <= 4 * k ? Math.min(12, Math.hypot(b.x - a.x, b.y - a.y) / dt) : 0;
  });
  return data;
}
/** The speed of the players of the last frame, from the frame `k` before (a live source cannot look ahead). */
export function lastSpeeds(data, k = 3) {
  const n = data.frames.length - 1, cur = data.frames[n], past = data.frames[Math.max(0, n - k)], dt = cur.t - past.t; if (dt <= 0) return;
  const was = new Map(past.p.map(q => [q.id, q])); for (const q of cur.p) { const o = was.get(q.id); q.s = o ? Math.min(12, Math.hypot(q.x - o.x, q.y - o.y) / dt) : 0; }
}
export const frameAt = (data, t) => {   // the frame of a moment (binary search on the times)
  const fr = data.frames; let lo = 0, hi = fr.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (fr[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo > 0 && Math.abs(fr[lo - 1].t - t) < Math.abs(fr[lo].t - t) ? lo - 1 : lo;
};
/** The last available source frame at a video time: never reveal a future frame before a camera cut. */
export const frameAtOrBefore = (data, t) => {
  const fr = data.frames;
  if (!fr.length || !Number.isFinite(t)) return -1;
  let lo = 0, hi = fr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (fr[mid].t <= t + 1e-9) lo = mid; else hi = mid - 1;
  }
  return lo;
};

// ---------- space: Voronoi and Apollonius ----------
/**
 * Who gets to every point first. Each cell of the grid goes to the player with the smallest distance / weight. With every weight equal it is a Voronoi diagram (the nearest
 * player); with the weights proportional to the speeds it is the Apollonius diagram (the region where each one arrives first, the "dominant region" of the football
 * papers), whose edges are circles. `gain` goes from 0 (Voronoi) up: weight = 1 + gain * min(speed, vmax) / vmax.
 */
export function dominance(players, {L = PITCH.L, W = PITCH.W, res = 1, gain = 0, vmax = 9} = {}) {
  const nx = Math.ceil(L / res), ny = Math.ceil(W / res), owner = new Int16Array(nx * ny).fill(-1), n = players.length;
  const margin = new Float32Array(nx * ny), near = new Float32Array(nx * ny);   // margin: how much nearer team 0 is than team 1 (m, negative where team 1 is nearer); near: the distance to the nearest player. They let the picture be drawn smooth instead of in cells.
  const area = {}, per = new Float64Array(n);
  if (!n) return {nx, ny, res, owner, area, per, players, margin, near};
  const w = players.map(q => 1 + gain * Math.min(q.s || 0, vmax) / vmax), cell = res * res, FAR = 99;
  for (let j = 0; j < ny; j++) {
    const y = (j + .5) * res;
    for (let i = 0; i < nx; i++) {
      const x = (i + .5) * res; let best = -1, bd = Infinity; const td = [Infinity, Infinity];
      for (let k = 0; k < n; k++) { const dx = x - players[k].x, dy = y - players[k].y, d = (dx * dx + dy * dy) / (w[k] * w[k]); if (d < bd) { bd = d; best = k; } if (players[k].team in td && d < td[players[k].team]) td[players[k].team] = d; }   // squared distance over squared weight
      owner[j * nx + i] = best; per[best] += cell; near[j * nx + i] = Math.sqrt(bd);
      margin[j * nx + i] = td[0] === Infinity ? -FAR : td[1] === Infinity ? FAR : Math.sqrt(td[1]) - Math.sqrt(td[0]);
    }
  }
  players.forEach((q, k) => { area[q.team] = (area[q.team] || 0) + per[k]; });
  return {nx, ny, res, owner, area, per, players, margin, near};
}
/** The line where the two teams meet: the segments {x1, y1, x2, y2} (metres) of the level 0 of `dom.margin`, found between the centres of the grid cells and placed by linear interpolation, so it is a smooth curve and not a staircase of cells. */
export function teamBorder(dom) {
  const {nx, ny, res, margin} = dom, out = [], v = (i, j) => margin[j * nx + i], X = i => (i + .5) * res, at = (a, b, ia, ja, ib, jb) => { const t = a / (a - b); return [X(ia) + t * (X(ib) - X(ia)), X(ja) + t * (X(jb) - X(ja))]; };
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = v(i, j), b = v(i + 1, j), c = v(i + 1, j + 1), d = v(i, j + 1), idx = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
    if (idx === 0 || idx === 15) continue;
    const top = () => at(a, b, i, j, i + 1, j), right = () => at(b, c, i + 1, j, i + 1, j + 1), bottom = () => at(d, c, i, j + 1, i + 1, j + 1), left = () => at(a, d, i, j, i, j + 1);
    const seg = (p, q) => out.push({x1: p[0], y1: p[1], x2: q[0], y2: q[1]}), mid = (a + b + c + d) / 4 > 0;
    switch (idx) {
      case 1: case 14: seg(left(), top()); break;
      case 2: case 13: seg(top(), right()); break;
      case 3: case 12: seg(left(), right()); break;
      case 4: case 11: seg(right(), bottom()); break;
      case 6: case 9: seg(top(), bottom()); break;
      case 7: case 8: seg(left(), bottom()); break;
      case 5: if (mid) { seg(left(), bottom()); seg(top(), right()); } else { seg(left(), top()); seg(right(), bottom()); } break;
      case 10: if (mid) { seg(left(), top()); seg(right(), bottom()); } else { seg(left(), bottom()); seg(top(), right()); } break;
    }
  }
  return out;
}
/** The share of the pitch each team controls, 0 to 1. */
export const control = dom => { const tot = Object.values(dom.area).reduce((a, b) => a + b, 0) || 1; return Object.fromEntries(Object.entries(dom.area).map(([k, v]) => [k, v / tot])); };

// ---------- possession, passes and the network ----------
/** The player who has the ball in every frame: the nearest within `R` m (he keeps it until another is nearer or the ball is more than `keep` m away). */
export const ballSpeeds = (data, k = 2) => data.frames.map((fr, i) => {   // m/s of the ball, from the frames k before and after
  const a = data.frames[Math.max(0, i - k)].b, b = data.frames[Math.min(data.frames.length - 1, i + k)].b, dt = data.frames[Math.min(data.frames.length - 1, i + k)].t - data.frames[Math.max(0, i - k)].t;
  return a && b && dt > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / dt : 0;
});
export function carriers(data, {R = 2.6, keep = 3.6, margin = .5, maxSpeed = 10} = {}) {
  const out = new Array(data.frames.length).fill(null), bs = ballSpeeds(data); let cur = null;
  data.frames.forEach((fr, i) => {
    if (!fr.b) { out[i] = null; cur = null; return; }
    if (bs[i] > maxSpeed) { out[i] = null; cur = null; return; }   // a ball flying faster than a player can run belongs to nobody: a rival it passes by does not take it
    let best = null, bd = Infinity, held = null;
    for (const q of fr.p) { const d = Math.hypot(q.x - fr.b.x, q.y - fr.b.y); if (d < bd) { bd = d; best = q; } if (cur && q.id === cur.id) held = d; }
    // a contested ball stays with whoever had it unless the other is clearly nearer (`margin` m): two players side by side do not swap the possession every frame
    if (cur && held !== null && held <= keep && best && best.id !== cur.id && bd + margin >= held) cur = fr.p.find(q => q.id === cur.id);
    else if (best && bd <= R) cur = best; else if (cur && held !== null && held <= keep) cur = fr.p.find(q => q.id === cur.id); else cur = null;
    out[i] = cur ? {id: cur.id, team: cur.team} : null;
  });
  return out;
}
/**
 * Possession segments, passes between team-mates and turnovers, from the ball. A pass is the ball going from one player to a team-mate within `maxGap` s and at least
 * `minDist` m; a turnover, the ball going to the other team: a duel won when the two players were within `duelR` m of each other as the new one took the ball (a tackle,
 * a challenge), an interception when they were farther apart (a pass cut, a loose ball won). Needs the ball in the data (it does not guess anything without it).
 */
export function detectPasses(data, {R, keep, margin, maxSpeed, minHold = .4, maxGap = 2.5, minDist = 3, duelR = 2.5} = {}) {   // minHold in seconds: a ball flying past a rival is not a possession of his
  if (!data.hasBall) return {segments: [], passes: [], turnovers: [], hasBall: false};
  const car = carriers(data, {R, keep, margin, maxSpeed}), segs = [];
  car.forEach((c, i) => {
    if (!c) return; const last = segs[segs.length - 1];
    if (last && last.id === c.id && i - last.f1 <= 4) last.f1 = i; else segs.push({id: c.id, team: c.team, f0: i, f1: i});   // short gaps (a missed detection) do not break a possession
  });
  const holds = segs.filter(s => data.frames[s.f1].t - data.frames[s.f0].t + 1 / data.fps >= minHold), passes = [], turnovers = [];
  for (let k = 1; k < holds.length; k++) {
    const a = holds[k - 1], b = holds[k]; if (a.id === b.id) continue;
    const t0 = data.frames[a.f1].t, t1 = data.frames[b.f0].t; if (t1 - t0 > maxGap) continue;
    const pa = data.frames[a.f1].b, pb = data.frames[b.f0].b, len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (a.team === b.team) { if (len >= minDist) passes.push({from: a.id, to: b.id, team: a.team, f0: a.f1, f1: b.f0, t0, t1, len, from_xy: [pa.x, pa.y], to_xy: [pb.x, pb.y]}); }
    else {
      const at = data.frames[b.f0].p, lost = at.find(q => q.id === a.id), won = at.find(q => q.id === b.id), gap = lost && won ? Math.hypot(lost.x - won.x, lost.y - won.y) : null;
      turnovers.push({from: a.id, to: b.id, team: a.team, won_by: b.team, f: b.f0, t: t1, gap, kind: gap !== null && gap <= duelR ? 'duelo' : 'intercepción'});
    }
  }
  return {segments: holds, passes, turnovers, hasBall: true};
}
/**
 * The pass network of a team between two moments: a node for every player (his average position in the window, how many times he touched the ball and passes made and
 * received) and an edge for every pair of players that passed to each other (how many, in each direction).
 */
export function passNetwork(data, passes, team, {t0 = 0, t1 = Infinity, minPasses = 1} = {}) {
  const inWin = passes.filter(p => p.team === team && p.t0 >= t0 && p.t1 <= t1), sum = new Map(), cnt = new Map();
  const touch = id => { if (!cnt.has(id)) cnt.set(id, {id, out: 0, in: 0}); return cnt.get(id); };
  const pair = new Map();
  for (const p of inWin) {
    touch(p.from).out++; touch(p.to).in++;
    const key = p.from < p.to ? `${p.from}|${p.to}` : `${p.to}|${p.from}`; if (!pair.has(key)) pair.set(key, {a: p.from < p.to ? p.from : p.to, b: p.from < p.to ? p.to : p.from, ab: 0, ba: 0, n: 0});
    const e = pair.get(key); if (p.from === e.a) e.ab++; else e.ba++; e.n++;
  }
  for (const fr of data.frames) { if (fr.t < t0 || fr.t > t1) continue; for (const q of fr.p) if (q.team === team && cnt.has(q.id)) { const s = sum.get(q.id) || {x: 0, y: 0, n: 0}; s.x += q.x; s.y += q.y; s.n++; sum.set(q.id, s); } }
  const nodes = [...cnt.values()].filter(c => sum.has(c.id)).map(c => { const s = sum.get(c.id); return {id: c.id, x: s.x / s.n, y: s.y / s.n, out: c.out, in: c.in, touches: c.out + c.in}; });
  const ids = new Set(nodes.map(n => n.id)), edges = [...pair.values()].filter(e => e.n >= minPasses && ids.has(e.a) && ids.has(e.b));
  const possible = nodes.length * (nodes.length - 1) / 2;
  return {nodes, edges, total: inWin.length, density: possible ? edges.length / possible : 0, strongest: edges.slice().sort((a, b) => b.n - a.n)[0] || null};
}
/** The same network from the passes the analyst tagged by hand (`{t, from, to, team}`), for the sources that have no ball. */
export const tagToPass = (t, from, to, team, fps = 25) => ({from: String(from), to: String(to), team, t0: t, t1: t, f0: Math.round(t * fps), f1: Math.round(t * fps), len: 0});

// ---------- the defensive line ----------
/** `dir` is +1 when the team attacks towards x = L (it defends the goal at x = 0), -1 the other way round. The depth of a player is his distance to his own goal line. */
export const depthOf = (x, dir, L = PITCH.L) => dir > 0 ? x : L - x;
/**
 * The line of the defence of `team` in a frame. method `last`: the deepest outfield player (the offside reference); `back4`: the mean depth of the deepest four; `selected`: the mean of
 * the players the analyst picked (the line follows them from frame to frame). The goalkeeper (the deepest player when he is far from the next one) is left out unless `includeGK`.
 */
export function defensiveLine(frame, team, {dir = 1, method = 'back4', ids = [], k = 4, includeGK = false, L = PITCH.L} = {}) {
  const mine = frame.p.filter(q => q.team === team).map(q => ({...q, d: depthOf(q.x, dir, L)})).sort((a, b) => a.d - b.d);
  if (!mine.length) return null;
  let pool = mine;
  if (!includeGK && mine.length > 1 && mine[0].d < 20 && mine[1].d - mine[0].d > 6) pool = mine.slice(1);   // the keeper stands alone near his goal line
  let pick;
  if (method === 'selected') pick = pool.filter(q => ids.includes(q.id)); else if (method === 'last') pick = pool.slice(0, 1); else pick = pool.slice(0, k);
  if (!pick.length) return null;
  const d = method === 'last' ? pick[0].d : pick.reduce((s, q) => s + q.d, 0) / pick.length;
  const ys = pick.map(q => q.y);
  return {team, dir, method, d, x: dir > 0 ? d : L - d, points: pick.map(q => ({id: q.id, x: q.x, y: q.y, d: q.d})), yMin: Math.min(...ys), yMax: Math.max(...ys), width: Math.max(...ys) - Math.min(...ys)};
}
/**
 * Which way team 0 attacks (+1 towards x = L, -1 towards x = 0), from where the two teams stand over a stretch of the video and not in one frame. In one frame the two average positions
 * are often 2 or 3 m apart and their order is noise: on a clip of 8 s the old rule (the team standing on the left attacks right, decided frame by frame) flipped 7 times, and the line of the
 * defence jumped to the other end of the team each time, so it looked as if it was measured from the other team. Every frame within `window` seconds of `t` where both teams show at
 * least `minPlayers` players says how far team 1 stands to the right of team 0 (difference of mean x). A defending team stands deeper than the attackers who press it, so team 0 standing left
 * means it attacks right. A separation under `strong` m is inside the noise of seeing only part of each team, so when some frames separate the teams by more than that, only those decide
 * (averaged, each weighted by the players it shows of the team with fewer); when none does, the average of all of them says, and it is not sure.
 * Returns {dir0, sep, n, sure}: `sep` the average separation in metres (team 1 minus team 0) of the frames that decided, `n` how many frames were seen, `sure` when frames decided with at least `minSep` m. Not sure: dir0 comes from the weak average (+1 with nothing at all) and the caller can keep what it knew.
 */
export function attackDirections(data, t, {window = 60, minPlayers = 2, minSep = 2, strong = 4} = {}) {
  const fr = data.frames; let w = 0, s = 0, n = 0, w2 = 0, s2 = 0;
  for (let i = frameAt(data, t - window); i < fr.length && fr[i].t <= t + window; i++) {
    let n0 = 0, n1 = 0, x0 = 0, x1 = 0;
    for (const q of fr[i].p) { if (q.team === 0) { n0++; x0 += q.x; } else if (q.team === 1) { n1++; x1 += q.x; } }
    if (n0 < minPlayers || n1 < minPlayers) continue;
    const k = Math.min(n0, n1), sep = x1 / n1 - x0 / n0; w += k; s += k * sep; n++;
    if (Math.abs(sep) >= strong) { w2 += k; s2 += k * sep; }
  }
  const sep = w2 ? s2 / w2 : w ? s / w : 0;
  return {dir0: sep >= 0 ? 1 : -1, sep, n, sure: w2 > 0 && Math.abs(sep) >= minSep};
}
/** The offside line against `team` attacking: the second-last defender of the other team, the goalkeeper counted. */
export function offsideLine(frame, defending, {dir = 1, L = PITCH.L} = {}) {
  const ds = frame.p.filter(q => q.team === defending).map(q => depthOf(q.x, dir, L)).sort((a, b) => a - b);
  return ds.length > 1 ? ds[1] : null;
}
/** The line of every frame, to draw the trail of the height of the defence over time. */
export const lineSeries = (data, team, opts) => data.frames.map(fr => { const l = defensiveLine(fr, team, opts); return l ? {t: fr.t, d: l.d, width: l.width} : null; });

// ---------- shape of a team ----------
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
export function hull(pts) {   // convex hull (monotone chain)
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y); if (p.length < 3) return p;
  const lo = [], up = [];
  for (const q of p) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length > 1 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
export const polygonArea = h => Math.abs(h.reduce((s, p, i) => { const q = h[(i + 1) % h.length]; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
export function teamShape(frame, team) {
  const pts = frame.p.filter(q => q.team === team); if (!pts.length) return null;
  const xs = pts.map(q => q.x), ys = pts.map(q => q.y), h = hull(pts);
  const cx = xs.reduce((a, b) => a + b, 0) / pts.length, cy = ys.reduce((a, b) => a + b, 0) / pts.length;
  return {n: pts.length, cx, cy, width: Math.max(...ys) - Math.min(...ys), depth: Math.max(...xs) - Math.min(...xs), hull: h, area: polygonArea(h), spread: pts.reduce((s, q) => s + Math.hypot(q.x - cx, q.y - cy), 0) / pts.length};
}
/** How many players a team has on the pitch at time `t`: `base` (11) minus the sent-off ones. `reds` is [{team, t}]: from `t` on, that team plays with one fewer. */
export const expectedPlayers = (reds, team, t, base = 11) => Math.max(0, base - (reds || []).filter(r => r.team === team && t >= r.t).length);
const stat = a => a.length ? {mean: a.reduce((s, v) => s + v, 0) / a.length, min: Math.min(...a), max: Math.max(...a)} : null;
/**
 * How compact, long and wide a team is, measured only in the frames where ALL its players are in the data (with fewer, the shape is the shape of whoever was seen, not of the team;
 * with more, some detection is a false one). `expected(t)` is how many that is at each moment (11, or 10 after a red card).
 * Returns {frames, complete, share, width, depth, area, spread} (each of the last four {mean, min, max} in metres or m²; `spread` is the mean distance of the players to the centre of the team,
 * the smaller the more compact) or null when there are no frames. `complete` 0 gives `null` in the four measures.
 */
export function teamProfile(data, team, expected = () => 11) {
  const w = [], d = [], a = [], sp = [];
  for (const fr of data.frames) {
    const n = fr.p.filter(q => q.team === team).length; if (!n || n !== expected(fr.t)) continue;
    const sh = teamShape(fr, team); w.push(sh.width); d.push(sh.depth); a.push(sh.area); sp.push(sh.spread);
  }
  if (!data.frames.length) return null;
  return {frames: data.frames.length, complete: w.length, share: w.length / data.frames.length, width: stat(w), depth: stat(d), area: stat(a), spread: stat(sp)};
}

// ---------- what every player ran ----------
/**
 * Physical load of every player over the data, in metres: distance covered, top speed (km/h), sprints (speed of at least `sprintSpeed` m/s, 25 km/h, for at least `minSprint` s),
 * and distance run at high intensity (`hiSpeed` m/s, 20 km/h, or more). The speed is the one over a `window` s stretch, not the jump between two frames, which would be all noise.
 * A step is not counted if the player was out of the data for more than `maxStepGap` s or the jump needs more than `vmax` m/s (a track that changed owner, not a man running).
 * Only as good as the calibration and the tracker: a pitch calibrated 2 m off still measures a run well, because the error changes slowly along the run.
 */
export function playerStats(data, {window = .5, sprintSpeed = 7, hiSpeed = 5.5, minSprint = 1, vmax = 12, maxStepGap = 1} = {}) {
  const tracks = new Map();
  for (const fr of data.frames) for (const q of fr.p) { if (!tracks.has(q.id)) tracks.set(q.id, {id: q.id, team: q.team, pts: []}); tracks.get(q.id).pts.push({t: fr.t, x: q.x, y: q.y}); }
  const out = [];
  for (const tr of tracks.values()) {
    const P = tr.pts; let dist = 0, secs = 0, hi = 0, top = 0, sprints = 0, run = null;
    // speed over a short window centred on each point
    const sp = P.map((c, j) => {
      let a = j, b = j; while (a > 0 && c.t - P[a - 1].t <= window / 2) a--; while (b < P.length - 1 && P[b + 1].t - c.t <= window / 2) b++;
      const dt = P[b].t - P[a].t; return dt >= window * .4 ? Math.min(vmax, Math.hypot(P[b].x - P[a].x, P[b].y - P[a].y) / dt) : null;
    });
    for (let j = 1; j < P.length; j++) {
      const dt = P[j].t - P[j - 1].t, d = Math.hypot(P[j].x - P[j - 1].x, P[j].y - P[j - 1].y);
      if (dt <= 0 || dt > maxStepGap || d / dt > vmax) { if (run && run.t1 - run.t0 >= minSprint) sprints++; run = null; continue; }
      dist += d; secs += dt; if (sp[j] !== null && sp[j] >= hiSpeed) hi += d;
      if (sp[j] !== null && sp[j] >= sprintSpeed) run = run ? {...run, t1: P[j].t} : {t0: P[j - 1].t, t1: P[j].t};
      else if (run) { if (run.t1 - run.t0 >= minSprint) sprints++; run = null; }
    }
    if (run && run.t1 - run.t0 >= minSprint) sprints++;
    for (const v of sp) if (v !== null && v > top) top = v;
    out.push({id: tr.id, team: tr.team, seconds: secs, distance: dist, avg: secs > 0 ? dist / secs : 0, top: top * 3.6, sprints, hi});
  }
  return out.sort((a, b) => b.distance - a.distance);
}

// ---------- the coordinates, out ----------
const csvText = v => String(v).replace(/[,\r\n"]/g, ' ');   // the tracker's CSV reader splits on commas: no commas, quotes or line breaks inside a value
/**
 * The x, y (metres: x along the pitch 0-105, y across 0-68) of every player, and the ball, in every frame: one row per player and frame (the ball has `track_id` = ball).
 * The columns are the tracker's (`frame,t,track_id,team,is_referee,x_m,y_m`), so FOS Analyst opens this file again, plus the speed in m/s (over a short window, as in the stats),
 * the team's name and where the position comes from (`detectado`: measured in the video, not guessed). `frame` is the number of the frame in the whole video when the data came from a video.
 */
export function coordinatesCsv(data, {teamName = k => `Equipo ${k ? 'B' : 'A'}`, decimals = 2, predicted = null} = {}) {
  const extra = ['state', 'estado', 'rol', 'role', 'source_track_id'];
  const f = v => Number.isFinite(v) ? v.toFixed(decimals) : '', rows = ['frame,t,track_id,team,is_referee,x_m,y_m,speed_m_s,team_name,source,horizon_s,identity_segment,' + extra.join(',')];
  data.frames.forEach((fr, i) => {
    for (const q of [...fr.p, ...(fr.o || [])]) {
      const source = q.source ?? (q.state !== undefined || q.estado !== undefined ? '' : 'detectado');
      rows.push([fr.f, fr.t.toFixed(3), csvText(q.id), q.team ?? -1, q.ref ? 'True' : 'False', f(q.x), f(q.y), q.s === undefined ? '' : f(q.s), q.team >= 0 ? csvText(teamName(q.team)) : '', csvText(source), '', csvText(q.identity_segment ?? ''), ...extra.map(k => csvText(q[k] ?? ''))].join(','));
    }
    if (fr.b) rows.push([fr.f, fr.t.toFixed(3), 'ball', -1, 'False', f(fr.b.x), f(fr.b.y), '', '', fr.b.est || 'detectado', '', '', ...extra.map(() => '')].join(','));
    // players the video did not show but that a prediction places (prediction.js); `horizon_s` is how far in time the nearest real sighting of him is
    for (const q of (predicted && predicted.get(i)) || []) rows.push([fr.f, fr.t.toFixed(3), csvText(q.id), q.team, 'False', f(q.x), f(q.y), '', csvText(teamName(q.team)), 'predicho', q.h.toFixed(2), '', ...extra.map(() => '')].join(','));
  });
  return rows.join('\n') + '\n';
}

// ---------- the net of a team: every player joined to his natural neighbours ----------
/** Delaunay triangulation: the triangles such that no other point lies inside their circumcircle, which is the net of "who is next to whom".
 *  A team has 11 players, so every triple is tested directly (exact, and with no helper triangle to leave a thin triangle out of the hull). The points are moved
 *  by a hair (about a millionth of the pitch) so that players on a perfect grid or circle, which have more than one valid triangulation, get one that does not overlap.
 *  `pts` are {x, y}; returns {triangles: [[i, j, k], ...] (indices into pts), edges: [[i, j], ...]}. Fewer than 3 points, or all on a line, give no triangles. */
export function delaunay(pts) {
  const n = pts.length;
  if (n < 3) return {triangles: [], edges: n === 2 ? [[0, 1]] : []};
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y), span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const hash = i => { const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453; return v - Math.floor(v) - .5; };
  const X = xs.map((x, i) => x + hash(i) * span * 2e-6), Y = ys.map((y, i) => y + hash(i + 101) * span * 2e-6);
  const triangles = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    if (Math.abs((xs[j] - xs[i]) * (ys[k] - ys[i]) - (ys[j] - ys[i]) * (xs[k] - xs[i])) < span * span * 1e-9) continue;   // three players in a line (judged on the real positions, not the nudged ones)
    const o = (X[j] - X[i]) * (Y[k] - Y[i]) - (Y[j] - Y[i]) * (X[k] - X[i]);
    let empty = true;
    for (let q = 0; q < n && empty; q++) {
      if (q === i || q === j || q === k) continue;
      const ax = X[i] - X[q], ay = Y[i] - Y[q], bx = X[j] - X[q], by = Y[j] - Y[q], cx = X[k] - X[q], cy = Y[k] - Y[q];
      const det = (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
      if ((o > 0 ? det : -det) > 0) empty = false;   // q is inside the circle
    }
    if (empty) triangles.push([i, j, k]);
  }
  const seen = new Set(), edges = [];
  for (const [a, b, c] of triangles) for (const [u, v] of [[a, b], [b, c], [a, c]]) { const key = `${u},${v}`; if (!seen.has(key)) { seen.add(key); edges.push([u, v]); } }
  return {triangles, edges};
}
const triArea = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
/** The net of a team in a frame: a Delaunay triangulation of its players, without the links longer than `maxEdge` metres (nobody passes the ball 50 m to a neighbour
 *  across the pitch) and the triangles that need one of them. `carrier`: the player nearest the ball when he is within `carrierR` m, and his links are the pass options. */
export function teamNetwork(frame, team, {maxEdge = 35, carrierR = 3} = {}) {
  const pl = frame.p.filter(q => q.team === team); if (pl.length < 2) return null;
  const {triangles, edges} = delaunay(pl);
  const len = (a, b) => Math.hypot(pl[a].x - pl[b].x, pl[a].y - pl[b].y);
  let carrier = null;
  if (frame.b) { let best = carrierR; for (const q of pl) { const dd = Math.hypot(q.x - frame.b.x, q.y - frame.b.y); if (dd < best) { best = dd; carrier = q.id; } } }
  const links = edges.map(([a, b]) => ({a: pl[a].id, b: pl[b].id, len: len(a, b)})).filter(e => e.len <= maxEdge);
  for (const e of links) e.carrier = carrier !== null && (e.a === carrier || e.b === carrier);
  const tris = triangles.filter(([a, b, c]) => len(a, b) <= maxEdge && len(b, c) <= maxEdge && len(c, a) <= maxEdge).map(([a, b, c]) => ({a: pl[a].id, b: pl[b].id, c: pl[c].id, area: triArea(pl[a], pl[b], pl[c])}));
  const degree = {}; for (const q of pl) degree[q.id] = 0; for (const e of links) { degree[e.a]++; degree[e.b]++; }
  const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  return {n: pl.length, nodes: pl.map(q => ({id: q.id, x: q.x, y: q.y})), links, triangles: tris, carrier, degree, meanLen: mean(links.map(e => e.len)), meanArea: mean(tris.map(t => t.area)), maxEdge};
}

// ---------- the camera: where a point of the pitch falls in the video ----------
/** 3x3 matrix (image px -> metres, as the tracker writes it) -> the inverse, to project metres into the picture. */
export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m.flat(), A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g, det = a * A + b * B + c * Cc;
  if (Math.abs(det) < 1e-12) return null;
  return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [Cc / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
}
export function project(H, x, y) { const w = H[2][0] * x + H[2][1] * y + H[2][2]; return w ? {x: (H[0][0] * x + H[0][1] * y + H[0][2]) / w, y: (H[1][0] * x + H[1][1] * y + H[1][2]) / w} : null; }
/** A pitch point as the camera sees it, in homogeneous image coordinates {x, y, w} (the pixel is x/w, y/w). `inv` is pitch -> image; `side` (+1 or -1) is the sign of w for points in front of the camera. Only w > 0 is in front: a point behind the camera has no pixel, and dividing anyway puts it mirrored on the wrong side of the picture. */
export function hom(inv, x, y, side = 1) { return {x: side * (inv[0][0] * x + inv[0][1] * y + inv[0][2]), y: side * (inv[1][0] * x + inv[1][1] * y + inv[1][2]), w: side * (inv[2][0] * x + inv[2][1] * y + inv[2][2])}; }
/** The part of a straight pitch segment a -> b ({x, y, w} as from `hom`) that is in front of the camera (w >= eps), as [x1, y1, x2, y2] in pixels, or null when none of it is. A straight line stays straight through the camera, so cutting where w reaches eps is exact: the old way (draw to the pixel of every endpoint) joined a point in front with one behind through the whole picture. */
export function clipToFront(a, b, eps) {
  if (a.w < eps && b.w < eps) return null;
  const cut = (bad, good) => { const t = (eps - bad.w) / (good.w - bad.w); return {x: bad.x + t * (good.x - bad.x), y: bad.y + t * (good.y - bad.y), w: eps}; };
  if (a.w < eps) a = cut(a, b); else if (b.w < eps) b = cut(b, a);
  return [a.x / a.w, a.y / a.w, b.x / b.w, b.y / b.w];
}
/** A homography (3x3) from four or more pairs of points, `src` -> `dst` (the least squares solution when there are more than four): for the calibration the analyst clicks on the picture. */
export function homography(src, dst) {
  if (src.length < 4 || src.length !== dst.length) throw new Error('hacen falta al menos 4 pares de puntos');
  const A = [], b = [];
  src.forEach(([x, y], i) => { const [X, Y] = dst[i]; A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X); A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y); });
  // normal equations (A^T A) h = A^T b, solved by Gauss elimination with pivoting
  const n = 8, M = Array.from({length: n}, (_, r) => Array.from({length: n + 1}, (_, c) => c < n ? A.reduce((s, row) => s + row[r] * row[c], 0) : A.reduce((s, row, k) => s + row[r] * b[k], 0)));
  for (let c = 0; c < n; c++) {
    let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) throw new Error('los puntos no definen una homografía (¿alineados?)');
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const h = M.map((row, i) => row[n] / row[i]);
  return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
}

// ---------- the stretch of the video to analyse ----------
/** Seconds as the clock of the player: minutes (they can pass 60) and seconds, 4660 -> "77:40". The fraction is cut off. */
export const clockOf = s => { const t = Math.max(0, Math.floor(s + 1e-6)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
/** What someone types as a time -> seconds: "77:40", "1:17:40", "4660", "1:05,5"; NaN when it is not one (empty, letters, seconds or minutes of 60 or more after a colon). */
export const clockToS = text => {
  const t = String(text).trim().replace(',', '.'); if (!t) return NaN;
  const parts = t.split(':'); if (parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  const n = parts.map(Number); if (n.length > 1 && n[n.length - 1] >= 60) return NaN; if (n.length === 3 && n[1] >= 60) return NaN;
  return n.reduce((acc, v) => acc * 60 + v, 0);
};
