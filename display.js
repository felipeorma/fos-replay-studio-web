// What the 2D pitch draws while a video plays must not blink. A tracker that loses a player for a frame or two (in a wide shot that happens about a third of the time a player is on screen)
// makes his circle vanish and come back, and the colours of the space layer, the defensive line and the net jump with it. This gives every track a continuous line through its OWN sightings and
// says where he is at any time t (not only at the times of the data frames, which come 15 times a second while the video shows 30):
//  - between two sightings less than `gap` seconds apart: on the straight line between them (it is the same player, seen before and after);
//  - observed and briefly interpolated markers stay opaque; stale fading tails are disabled by default;
//  - anywhere else he is not there. A real hole (longer than `gap`) is NOT filled: that is what the prediction switch is for (hollow circles).
// The tracker also splits one player into several numbers (he goes behind somebody, or a swap is corrected): a track that ends and another of the SAME team that starts within `GAP` s and a few
// metres of where it ended are taken as one player, so his circle does not fade out and in, and whoever picks him for a line keeps him when his number changes. His `id` is then the number of
// the first piece (`key`) and `rid` the real number of the sighting.
// Display only: the numbers of the panels, the statistics and the exports use the frames as they are.

export const GAP = .5;      // s: a hole shorter than this inside one track is bridged
export const FADE = 0;      // no stale semitransparent copy after a detection ends
export const LINK_BASE = .5;  // m: how far from where a track ended the next of the same player may start, with no time between...
export const LINK_SPEED = 4;  // m/s: ...plus this much for every second between them (a player's own speed: half of them run slower than 1.4 m/s, 9 in 10 under 3.5). Chosen by cutting 117 real long tracks with holes of 0.2 to 0.4 s and joining them again: 99 to 100 % found their own other half and none was tied to another player (0.8 and 6 found the same, but joined 81 pieces in a real chunk instead of 55)

/** The tracks of `kind` made into chains: the pieces of one player (see above) joined, nearest first, each piece with at most one before and one after. */
export function stitch(tracks, gap = GAP, base = LINK_BASE, speed = LINK_SPEED) {
  const starts = tracks.map((tr, k) => ({k, t: tr.ts[0]})).sort((a, b) => a.t - b.t), pairs = [];
  tracks.forEach((a, ka) => {
    const te = a.ts[a.ts.length - 1], xe = a.xs[a.xs.length - 1], ye = a.ys[a.ys.length - 1];
    let lo = 0, hi = starts.length; while (lo < hi) { const m = (lo + hi) >> 1; if (starts[m].t <= te + 1e-9) lo = m + 1; else hi = m; }   // the first track that starts after this one ends
    for (let j = lo; j < starts.length && starts[j].t - te <= gap + 1e-9; j++) {
      const kb = starts[j].k, b = tracks[kb]; if (kb === ka || b.segment !== a.segment || b.ps[0].team !== a.ps[a.ps.length - 1].team) continue;
      if (a.ps[a.ps.length-1].identity_segment !== undefined || b.ps[0].identity_segment !== undefined) continue;
      const dt = b.ts[0] - te, d = Math.hypot(b.xs[0] - xe, b.ys[0] - ye), reach = base + speed * dt;
      if (d <= reach) pairs.push({ka, kb, cost: d / reach});
    }
  });
  const next = new Map(), prev = new Map();
  for (const q of pairs.sort((u, v) => u.cost - v.cost)) if (!next.has(q.ka) && !prev.has(q.kb)) { next.set(q.ka, q.kb); prev.set(q.kb, q.ka); }
  const chains = [];
  tracks.forEach((head, k) => {
    if (prev.has(k)) return;
    const c = {id: head.id, segment: head.segment, ts: [], xs: [], ys: [], ps: [], run: [], pieces: 0};
    for (let q = k; q !== undefined; q = next.get(q)) { const tr = tracks[q]; c.ts.push(...tr.ts); c.xs.push(...tr.xs); c.ys.push(...tr.ys); c.ps.push(...tr.ps); c.pieces++; }
    chains.push(c);
  });
  return chains;
}

