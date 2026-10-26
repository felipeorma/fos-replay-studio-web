// Where a player is a moment after the video stops showing him, learned from the tracks of the platform's own videos (see tools/tracking/predict_core.py and train_prediction.py).
// The base is the plain model of prediction.js (he goes on as he was, his speed fading with a time constant of 1 s); the model learns the CORRECTION to it from what is seen in the frame where
// he was last seen: how his teammates and the rivals move, who is near, where the play flows, whether he was at the edge of what the shot shows. The correction is two forests of small trees
// (one for x, one for y) that were exported to JSON and are evaluated here, so nothing needs Python in the page.
// Everything is in the frame of the team (the pitch turned 180 degrees when it attacks to x = 0, so "forward" is +x), and it uses only what the page has stored of him up to that moment:
// the track the tracker saved (Kalman + RTS smoothed) cut where he stopped being seen. `features_from_stored` in predict_core.py is the reference this reproduces point by point.
// The constants of the base are the ones of prediction.js (a test checks they are equal; they are not imported to keep prediction.js -> prediction_ml.js a one way street).
export const TAU = 1.0, MAX_SPEED = 9;
const L = 105, W = 68, WINDOWS = [.3, .6, 1.2], MIN_SPAN = .4;
export const ML_FEATURES = ['h', 'xa', 'ya', 'vx', 'vy', 'speed', 'vx_s', 'vy_s', 'vx_l', 'vy_l', 'ax', 'ay', 'age', 'n_team', 'n_opp', 'team_vx', 'team_vy', 'opp_vx', 'opp_vy', 'flow_vx', 'flow_vy', 'cx', 'cy', 'tm_dx', 'tm_dy', 'tm_d', 'op_dx', 'op_dy', 'op_d', 'crowd10', 'edge_xmin', 'edge_xmax', 'edge_ymin', 'edge_ymax'];

/** The model JSON of train_prediction.py, checked: the same features in the same order and the same constants as the code here, or it is refused (null). */
export function mlModel(json) {
  if (!json || json.version !== 1 || !Array.isArray(json.outputs) || json.outputs.length !== 2) return null;
  if (json.features.length !== ML_FEATURES.length || json.features.some((f, i) => f !== ML_FEATURES[i])) return null;
  if (json.tau !== TAU || json.max_speed !== MAX_SPEED || json.min_span !== MIN_SPAN || json.windows.join() !== WINDOWS.join()) return null;
  return json;
}

/** The correction (dx, dy, metres, in the frame of the team) for a feature vector: base + the leaves of every tree, for x and for y. */
export function mlResidual(model, x) {
  return model.outputs.map(out => {
    let acc = out.base;
    for (const t of out.trees) { let n = 0; while (t.l[n] >= 0) n = x[t.f[n]] <= t.t[n] ? t.l[n] : t.r[n]; acc += t.v[n]; }
    return acc;
  });
}

/** The slope (m/s) of a track's x and y over the points of the last `win` seconds up to point `k` (a least squares line), or null when there are fewer than 3 or they cover too little. Same rule as `ls_at`. */
export function lsSlope(pts, k, win) {
  const t1 = pts[k].t; let lo = k; while (lo > 0 && pts[lo - 1].t >= t1 - win - 1e-9) lo--;
  const m = k - lo + 1; if (m < 3 || t1 - pts[lo].t < (win >= .6 ? MIN_SPAN : .65 * win)) return null;
  let mt = 0, mx = 0, my = 0; for (let j = lo; j <= k; j++) { mt += pts[j].t - t1; mx += pts[j].x; my += pts[j].y; } mt /= m; mx /= m; my /= m;
  let den = 0, sx = 0, sy = 0; for (let j = lo; j <= k; j++) { const d = pts[j].t - t1 - mt; den += d * d; sx += d * (pts[j].x - mx); sy += d * (pts[j].y - my); }
  return den > 1e-12 ? {vx: sx / den, vy: sy / den} : null;
}

const lastAtOrBefore = (pts, i) => { let lo = 0, hi = pts.length - 1; if (!pts.length || pts[0].i > i) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (pts[m].i <= i) lo = m; else hi = m - 1; } return pts[lo].i === i ? lo : -1; };

const WIN_SEC = 1.3;   // the longest window of the velocities (1.2 s) with a little to spare
/** The points a velocity is measured on, as a track and the index of its last point in the direction of time we look. Looking forward in time (a player who leaves) they are the points before `k`; looking
 *  backward (a player who enters: what was before his first sighting) they are the points AFTER `k`, taken in reverse order and with the time turned round, which is what the model of the entries was trained on. */
