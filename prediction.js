// Where a player probably is when the video does not show him, from the tracks of that same video and nothing else (no other match, no dataset).
// Two uses: a hole in a track (he was behind someone, or the detector missed him for a moment) and the seconds after he leaves the picture. A player who was never seen
// in the video is not placed: there is nothing to predict him from.
// The model is the plain one: he keeps moving the way he was, slowing down (the speed of the last 0.6 s, decaying with a time constant of 1 s). How wrong it is gets measured on the
// tracks themselves (`evaluate`: hide the future of every track at every moment, predict it, compare with where he really went), and compared with "he stays where he was".
// Tried and not adopted: also moving a player with the average displacement of his visible teammates, and fitting the three parameters per video. On 4 real clips (half of the
// tracks to fit, the other half to score) the extra term helped in 1 and the fit did not beat the plain model in 3, so the plain one stays.

import {mlState, mlAt} from './prediction_ml.js';
export const TAU = 1.0;          // seconds: how fast a player's speed fades in the prediction
export const MAX_SPEED = 9;      // m/s: a faster estimate is tracker noise
const WINDOW = .6;               // s of track used to estimate the speed
const MIN_SPAN = .4;             // s the history has to cover

/** {id -> [{i (frame index), t, x, y, team}]} sorted by frame. */
export function tracksOf(data) {
  const tr = new Map();
  data.frames.forEach((fr, i) => { for (const p of fr.p) { if (!tr.has(p.id)) tr.set(p.id, []); tr.get(p.id).push({i, t: fr.t, x: p.x, y: p.y, team: p.team}); } });
  return tr;
}

/** The velocity {vx, vy} (m/s) of the track at its point `k`, a least squares line through the last 0.6 s, or null when there are fewer than 3 points or they cover under 0.4 s. `dir` -1 looks at the points after `k` instead (to predict backwards). */
export function velocityAt(pts, k, dir = 1) {
  const t0 = pts[k].t, h = pts.filter(p => dir > 0 ? p.t <= t0 && t0 - p.t <= WINDOW : p.t >= t0 && p.t - t0 <= WINDOW);
  if (h.length < 3 || Math.abs(h[h.length - 1].t - h[0].t) < MIN_SPAN) return null;
  const n = h.length, mt = h.reduce((s, p) => s + p.t, 0) / n, mx = h.reduce((s, p) => s + p.x, 0) / n, my = h.reduce((s, p) => s + p.y, 0) / n, den = h.reduce((s, p) => s + (p.t - mt) ** 2, 0);
  if (!den) return null;
  let vx = h.reduce((s, p) => s + (p.t - mt) * (p.x - mx), 0) / den, vy = h.reduce((s, p) => s + (p.t - mt) * (p.y - my), 0) / den;
  const sp = Math.hypot(vx, vy); if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; }
  return {vx, vy};
}

/** Where the player of `pts` is `h` seconds after (or before, with dir -1) his point `k`: his speed, fading. With no usable speed he stays. */
export function forecast(pts, k, h, dir = 1) {
  const p = pts[k], v = velocityAt(pts, k, dir), run = v ? TAU * (1 - Math.exp(-h / TAU)) : 0;
  return v ? {x: p.x + dir * v.vx * run, y: p.y + dir * v.vy * run} : {x: p.x, y: p.y};
}

/** Where the player of `pts` is at time `t` between his points `a` and `a + 1`: a cubic Hermite curve through both sightings with the speed he had when he left and the one he had when he came back (a straight line at the average speed where either is unknown). */
export function bridge(pts, a, t) {
  const p0 = pts[a], p1 = pts[a + 1], T = p1.t - p0.t, s = (t - p0.t) / T, avg = {vx: (p1.x - p0.x) / T, vy: (p1.y - p0.y) / T};
  // how much the speed at each end is believed (against the straight line between the two sightings) grows with the length of the hole: 0 up to 1 s, 0.25 at 2 s, 0.5 from 3 s. Measured on raw tracks with
  // holes hidden (tools/tracking/eval_holes.py): the speed at the ends comes from a fraction of a second of noisy points, and trusting it fully made a hole of 1 s twice as wrong as the straight line
  const w = Math.min(.5, Math.max(0, (T - 1) / 4)), shrink = e => e ? {vx: avg.vx + w * (e.vx - avg.vx), vy: avg.vy + w * (e.vy - avg.vy)} : avg, v0 = shrink(velocityAt(pts, a)), v1 = shrink(velocityAt(pts, a + 1, -1));
  const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
  return {x: h00 * p0.x + h10 * T * v0.vx + h01 * p1.x + h11 * T * v1.vx, y: h00 * p0.y + h10 * T * v0.vy + h01 * p1.y + h11 * T * v1.vy};
}