/** {kind -> [track]} for `kind` 'p' (players of a team, pieces of a player joined) and 'o' (everybody else: referees, players with no team); a track is {id (of its first piece), ts, xs, ys, ps (the object of each sighting), run (index where its run starts)}. */
export function buildTracks(data, gap = GAP) {
  const out = {};
  const cuts = [...(data.cuts || [])].sort((a, b) => a - b);
  for (const kind of ['p', 'o']) {
    const by = new Map();
    for (const fr of data.frames) for (const q of fr[kind] || []) {
      const segment = cuts.filter(c => c <= fr.f).length, key = JSON.stringify([q.id, q.team, segment, q.identity_segment ?? null]);
      let tr = by.get(key); if (!tr) by.set(key, tr = {id: q.id, segment, ts: [], xs: [], ys: [], ps: [], run: []});
      tr.ts.push(fr.t); tr.xs.push(q.x); tr.ys.push(q.y); tr.ps.push(q);
    }
    const list = kind === 'p' ? stitch([...by.values()], gap) : [...by.values()];
    for (const tr of list) { let r = 0; tr.run = tr.ts.map((t, k) => { if (k && t - tr.ts[k - 1] > gap) r = k; return r; }); }
    out[kind] = list;
  }
  return out;
}

const cache = new WeakMap();
/** The tracks of `data`, built once (again when `rev` changes: a team was changed by hand and a player moved from `p` to `o`). */
export function tracksFor(data, rev = 0) {
  let c = cache.get(data); if (!c || c.rev !== rev) cache.set(data, c = {rev, tracks: buildTracks(data)});
  return c.tracks;
}

/** Everybody of `kind` that is on the pitch at time `t`: [{...sighting, x, y, alpha}]. `fade: 0` (a paused picture) draws nobody who was not seen in that very frame, apart from the bridged holes. */
export function at(tracks, t, {gap = GAP, fade = FADE} = {}) {
  const out = [];
  for (const tr of tracks) {
    const ts = tr.ts, n = ts.length;
    if (t < ts[0] - 1e-9 || t > ts[n - 1] + fade + 1e-9) continue;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ts[m] <= t + 1e-9) lo = m; else hi = m - 1; }
    const k = lo;
    let x, y, a = 1;
    if (k < n - 1 && ts[k + 1] - ts[k] <= gap) {
      const u = ts[k + 1] > ts[k] ? Math.min(1, Math.max(0, (t - ts[k]) / (ts[k + 1] - ts[k]))) : 0;
      x = tr.xs[k] + (tr.xs[k + 1] - tr.xs[k]) * u; y = tr.ys[k] + (tr.ys[k + 1] - tr.ys[k]) * u;
    } else {   // the last sighting of its run: he stays there while he fades
      const since = t - ts[k];
      if (since > 1e-9) { if (since > fade) continue; a = 1 - since / fade; }
      x = tr.xs[k]; y = tr.ys[k];
    }
    out.push({...tr.ps[k], id: tr.id, rid: tr.ps[k].id, x, y, alpha: a,
      displayState: Math.abs(t-ts[k]) < 1e-9 ? 'observed' : 'interpolated'});
  }
  return out;
}