function windowAt(pts, k, back) {
  if (!back) return {arr: pts, k};
  let hi = k; while (hi < pts.length - 1 && pts[hi + 1].t <= pts[k].t + WIN_SEC) hi++;
  const arr = []; for (let j = hi; j >= k; j--) arr.push({...pts[j], t: -pts[j].t});
  return {arr, k: arr.length - 1};
}

/**
 * What is known at the moment he was last seen, as the vector of features of the model (with the horizon left at 0) and the pieces to put the answer back on the pitch, or null when there is not
 * enough of him (fewer than 3 points in 0,6 s). `tr` is `tracksOf(data)` (id -> points {i, t, x, y, team}), `pts` his points, `a` the index of the last one, `s` +1 when his team attacks
 * to the right and -1 to the left; `back` looks at the entry of a player (`a` is his FIRST point) instead of his exit.
 */
export function mlState(tr, data, id, pts, a, s, back = false) {
  const p = pts[a], own = windowAt(pts, a, back), v1 = lsSlope(own.arr, own.k, WINDOWS[1]); if (!v1) return null;
  const pick = win => lsSlope(own.arr, own.k, win) || v1, v0 = pick(WINDOWS[0]), v2 = pick(WINDOWS[2]);
  const rot = (x, y) => s > 0 ? [x, y] : [-x, -y], at = (x, y) => s > 0 ? [x, y] : [L - x, W - y];
  const [xa, ya] = at(p.x, p.y), [w1x, w1y] = rot(v1.vx, v1.vy), [w0x, w0y] = rot(v0.vx, v0.vy), [w2x, w2y] = rot(v2.vx, v2.vy);
  const mate = [], opp = [];
  for (const q of data.frames[p.i].p) {
    if (q.id === id) continue; const o = tr.get(q.id), k = o ? lastAtOrBefore(o, p.i) : -1, w = k >= 0 ? windowAt(o, k, back) : null, v = w ? lsSlope(w.arr, w.k, WINDOWS[1]) : null;
    const [x, y] = at(q.x, q.y), [vx, vy] = v ? rot(v.vx, v.vy) : [0, 0]; (q.team === p.team ? mate : opp).push({x, y, vx, vy});
  }
  const all = mate.concat(opp), mean = (list, k) => list.length ? list.reduce((acc, q) => acc + q[k], 0) / list.length : 0;
  const near = list => { let best = null, bd = Infinity; for (const q of list) { const d = Math.hypot(q.x - xa, q.y - ya); if (d < bd) { bd = d; best = q; } } return best ? [best.x - xa, best.y - ya, bd] : [0, 0, 60]; };
  const tm = near(mate), op = near(opp), edge = all.length ? [xa - Math.min(...all.map(q => q.x)), Math.max(...all.map(q => q.x)) - xa, ya - Math.min(...all.map(q => q.y)), Math.max(...all.map(q => q.y)) - ya] : [0, 0, 0, 0];
  const x = [0, xa, ya, w1x, w1y, Math.hypot(w1x, w1y), w0x, w0y, w2x, w2y, w0x - w2x, w0y - w2y, back ? pts[pts.length - 1].t - p.t : p.t - pts[0].t, mate.length, opp.length, mean(mate, 'vx'), mean(mate, 'vy'), mean(opp, 'vx'), mean(opp, 'vy'), mean(all, 'vx'), mean(all, 'vy'),
    mate.length ? mean(mate, 'x') - xa : 0, mate.length ? mean(mate, 'y') - ya : 0, ...tm, ...op, all.filter(q => Math.hypot(q.x - xa, q.y - ya) < 10).length, ...edge];
  return {x, xa, ya, vx: w1x, vy: w1y, s};
}

/** Where he is `h` seconds after he was last seen, on the pitch ({x, y}): the base (his speed fading) plus the learned correction, turned back from the frame of the team. */
export function mlAt(model, st, h) {
  const x = st.x.slice(); x[0] = h; const [dx, dy] = mlResidual(model, x);
  let vx = st.vx, vy = st.vy; const sp = Math.hypot(vx, vy); if (sp > MAX_SPEED) { vx *= MAX_SPEED / sp; vy *= MAX_SPEED / sp; }
  const run = TAU * (1 - Math.exp(-h / TAU)), px = st.xa + vx * run + dx, py = st.ya + vy * run + dy;
  return st.s > 0 ? {x: px, y: py} : {x: L - px, y: W - py};
}