const quantile = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
/** The same for a hole: hide the points of every track between two sightings `gap` seconds apart and predict the one in the middle from the two ends. {gap, n, bridge: {median, p90}, line: {median, p90}} (a straight line between the ends, to compare with). */
export function evaluateHoles(data, gaps = [1, 2]) {
  const tr = tracksOf(data), dt = 1 / data.fps;
  return gaps.map(gap => {
    const br = [], ln = [];
    for (const pts of tr.values()) for (let a = 0; a < pts.length; a++) {
      const b = pts.findIndex(p => Math.abs(p.t - (pts[a].t + gap)) < dt * .6), mid = pts.find(p => Math.abs(p.t - (pts[a].t + gap / 2)) < dt * .6); if (b < 0 || !mid) continue;
      const kept = pts.filter(p => p.t <= pts[a].t || p.t >= pts[b].t), ia = kept.indexOf(pts[a]), m = bridge(kept, ia, mid.t), s = (mid.t - pts[a].t) / (pts[b].t - pts[a].t);
      br.push(Math.hypot(mid.x - m.x, mid.y - m.y)); ln.push(Math.hypot(mid.x - (pts[a].x + s * (pts[b].x - pts[a].x)), mid.y - (pts[a].y + s * (pts[b].y - pts[a].y))));
    }
    return {gap, n: br.length, bridge: {median: quantile(br, .5), p90: quantile(br, .9)}, line: {median: quantile(ln, .5), p90: quantile(ln, .9)}};
  });
}
/** How wrong the prediction is on this video's own tracks, per horizon in seconds: {h, n, model: {median, p90}, stay: {median, p90}} (metres). Only horizons where the player was really seen again count. */
export function evaluate(data, horizons = [.5, 1, 2]) {
  const tr = tracksOf(data), dt = 1 / data.fps, rows = horizons.map(h => ({h, model: [], stay: []}));
  for (const pts of tr.values()) for (let k = 0; k < pts.length; k++) {
    if (!velocityAt(pts, k)) continue;
    for (const row of rows) {
      const goal = pts.find(p => Math.abs(p.t - (pts[k].t + row.h)) < dt * .6); if (!goal) continue;
      const f = forecast(pts, k, row.h);
      row.model.push(Math.hypot(goal.x - f.x, goal.y - f.y)); row.stay.push(Math.hypot(goal.x - pts[k].x, goal.y - pts[k].y));
    }
  }
  return rows.map(r => ({h: r.h, n: r.model.length, model: {median: quantile(r.model, .5), p90: quantile(r.model, .9)}, stay: {median: quantile(r.stay, .5), p90: quantile(r.stay, .9)}}));
}

/**
 * The players the video does not show in each frame but that it has shown before (or after): {byFrame: Map(frame index -> [{id, team, x, y, h, kind}]), players, frames}.
 * `kind` is 'hueco' inside a hole of his track of up to `maxGap` s (a curve through the two sightings, `bridge`),
 * 'salida' after a sighting that is followed by a longer hole or by nothing (forward only, up to `maxAfter` s) and 'entrada' before the first sighting of a track or before the sighting that ends a longer hole (backward only,
 * up to `maxAfter` s). `h` is the seconds to the nearest real sighting: the farther, the less to trust (see `evaluate`).
 * Not predicted: the middle of a hole longer than `maxGap`, more than `maxAfter` seconds from a sighting, a player with fewer than 3 points, a spot off the pitch by over 3 m, a spot
 * within `clash` m of a player of his team already in that frame, an exit when a track of his team begins within `maxAfter` s and `link` m of where he would be (the tracker most
 * likely gave that same player a new number, so drawing both would double him), and any beyond
 * `perTeam` players of a team in a frame (the nearest sightings win). `perTeam` is 11, or a function (team, t) -> how many that team has at that moment (10 after a red card).
 */