/** The picture at time `t`, which falls near the data frame `i`: the players and the others as `at` says, and the ball on the line between its two sightings (when both frames have one: the tracker leaves it out when it does not know). */
export function displayAt(data, i, t, rev = 0, opts = {}) {
  const tr = tracksFor(data, rev);
  let base = data.frames[Math.min(Math.max(i, 0), data.frames.length - 1)];
  let f0 = base, f1 = data.frames[Math.min(i + 1, data.frames.length - 1)];
  if (f0.t > t && i > 0) { f1 = f0; f0 = data.frames[i - 1]; }
  // A nearest-frame lookup may return the next picture. Its observations,
  // hidden IDs and ball cannot become current before that picture starts.
  if (t >= f0.t) base = f0;
  let b = base.b;
  if (f0.b && f1 && f1 !== f0 && f1.b && t > f0.t && t < f1.t) {
    const dt = f1.t-f0.t, same = f0.b.trajectory_id === f1.b.trajectory_id;
    const cut = (data.cuts || []).some(c => f0.f < c && c <= f1.f);
    if (dt <= .25 && same && !cut && Math.hypot(f1.b.x-f0.b.x, f1.b.y-f0.b.y)/dt <= 55) {
      const u = (t-f0.t)/dt; b = {...f0.b, x:f0.b.x+(f1.b.x-f0.b.x)*u, y:f0.b.y+(f1.b.y-f0.b.y)*u};
    } else b = null;
  }
  let p = at(tr.p, t, opts), o = at(tr.o, t, opts);
  // A single sighting is still visible throughout its native video picture.
  // Hold only that picture, never a stale tail or a person from another cut.
  const pictureEnd = Math.min(f1 && f1 !== base ? f1.t : Infinity,
    base.t + 1 / (Number(data.fps) || 25));
  if (t >= base.t && t < pictureEnd) {
    for (const kind of ['p', 'o']) {
      const out = kind === 'p' ? p : o;
      for (const q of base[kind] || []) {
        const chain = tr[kind].find(track => track.ps.includes(q));
        if (!chain || out.some(point => point.id === chain.id && point.rid === q.id && point.team === q.team)) continue;
        out.push({...q, id: chain.id, rid: q.id, alpha: 1, displayState: 'observed'});
      }
    }
  }
  // Clip review may deliberately hide a particular ID in this frame.
  // Its neighbouring sightings must not recreate the rejected marker.
  const hidden = new Set(base.hidden_player_ids || []);
  p = p.filter(q => !hidden.has(String(q.rid ?? q.id)));
  o = o.filter(q => !hidden.has(String(q.rid ?? q.id)));
  const currentP = new Set(base.p.map(q => q.id)), currentO = new Set((base.o || []).map(q => q.id));
  p = p.filter(q => !currentO.has(q.rid) || currentP.has(q.rid));
  const visible = new Set(p.flatMap(q => [q.id, q.rid]));
  o = o.filter(q => !visible.has(q.id) && !currentP.has(q.rid));
  // Team-specific chains can overlap while one raw ID briefly changes kit.
  // Keep its current observation, or the last observed assignment between frames.
  const keys = keyMap(data, rev), canonical = id => keys.get(id) ?? id;
  const assignmentFrame = f0.t <= t + 1e-9 ? f0 : base;
  const assignments = new Map();
  for (const kind of ['p', 'o']) for (const q of assignmentFrame[kind] || []) assignments.set(canonical(q.id), {kind, team: q.team});
  const chosen = new Map();
  for (const kind of ['p', 'o']) for (const q of kind === 'p' ? p : o) {
    const id = canonical(q.id), assignment = assignments.get(id);
    const matches = assignment && assignment.kind === kind && (kind === 'o' || assignment.team === q.team);
    const score = (q.displayState === 'observed' ? 2 : 0) + (matches ? 1 : 0);
    const previous = chosen.get(id);
    if (!previous || score > previous.score) chosen.set(id, {kind, q, score});
  }
  p = [...chosen.values()].filter(q => q.kind === 'p').map(({q}) => {
    const assignment = assignments.get(canonical(q.id));
    return q.displayState !== 'observed' && assignment?.kind === 'p' ? {...q, team: assignment.team} : q;
  });
  o = [...chosen.values()].filter(q => q.kind === 'o').map(q => q.q);
  return {...base, t, p, o, b};
}

/** Future/previous raw IDs of a stitched player must not shadow a visible canonical ID. */
export function predictionsForDisplay(predictions, frame, keys = new Map()) {
  const canonical = id => keys.get(id) ?? id;
  const visible = new Set([...(frame.p || []), ...(frame.o || [])].flatMap(q => [canonical(q.id), canonical(q.rid ?? q.id)]));
  const used = new Set();
  return predictions.filter(q => {
    const id = canonical(q.id);
    if (visible.has(id) || used.has(id)) return false;
    used.add(id); return true;
  });
}

/** {real number of a sighting -> number of its player (the first piece)}: what the analyst named is named under the second one, and the statistics are by the first. */
export function keyMap(data, rev = 0) {
  const c = cache.get(data); if (c && c.rev === rev && c.keys) return c.keys;
  const keys = new Map(); for (const tr of tracksFor(data, rev).p) for (const q of tr.ps) keys.set(q.id, tr.id);
  cache.get(data).keys = keys; return keys;
}