export function complete(data, {maxGap = 3, maxAfter = 1.5, clash = 2, link = 2.5, perTeam = 11, ml = null} = {}) {
  const tr = tracksOf(data), mlStates = new Map(), L = data.L, W = data.W, margin = 3, cands = data.frames.map(() => []), starts = [...tr].map(([id, pts]) => ({id, ...pts[0]}));
  // a track that ends where another of the same team begins a moment later is most likely one player whose number changed: his exit is not predicted (it would trail the real one)
  const continued = (id, pts, a) => starts.some(b => b.id !== id && b.team === pts[0].team && b.t > pts[a].t && b.t <= pts[a].t + maxAfter && (() => { const f = forecast(pts, a, b.t - pts[a].t); return Math.hypot(f.x - b.x, f.y - b.y) <= link; })());
  // the same thing seen from the other side: a track that begins where another of the same team ended a moment before is most likely one player renumbered: his entry is not predicted either
  const ends = [...tr].map(([id, pts]) => ({id, pts, ...pts[pts.length - 1]}));
  const joined = (id, pts) => ends.some(e => e.id !== id && e.team === pts[0].team && pts[0].t > e.t && pts[0].t <= e.t + maxAfter && (() => { const f = forecast(e.pts, e.pts.length - 1, pts[0].t - e.t); return Math.hypot(f.x - pts[0].x, f.y - pts[0].y) <= link; })());
  const enter = (id, team, pts, k, before) => {   // where he was `before` seconds before his point k: the learned model of the entries (the same thing with the time turned round), made once for each time; the plain backward forecast where there is not enough of him
    if (ml && ml.back) { const key = `${id}:${k}:entrada`; if (!mlStates.has(key)) mlStates.set(key, mlState(tr, data, id, pts, k, ml.dirOf(team, pts[k].t), true)); const st = mlStates.get(key); if (st) return mlAt(ml.back, st, before); }
    return forecast(pts, k, before, -1);
  };
  for (const [id, pts] of tr) {
    if (pts.length < 3) continue;
    const present = new Set(pts.map(p => p.i)), team = pts[0].team;
    if (!joined(id, pts)) for (let i = pts[0].i - 1; i >= 0; i--) {   // before his first sighting: he came into the picture
      const before = pts[0].t - data.frames[i].t; if (before > maxAfter) break; if (before <= 0) continue;
      const f = enter(id, team, pts, 0, before); cands[i].push({id, team, x: f.x, y: f.y, h: before, kind: 'entrada'});
    }
    for (let a = 0; a < pts.length; a++) {
      const p0 = pts[a], next = pts[a + 1], stop = next ? next.i : data.frames.length;
      for (let i = p0.i + 1; i < stop; i++) {
        if (present.has(i)) continue;
        const t = data.frames[i].t;
        const after = t - p0.t, before = next ? next.t - t : Infinity;
        if (next && next.t - p0.t <= maxGap) {
          const b = bridge(pts, a, t); cands[i].push({id, team, x: b.x, y: b.y, h: Math.min(after, before), kind: 'hueco'});
        } else if (after <= maxAfter && after <= before) {
          if (continued(id, pts, a)) continue;
          let f = null;
          if (ml) {   // the learned correction (prediction_ml.js), made once for each time he leaves the picture; where there is not enough of him it is the plain model
            const key = `${id}:${a}`; if (!mlStates.has(key)) mlStates.set(key, mlState(tr, data, id, pts, a, ml.dirOf(team, pts[a].t)));
            const st = mlStates.get(key); if (st) f = mlAt(ml.model, st, after);
          }
          if (!f) f = forecast(pts, a, after);
          cands[i].push({id, team, x: f.x, y: f.y, h: after, kind: 'salida'});
        } else if (before <= maxAfter) {
          const f = enter(id, team, pts, a + 1, before); cands[i].push({id, team, x: f.x, y: f.y, h: before, kind: 'entrada'});
        }
      }
    }
  }
  const byFrame = new Map(), ids = new Set();
  cands.forEach((list, i) => {
    const kept = [], counts = [0, 0];
    for (const q of data.frames[i].p) counts[q.team] = (counts[q.team] || 0) + 1;
    for (const c of list.sort((a, b) => a.h - b.h)) {
      if (c.x < -margin || c.x > L + margin || c.y < -margin || c.y > W + margin || (counts[c.team] || 0) >= (typeof perTeam === 'function' ? perTeam(c.team, data.frames[i].t) : perTeam)) continue;
      if (data.frames[i].p.concat(kept).some(o => o.team === c.team && Math.hypot(o.x - c.x, o.y - c.y) < clash)) continue;
      kept.push(c); counts[c.team] = (counts[c.team] || 0) + 1; ids.add(c.id);
    }
    if (kept.length) byFrame.set(i, kept);
  });
  return {byFrame, players: ids.size, frames: byFrame.size, method: ml ? 'ml' : 'cinematica'};
}
