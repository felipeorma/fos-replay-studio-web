// Retrospective, explicitly reviewed reconstruction of SHORT broadcast cut gaps.
// A shirt feature is appearance evidence, not a player identity. No association is
// accepted automatically; IDs, ball, homographies and measured tracking stay intact.
import { forecast } from './prediction.js?v=18dd96d00d69cf23bdf77b9790eb50565ce54c8d205785ffd702f9bd0de500a0';

export const RECONSTRUCTION_VERSION = 1;
const MAX_GAP = 3, MAX_SPEED = 9, MAX_ACCELERATION = 6, HISTORY = .6;
const finite = value => value !== null && value !== '' && Number.isFinite(Number(value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const quantile = (values, q) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;
};

/** Same camera/identity-scoped key as the dashboard, using the OBSERVED ID. */
export function reconstructionKey(player, segment) {
  return JSON.stringify([segment, String(player.track_id ?? player.rid ?? player.id), player.identity_segment ?? null]);
}

function roleOf(player) {
  const role = player.rol || player.role || 'jugador';
  if (player.is_referee === true || String(player.is_referee).toLowerCase() === 'true' || player.ref || player.cls === 2) return 'arbitro';
  return role === 'goalkeeper' ? 'portero' : role === 'player' ? 'jugador' : role;
}

function measured(player) {
  if ([player.state, player.source, player.estado].some(value =>
    ['predicho', 'predicted', 'estimado', 'estimated', 'interpolado', 'interpolated', 'no_confirmado', 'hidden'].includes(String(value).toLowerCase()))) return false;
  const state = player.state ?? player.source ?? player.estado ?? 'detected';
  return ['detected', 'detectado', 'observed', 'measured'].includes(state);
}

function matrixValid(value) {
  return Array.isArray(value) && value.length === 3 && value.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite));
}

function qualityAt(raw, frame) {
  const report = (raw.camera_reports || []).find(row => {
    const start = row.start_frame ?? row.segment?.start_frame;
    const end = row.end_frame_inclusive ?? row.segment?.end_frame_inclusive;
    if (Number.isFinite(start) && Number.isFinite(end)) return frame.f >= start && frame.f <= end;
    return Number.isFinite(row.start) && Number.isFinite(row.duration) && frame.t >= row.start - 1e-9 && frame.t <= row.start + row.duration + 1e-9;
  });
  const quality = frame.camera_quality || report?.quality || raw.camera_quality || {};
  const level = String(typeof quality === 'string' ? quality : quality.level || 'desconocida').toLowerCase();
  const bad = ['mala', 'bad', 'invalid'].includes(level);
  const good = ['buena', 'good'].includes(level);
  // Policy scales, NOT confidence intervals or calibrated probabilities. Internal
  // holdout error is retained as context, never presented as stadium accuracy.
  return { level, bad, baseline_m: good ? 1 : /débil|debil|weak|aproxim/.test(level) ? 3 : 4,
    internal_p90_m: Number.isFinite(quality.p90_m) ? quality.p90_m : null };
}

function framesOf(raw, options) {
  const cuts = [...new Set((raw.cuts || []).filter(Number.isFinite))].sort((a, b) => a - b);
  const excluded = new Set(Object.keys(raw.player_review?.excluded_tracks || raw.team_overrides?.excluded_tracks || {}));
  const fps = Number(raw.fps) || 25;
  return (raw.frames || []).map((original, i) => {
    const f = Number(original.frame ?? original.f ?? i), t = Number(original.t ?? f / fps);
    const segment = cuts.filter(cut => cut <= f).length;
    const hidden = new Set((original.hidden_player_ids || []).map(String));
    const players = [], identity_states = [];
    for (const player of original.players || [...(original.p || []), ...(original.o || [])]) {
      const id = String(player.track_id ?? player.rid ?? player.id);
      const source = String(player.source_track_id ?? id);
      const x = player.x_m ?? player.x, y = player.y_m ?? player.y;
      const key = reconstructionKey(player, segment);
      const manual = options.reviewedRoles?.[key];
      let team = finite(player.team) ? Number(player.team) : -1, role = roleOf(player);
      if (/^(team|goalkeeper)[01]$/.test(manual || '')) {
        team = Number(manual.at(-1)); role = manual.startsWith('goalkeeper') ? 'portero' : 'jugador';
      } else if (manual === 'referee') role = 'arbitro';
      else if (manual === 'unknown') { team = -1; role = 'dudoso'; }
      const identityEligible = !hidden.has(id) && !excluded.has(source)
        && finite(x) && finite(y) && [0, 1].includes(team) && ['jugador', 'portero'].includes(role);
      const eligible = measured(player) && identityEligible;
      // A short interpolated observation is not an identity change. It cannot
      // anchor reconstruction, but must not sever the next measured history.
      identity_states.push({id, token: JSON.stringify([key, team, role, player.identity_key ?? null]), eligible:identityEligible});
      if (!eligible) continue;
      players.push({ id, source_track_id: source, key, team, role, x: Number(x), y: Number(y),
        t, f, i, segment, identity_segment: player.identity_segment ?? null,
        identity_key: player.identity_key ?? null, kit_feature: player.kit_feature });
    }
    let calibrated, calibration_source;
    if (Object.hasOwn(original, 'camera_footprint_m')) {
      const footprint = original.camera_footprint_m;
      calibrated = Array.isArray(footprint) && footprint.length >= 3 && footprint.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      calibration_source = 'camera_footprint_m';
    } else if (options.homographies || raw.homographies) {
      calibrated = matrixValid((options.homographies || raw.homographies)[f]);
      calibration_source = 'homographies';
    } else if (Object.hasOwn(original, 'calibrated')) {
      calibrated = original.calibrated === true;
      calibration_source = 'calibrated_flag';
    } else {
      // Legacy data need visible, measured metric positions. No invented camera.
      calibrated = players.length > 0;
      calibration_source = 'metric_observations_inferred';
    }
    const frame = { f, t, i, segment, players, calibrated, calibration_source, identity_states,
      camera_quality: original.camera_quality,
      has_observations: (original.players || [...(original.p || []), ...(original.o || [])]).length > 0 };
    frame.quality = qualityAt(raw, frame);
    return frame;
  }).filter(frame => Number.isFinite(frame.f) && Number.isFinite(frame.t)).sort((a, b) => a.t - b.t || a.f - b.f);
}

/** Shared frame evidence: calibration validity, reviewed people and quality. */
export function reconstructionFrames(raw, options = {}) {
  return framesOf(raw, options);
}

/** Measured tracks separated by cut, identity, role/team changes and long loss. */
export function reconstructionTracks(raw, options = {}) {
  const frames = framesOf(raw, options), tracks = new Map(), latest = new Map(), identities = new Map();
  for (const frame of frames) {
    // Returning to an earlier label still begins a new identity history.
    for (const state of frame.identity_states) {
      const previous = identities.get(state.id);
      const changed = previous && (previous.token !== state.token || previous.eligible !== state.eligible);
      identities.set(state.id, {...state, epoch: (previous?.epoch || 0) + (changed ? 1 : 0)});
    }
    if (!frame.calibrated || frame.quality.bad) continue;
    for (const player of frame.players) {
      const base = JSON.stringify([player.key, player.team, player.role, player.identity_key, identities.get(player.id)?.epoch || 0]);
      const prior = latest.get(base);
      const run = prior && player.t - prior.lastT <= .24 + 1e-9 ? prior.run : (prior?.run ?? -1) + 1;
      const trackKey = `${base}:${run}`;
      if (!tracks.has(trackKey)) tracks.set(trackKey, []);
      const points = tracks.get(trackKey);
      if (!points.length || points.at(-1).t < player.t) points.push(player);
      latest.set(base, { run, lastT: player.t });
    }
  }
  return tracks;
}

function velocity(points, end) {
  const t = end === 'before' ? points.at(-1).t : points[0].t;
  const window = points.filter(p => end === 'before' ? p.t <= t && t - p.t <= HISTORY + 1e-9 : p.t >= t && p.t - t <= HISTORY + 1e-9);
  if (window.length < 3 || window.at(-1).t - window[0].t < .4 - 1e-9) return null;
  const n = window.length, mt = window.reduce((a, p) => a + p.t, 0) / n;
  const mx = window.reduce((a, p) => a + p.x, 0) / n, my = window.reduce((a, p) => a + p.y, 0) / n;
  const den = window.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  if (!den) return null;
  const vx = window.reduce((a, p) => a + (p.t - mt) * (p.x - mx), 0) / den;
  const vy = window.reduce((a, p) => a + (p.t - mt) * (p.y - my), 0) / den;
  if (![vx, vy].every(Number.isFinite)) return null;
  return { vx, vy, speed: Math.hypot(vx, vy), points: window.length, span_s: window.at(-1).t - window[0].t };
}

function meanKit(points, end) {
  const t = end === 'before' ? points.at(-1).t : points[0].t;
  const features = points.filter(p => Math.abs(p.t - t) <= HISTORY + 1e-9).map(p => p.kit_feature)
    .filter(v => Array.isArray(v) && v.length >= 3 && v.length <= 256 && v.every(Number.isFinite));
  if (!features.length || !features.every(v => v.length === features[0].length)) return null;
  return features[0].map((_, k) => features.reduce((sum, v) => sum + v[k], 0) / features.length);
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  const den = Math.hypot(...a) * Math.hypot(...b);
  return den > 0 ? a.reduce((sum, value, i) => sum + value * b[i], 0) / den : null;
}

function endpoints(tracks, frame, side, fps) {
  const tolerance = Math.max(.24, 3 / fps), found = new Map();
  for (const points of tracks.values()) {
    const p = side === 'before' ? points.at(-1) : points[0];
    const delta = side === 'before' ? frame.t - p.t : p.t - frame.t;
    if (p.segment !== frame.segment || delta < -1e-9 || delta > tolerance + 1e-9) continue;
    const endpoint = { key: p.key, id: p.id, source_track_id: p.source_track_id, team: p.team, role: p.role,
      x: p.x, y: p.y, t: p.t, f: p.f, identity_segment: p.identity_segment,
      velocity: velocity(points, side), kit_feature: meanKit(points, side), camera_quality: frame.quality.level };
    const prior = found.get(p.key);
    if (!prior || Math.abs(p.t - frame.t) < Math.abs(prior.endpoint.t - frame.t)) found.set(p.key, { endpoint, points });
  }
  return found;
}

// The display bridge must meet the measured endpoint velocities as well as
// positions. Shrinking these velocities toward the secant hides an instantaneous
// speed change at the cut, even when the interior acceleration looks small.
const curveCache = new WeakMap();
const norm = v => Math.hypot(v.x, v.y);
const polynomial = (coefficients, t) => coefficients.reduceRight((value, c) => value * t + c, 0);

// Real polynomial roots in a bounded interval. Recursive derivative partitioning
// handles repeated roots without the instability of a cubic closed formula.
function rootsBetween(coefficients, start, end) {
  const c = coefficients.slice();
  while (c.length > 1 && Math.abs(c.at(-1)) < 1e-14) c.pop();
  if (c.length <= 1) return [];
  if (c.length === 2) {
    const root = -c[0] / c[1];
    return root >= start && root <= end ? [root] : [];
  }
  const critical = rootsBetween(c.slice(1).map((v, i) => v * (i + 1)), start, end);
  const splits = [start, ...critical, end], found = [];
  const epsilon = 1e-11 * Math.max(1, ...c.map((v, i) => Math.abs(v) * Math.max(Math.abs(start), Math.abs(end), 1) ** i));
  const add = root => { if (!found.some(r => Math.abs(r - root) < 1e-9)) found.push(root); };
  for (const point of splits) if (Math.abs(polynomial(c, point)) <= epsilon) add(point);
  for (let i = 0; i + 1 < splits.length; i++) {
    let left = splits[i], right = splits[i + 1], fl = polynomial(c, left), fr = polynomial(c, right);
    if (fl * fr >= 0) continue;
    for (let k = 0; k < 60; k++) {
      const mid = (left + right) / 2, fm = polynomial(c, mid);
      if (fl * fm <= 0) { right = mid; fr = fm; } else { left = mid; fl = fm; }
    }
    add((left + right) / 2);
  }
  return found;
}

function hermiteMotion(a, b, L, W) {
  const T = b.t - a.t, v0 = {x: a.velocity.vx, y: a.velocity.vy}, v1 = {x: b.velocity.vx, y: b.velocity.vy};
  const c2 = {}, c3 = {};
  for (const axis of ['x', 'y']) {
    const d = b[axis] - a[axis];
    c2[axis] = 3 * d / T ** 2 - (2 * v0[axis] + v1[axis]) / T;
    c3[axis] = -2 * d / T ** 3 + (v0[axis] + v1[axis]) / T ** 2;
  }
  const point = h => ({x: a.x + v0.x * h + c2.x * h ** 2 + c3.x * h ** 3,
    y: a.y + v0.y * h + c2.y * h ** 2 + c3.y * h ** 3});
  const velocity = h => ({x: v0.x + 2 * c2.x * h + 3 * c3.x * h ** 2,
    y: v0.y + 2 * c2.y * h + 3 * c3.y * h ** 2});
  const B = {x: 2 * c2.x, y: 2 * c2.y}, C = {x: 3 * c3.x, y: 3 * c3.y};
  const criticalSpeed = rootsBetween([
    v0.x * B.x + v0.y * B.y,
    B.x ** 2 + B.y ** 2 + 2 * (v0.x * C.x + v0.y * C.y),
    3 * (B.x * C.x + B.y * C.y), 2 * (C.x ** 2 + C.y ** 2),
  ], 0, T);
  const maxSpeed = Math.max(...[0, T, ...criticalSpeed].map(h => norm(velocity(h))));
  // Acceleration is affine, so its norm reaches its maximum at an endpoint.
  const maxAcceleration = Math.max(norm(B), norm({x: B.x + 2 * C.x * T, y: B.y + 2 * C.y * T}));
  let outside = false;
  for (const [axis, limit] of [['x', L], ['y', W]]) {
    const extrema = [0, T, ...rootsBetween([v0[axis], B[axis], C[axis]], 0, T)];
    if (extrema.some(h => point(h)[axis] < -1e-9 || point(h)[axis] > limit + 1e-9)) outside = true;
  }
  return {algorithm: 'hermite_c1', point, velocity, maxSpeed, maxAcceleration, outside};
}

// Two constant-acceleration intervals give a C1 path with exact endpoint
// positions/velocities. Only the switch time is selected; no velocity is clipped
// or moved toward the secant. Acceleration may change at the switch (not C2).
function twoStageMotion(a, b, switchS, L, W) {
  const T = b.t - a.t, s = switchS, h = T - s, a0 = {}, a1 = {}, vm = {};
  for (const axis of ['x', 'y']) {
    const key = axis === 'x' ? 'vx' : 'vy', v0 = a.velocity[key], v1 = b.velocity[key];
    const remainder = b[axis] - a[axis] - v0 * T, dv = v1 - v0;
    a0[axis] = (2 * remainder - h * dv) / (s * T);
    a1[axis] = (dv - a0[axis] * s) / h;
    vm[axis] = v0 + a0[axis] * s;
  }
  const point = t => {
    const out = {};
    for (const axis of ['x', 'y']) {
      const v0 = a.velocity[axis === 'x' ? 'vx' : 'vy'];
      out[axis] = t <= s ? a[axis] + v0 * t + .5 * a0[axis] * t ** 2 :
        a[axis] + v0 * s + .5 * a0[axis] * s ** 2 + vm[axis] * (t - s) + .5 * a1[axis] * (t - s) ** 2;
    }
    return out;
  };
  const velocity = t => t <= s ? {x: a.velocity.vx + a0.x * t, y: a.velocity.vy + a0.y * t} :
    {x: vm.x + a1.x * (t - s), y: vm.y + a1.y * (t - s)};
  const maxSpeed = Math.max(a.velocity.speed, b.velocity.speed, norm(vm));
  const maxAcceleration = Math.max(norm(a0), norm(a1));
  let outside = false;
  for (const [axis, limit] of [['x', L], ['y', W]]) {
    const v0 = a.velocity[axis === 'x' ? 'vx' : 'vy'];
    const extrema = [0, s, T];
    if (Math.abs(a0[axis]) > 1e-12) { const t = -v0 / a0[axis]; if (t > 0 && t < s) extrema.push(t); }
    if (Math.abs(a1[axis]) > 1e-12) { const t = s - vm[axis] / a1[axis]; if (t > s && t < T) extrema.push(t); }
    if (extrema.some(t => point(t)[axis] < -1e-9 || point(t)[axis] > limit + 1e-9)) outside = true;
  }
  return {algorithm: 'bounded_acceleration_c1', switch_s: s, point, velocity, maxSpeed, maxAcceleration, outside};
}

const motionReasons = motion => [
  ...(![motion.maxSpeed, motion.maxAcceleration].every(Number.isFinite) ? ['movimiento_no_finito'] : []),
  ...(motion.maxSpeed > MAX_SPEED + 1e-8 ? ['velocidad_del_puente_incompatible'] : []),
  ...(motion.maxAcceleration > MAX_ACCELERATION + 1e-8 ? ['aceleracion_del_puente_incompatible'] : []),
  ...(motion.outside ? ['fuera_de_cancha'] : []),
];

function bridgeMotion(a, b, L, W) {
  if (!a.velocity || !b.velocity) return {reasons: ['historia_de_movimiento_insuficiente'], algorithm: null};
  const T = b.t - a.t;
  if (!(T > 0 && T <= MAX_GAP + 1e-9) || ![a.x, a.y, b.x, b.y].every(Number.isFinite))
    return {reasons: ['horizonte_no_admitido'], algorithm: null};
  const hermite = hermiteMotion(a, b, L, W), initialReasons = motionReasons(hermite);
  if (!initialReasons.length) return {...hermite, reasons: [], fallback_reason: null};
  // Analytic stationary/balance times minimize the maximum of the two
  // acceleration norms. A bounded grid adds feasible alternatives when field
  // or speed limits constrain that optimum. Every accepted path is checked
  // analytically at its extrema, not just at rendered samples.
  const K = {}, c = {};
  for (const axis of ['x', 'y']) {
    const key = axis === 'x' ? 'vx' : 'vy';
    K[axis] = 2 * (b[axis] - a[axis]) / T - a.velocity[key] - b.velocity[key];
    c[axis] = (b.velocity[key] - a.velocity[key]) / T;
  }
  const kk = K.x ** 2 + K.y ** 2, ck = c.x * K.x + c.y * K.y;
  const switches = rootsBetween([kk * T, 2 * ck * T - 2 * kk, -2 * ck], 0, T);
  if (ck < 0) switches.push(-kk / ck);
  if (ck > 0) switches.push(T - kk / ck);
  for (let k = 1; k < 256; k++) switches.push(T * k / 256);
  let best = null, attempted = hermite;
  for (const s of switches) {
    if (!(s > T * 1e-6 && s < T * (1 - 1e-6))) continue;
    const candidate = twoStageMotion(a, b, s, L, W);
    if (candidate.maxAcceleration < attempted.maxAcceleration) attempted = candidate;
    if (motionReasons(candidate).length) continue;
    if (!best || candidate.maxAcceleration < best.maxAcceleration - 1e-9 ||
      Math.abs(candidate.maxAcceleration - best.maxAcceleration) <= 1e-9 && candidate.maxSpeed < best.maxSpeed) best = candidate;
  }
  if (best) return {...best, reasons: [], fallback_reason: initialReasons.join(', ')};
  return {...attempted, reasons: [...new Set([...motionReasons(attempted), 'puente_c1_no_factible'])],
    fallback_reason: initialReasons.join(', ')};
}

function curveOf(beforePoints, afterPoints, {L = 105, W = 68} = {}) {
  if (!beforePoints.length || !afterPoints.length) return {reasons: ['extremo_inexistente_o_excluido'], algorithm: null};
  const a = {...beforePoints.at(-1), velocity: velocity(beforePoints, 'before')},
    b = {...afterPoints[0], velocity: velocity(afterPoints, 'after')};
  const signature = JSON.stringify([a.t, a.x, a.y, b.t, b.x, b.y, a.velocity, b.velocity, L, W]);
  let pairs = curveCache.get(beforePoints);
  if (!pairs) curveCache.set(beforePoints, pairs = new WeakMap());
  const cached = pairs.get(afterPoints);
  if (cached?.signature === signature) return cached.motion;
  const motion = bridgeMotion(a, b, L, W);
  pairs.set(afterPoints, {signature, motion});
  return motion;
}

/** Pure C1 bridge; both endpoints need measured velocity histories of the same
 * identity. With no admissible path in these families, abstain rather than
 * changing tangents. This does not prove all possible physical paths impossible. */
export function reconstructBridge(beforePoints, afterPoints, t, options = {}) {
  if (!beforePoints.length || !afterPoints.length || !Number.isFinite(t)) return null;
  const p0 = beforePoints.at(-1), p1 = afterPoints[0];
  if (!(p1.t > p0.t) || t < p0.t || t > p1.t) return null;
  const motion = curveOf(beforePoints, afterPoints, options);
  if (motion.reasons.length) return null;
  const h = t - p0.t, p = motion.point(h), v = motion.velocity(h);
  return {...p, vx: v.x, vy: v.y};
}

/** Reproducible diagnostics of the interpolation model, never identity proof. */
export function reconstructionBridgeInfo(beforePoints, afterPoints, options = {}) {
  const motion = curveOf(beforePoints, afterPoints, options);
  return {algorithm: motion.algorithm, fallback_reason: motion.fallback_reason ?? null,
    switch_s: motion.switch_s ?? null, rejection_reasons: motion.reasons,
    max_speed_m_s: motion.maxSpeed ?? null, max_acceleration_m_s2: motion.maxAcceleration ?? null,
    endpoint_velocity_preserved: motion.reasons.length === 0,
    continuity: 'C1; la aceleración puede cambiar en el empalme interior'};
}

/** An explicitly reviewed smoothing window may absorb small calibration noise
 * around a cut. It never replaces observations in tracking.json. The complete
 * inferred curve is saved separately and deviations against ALL visible points
 * are bounded to1.5m; identity is still reviewed independently. */
function reviewedMotionWindow(a,b,L,W) {
  for(const window of [.4,.6]) {
    const before=a.points.filter(p=>p.t<=a.endpoint.t-window+1e-9);
    const after=b.points.filter(p=>p.t>=b.endpoint.t+window-1e-9);
    if(!before.length||!after.length)continue;
    const start=before.at(-1).t,end=after[0].t;
    if(end-start>MAX_GAP+1e-9)continue;
    const motion=curveOf(before,after,{L,W});
    if(motion.reasons.length)continue;
    let deviation=0;
    const visible=[...a.points,...b.points].filter(p=>p.t>=start&&p.t<=end);
    for(const p of visible)deviation=Math.max(deviation,distance(p,motion.point(p.t-start)));
    if(deviation>1.5+1e-9)continue;
    const n=Math.ceil((end-start)*60),samples=[];
    for(let k=0;k<=n;k++) {
      const t=start+(end-start)*k/n,p=motion.point(t-start),v=motion.velocity(t-start);
      samples.push({t,x:p.x,y:p.y,vx:v.x,vy:v.y});
    }
    return {start_s:start,end_s:end,samples,window_s:window,
      observed_before_s:a.endpoint.t,observed_after_s:b.endpoint.t,
      max_observation_deviation_m:deviation,observed_points_checked:visible.length,
      correction_limit_m:1.5,source:'reviewed_motion_window',
      algorithm:motion.algorithm,max_speed_m_s:motion.maxSpeed,
      max_acceleration_m_s2:motion.maxAcceleration,
      switch_s:motion.switch_s??null,fallback_reason:motion.fallback_reason??null,
      endpoint_velocity_preserved:true,outer_endpoints_exact:true,
      position_state:'smoothed_estimate_from_reviewed_detections'};
  }
  return null;
}

// Recompute from current measurements; never trust coordinates from a stale
// saved association. The opt-in review flag belongs to the caller's clip.
export function reviewedObservationWindow(before,after,{L=105,W=68}={}) {
  if(!before.length||!after.length)return null;
  return reviewedMotionWindow({points:before,endpoint:before.at(-1)},
    {points:after,endpoint:after[0]},L,W);
}
export function validatedMotionWindow(saved,before,after,{L=105,W=68}={}) {
  if(!saved||!before.length||!after.length)return null;
  const current=reviewedObservationWindow(before,after,{L,W});
  if(!current||saved.samples?.length!==current.samples.length)return null;
  for(const key of ['start_s','end_s','window_s'])if(Math.abs(saved[key]-current[key])>1e-8)return null;
  for(let i=0;i<current.samples.length;i++)for(const key of ['t','x','y','vx','vy'])
    if(!Number.isFinite(saved.samples[i][key])||Math.abs(saved.samples[i][key]-current.samples[i][key])>1e-8)return null;
  return current;
}

export function motionWindowAt(path,t) {
  const samples=path?.samples||[];
  if(!samples.length||t<path.start_s-1e-9||t>path.end_s+1e-9)return null;
  let lo=0,hi=samples.length-1;
  while(lo<hi){const m=(lo+hi+1)>>1;if(samples[m].t<=t)lo=m;else hi=m-1;}
  const a=samples[lo],b=samples[lo+1];if(!b)return {...a};
  const u=Math.max(0,Math.min(1,(t-a.t)/(b.t-a.t)));
  return {t,x:a.x+u*(b.x-a.x),y:a.y+u*(b.y-a.y),vx:a.vx+u*(b.vx-a.vx),vy:a.vy+u*(b.vy-a.vy)};
}

function geometry(a, b, L, W, calibrationBase) {
  const before = a.endpoint, after = b.endpoint, duration = after.t - before.t;
  const reasons = [];
  if (before.team !== after.team) reasons.push('equipos_distintos');
  if (before.role !== after.role) reasons.push('roles_distintos');
  if (!(duration > 0 && duration <= MAX_GAP + 1e-9)) reasons.push('horizonte_no_admitido');
  if (!before.velocity || !after.velocity) reasons.push('historia_de_movimiento_insuficiente');
  if (before.velocity?.speed > MAX_SPEED + 1e-9 || after.velocity?.speed > MAX_SPEED + 1e-9) reasons.push('velocidad_observada_incompatible');
  const averageSpeed = duration > 0 ? distance(before, after) / duration : Infinity;
  if (averageSpeed > MAX_SPEED + 1e-9) reasons.push('desplazamiento_incompatible');
  const appearance = cosine(before.kit_feature, after.kit_feature);
  if (appearance !== null && appearance < .65) reasons.push('apariencia_incompatible');
  const forward = forecast(a.points, a.points.length - 1, Math.max(0, duration));
  const backward = forecast(b.points, 0, Math.max(0, duration), -1);
  const forwardError = distance(forward, after), backwardError = distance(backward, before);
  if (Math.max(forwardError, backwardError) > Math.max(3, calibrationBase + 3 * duration)) reasons.push('movimiento_antes_despues_inconsistente');
  const motion = curveOf(a.points, b.points, {L, W});
  reasons.push(...motion.reasons.filter(reason => !reasons.includes(reason)));
  const motionError = (forwardError + backwardError) / 2;
  return { reasons, cost_m: motionError + (appearance === null ? 1 : Math.max(0, 1 - appearance) * 3),
    metrics: { average_speed_m_s: averageSpeed, forward_error_m: forwardError, backward_error_m: backwardError,
      max_speed_m_s: motion.maxSpeed ?? null, max_acceleration_m_s2: motion.maxAcceleration ?? null,
      bridge_algorithm: motion.algorithm, bridge_fallback_reason: motion.fallback_reason ?? null,
      bridge_switch_s: motion.switch_s ?? null, endpoint_velocity_preserved: !motion.reasons.length, kit_cosine: appearance,
      before_speed_m_s: before.velocity?.speed ?? null, after_speed_m_s: after.velocity?.speed ?? null } };
}

/** The production rejection policy, exposed for independent masked-gap tests. */
export function assessReconstructionBridge(beforePoints, afterPoints, {L = 105, W = 68, calibrationBase = 3} = {}) {
  if (!beforePoints.length || !afterPoints.length) return {reasons: ['extremo_inexistente_o_excluido']};
  const a = {...beforePoints.at(-1), team: beforePoints.at(-1).team ?? 0,
    role: beforePoints.at(-1).role || 'jugador', velocity: velocity(beforePoints, 'before'), kit_feature: meanKit(beforePoints, 'before')};
  const b = {...afterPoints[0], team: afterPoints[0].team ?? 0,
    role: afterPoints[0].role || 'jugador', velocity: velocity(afterPoints, 'after'), kit_feature: meanKit(afterPoints, 'after')};
  return geometry({endpoint:a, points:beforePoints}, {endpoint:b, points:afterPoints}, L, W, calibrationBase);
}

/** Build proposals and separately stored estimates. Only reviewed one-to-one links in
 * approved live-continuity gaps create estimates. No observation or ball is modified. */
export function buildReconstruction(raw, options = {}) {
  const maxGapS = Math.min(MAX_GAP, Math.max(.1, Number(options.maxGapS) || MAX_GAP));
  const fps = Number(raw.fps) || 25, frames = framesOf(raw, options), tracks = reconstructionTracks(raw, options);
  const cuts = (raw.cuts || []).filter(Number.isFinite), approved = new Set((options.approvedGaps || []).map(String));
  const requested = Array.isArray(options.associations) ? options.associations : [];
  const allowWindow=options.reviewedMotionWindow===true||raw.return_continuity_review?.reviewed_motion_window===true;
  const L = Number(raw.L ?? raw.pitch?.[0] ?? raw.pitch_m?.[0]) || 105;
  const W = Number(raw.W ?? raw.pitch?.[1] ?? raw.pitch_m?.[1]) || 68;
  const report = { version: RECONSTRUCTION_VERSION, method: 'puente_c1_retrospectivo_revisado', fps,
    options: { maxGapS, maxAfterS: Math.min(1, Math.max(0, Number(options.maxAfterS) || 1)),
      max_speed_m_s: MAX_SPEED, max_acceleration_m_s2: MAX_ACCELERATION,
      endpoint_velocity_preserved: true, bridge_continuity: 'C1', forward_tails: false,
      reviewed_motion_window:allowWindow,maximum_observed_position_correction_m:allowWindow?1.5:0 },
    limitations: ['Las asociaciones requieren revisión de identidad y continuidad en directo; una repetición no puede enlazarse.',
      'La incertidumbre es una escala heurística en metros, no una probabilidad ni un intervalo calibrado.',
      'Las coordenadas 2D dependen de calibración aproximada. No se reconstruyen balón, huella ni homografías.',
      'C1 conserva posición y velocidad estimada en los extremos; el modelo de dos tramos permite cambiar aceleración en su empalme.',
      'El rechazo C1 indica que estas familias no ofrecen un puente admisible; no prueba que todo movimiento físico sea imposible.',
      'Una ventana revisada puede suavizar hasta0.6s a cada lado; sus posiciones son estimadas y la desviación contra observaciones se guarda aparte.',
      'Un ID compartido o una camiseta parecida no demuestra identidad; los jugadores sin enlace confirmado quedan ausentes.'],
    gaps: [], estimates: [], diagnostics: [] };
  const byFrame = new Map();
  for (let i = 0; i < frames.length; i++) {
    if (frames[i].calibrated) continue;
    const begin = i;
    while (i + 1 < frames.length && !frames[i + 1].calibrated) i++;
    const left = frames[begin - 1], right = frames[i + 1];
    const gap = { id: `cut:${left?.f ?? 'start'}:${right?.f ?? 'end'}`, start_s: left?.t ?? frames[begin].t,
      end_s: right?.t ?? frames[i].t + 1 / fps, before_frame: left?.f ?? null, after_frame: right?.f ?? null,
      missing_start_frame: frames[begin].f, missing_end_frame: frames[i].f,
      duration_s: right && left ? right.t - left.t : null, eligible: false, reason: '',
      status: 'rejected', before: [], after: [], candidates: [], associations: [], cut_frames: [],
      calibration_source: left?.calibration_source ?? null };
    const barriers = cuts.filter(cut => left && right && cut > left.f && cut <= right.f);
    gap.cut_frames = barriers;
    if (!left || !right) gap.reason = 'Sin observaciones calibradas en ambos extremos; no se extrapola.';
    else if (!barriers.length) gap.reason = 'Falta calibración sin un corte identificado; requiere resolver la cámara.';
    else if (gap.duration_s > maxGapS + 1e-9) gap.reason = `Hueco superior al límite de ${maxGapS} s.`;
    else if (left.quality.bad || right.quality.bad) gap.reason = 'Calibración de extremo no aceptable.';
    else {
      gap.eligible = true; gap.status = approved.has(gap.id) ? 'approved' : 'pending_review';
      gap.reason = approved.has(gap.id) ? 'Continuidad en directo revisada; faltan o se aplican enlaces de identidad confirmados.'
        : 'Revisa que ambos extremos correspondan al mismo tiempo de juego, sin repetición.';
      gap.camera_quality = { before: left.quality, after: right.quality };
      const before = endpoints(tracks, left, 'before', fps), after = endpoints(tracks, right, 'after', fps);
      gap.before = [...before.values()].map(value => value.endpoint);
      gap.after = [...after.values()].map(value => value.endpoint);
      const base = Math.max(left.quality.baseline_m, right.quality.baseline_m);
      const candidates = [];
      for (const a of before.values()) for (const b of after.values()) {
        if (a.endpoint.team !== b.endpoint.team || a.endpoint.role !== b.endpoint.role) continue;
        const result = geometry(a, b, L, W, base);
        candidates.push({ id: `${gap.id}|${a.endpoint.key}|${b.endpoint.key}`, before: a.endpoint, after: b.endpoint,
          cost_m: result.cost_m, reason: result.reasons.length ? result.reasons.join(', ') : 'Geometría compatible; confirma identidad visual.',
          status: result.reasons.length ? 'rejected' : 'candidate', metrics: result.metrics, rejection_reasons: result.reasons,
          review_required: true });
      }
      candidates.sort((a, b) => a.cost_m - b.cost_m);
      for (const candidate of candidates.filter(c => c.status === 'candidate')) {
        const sameBefore = candidates.filter(c => c.status !== 'rejected' && c.before.key === candidate.before.key);
        const sameAfter = candidates.filter(c => c.status !== 'rejected' && c.after.key === candidate.after.key);
        const otherBefore = sameBefore.find(c => c !== candidate), otherAfter = sameAfter.find(c => c !== candidate);
        const margin = Math.min(otherBefore ? otherBefore.cost_m - candidate.cost_m : Infinity,
          otherAfter ? otherAfter.cost_m - candidate.cost_m : Infinity);
        candidate.metrics.unique_margin_m = Number.isFinite(margin) ? margin : null;
        if (sameBefore[0] === candidate && sameAfter[0] === candidate && margin >= 1 && candidate.metrics.kit_cosine >= .9
          && candidate.metrics.kit_cosine !== null && candidate.cost_m <= base + 2) candidate.status = 'suggested';
      }
      const links = requested.filter(link => String(link.gapId ?? link.gap_id) === gap.id);
      const duplicateBefore = new Set(links.filter((link, k) => links.some((other, j) => k !== j && other.beforeKey === link.beforeKey)).map(link => link.beforeKey));
      const duplicateAfter = new Set(links.filter((link, k) => links.some((other, j) => k !== j && other.afterKey === link.afterKey)).map(link => link.afterKey));
      for (const link of links) {
        const a = before.get(link.beforeKey), b = after.get(link.afterKey);
        const candidate = candidates.find(c => c.before.key === link.beforeKey && c.after.key === link.afterKey);
        const reasons = [];
        if (!approved.has(gap.id)) reasons.push('continuidad_no_revisada');
        if (!a || !b) reasons.push('extremo_inexistente_o_excluido');
        if (duplicateBefore.has(link.beforeKey) || duplicateAfter.has(link.afterKey)) reasons.push('asociacion_no_uno_a_uno');
        let path=null;
        if (a && b) {
          const assessment=geometry(a,b,L,W,base);
          const hard=['equipos_distintos','roles_distintos','horizonte_no_admitido','apariencia_incompatible','historia_de_movimiento_insuficiente'];
          if(allowWindow&&assessment.reasons.length&&!assessment.reasons.some(r=>hard.includes(r)))path=reviewedMotionWindow(a,b,L,W);
          if(!path)reasons.push(...assessment.reasons);
          else if(candidate) {
            candidate.motion_path=path;
            candidate.metrics={...candidate.metrics,bridge_algorithm:path.algorithm,
              bridge_switch_s:path.switch_s,bridge_fallback_reason:path.fallback_reason,
              max_speed_m_s:path.max_speed_m_s,max_acceleration_m_s2:path.max_acceleration_m_s2,
              endpoint_velocity_preserved:true,observation_window_s:path.window_s,
              max_observation_deviation_m:path.max_observation_deviation_m};
            candidate.rejection_reasons=[];candidate.reason='Identidad revisada; ajuste de movimiento con observaciones y calibración aproximada.';
          }
        }
        const associationId = candidate?.id || `${gap.id}|${link.beforeKey}|${link.afterKey}`;
        gap.associations.push({ id: associationId, beforeKey: link.beforeKey, afterKey: link.afterKey,
          status: reasons.length ? 'rejected' : 'accepted', reasons,
          motion_algorithm: candidate?.metrics.bridge_algorithm ?? null,
          motion_fallback_reason: candidate?.metrics.bridge_fallback_reason ?? null,
          endpoint_velocity_preserved: !reasons.length,
          ...(path?{motion_path:path}:{}),
          ...(link.provenance?{provenance:link.provenance}:{}) });
        if (reasons.length) continue;
        if (candidate) candidate.status = 'accepted';
        const speedDisagreement = Math.hypot(a.endpoint.velocity.vx - b.endpoint.velocity.vx, a.endpoint.velocity.vy - b.endpoint.velocity.vy);
        for (let j = begin; j <= i; j++) {
          const frame = frames[j];
          if (frame.has_observations) continue;
          if (frame.t <= a.endpoint.t || frame.t >= b.endpoint.t) continue;
          const p = path?motionWindowAt(path,frame.t):reconstructBridge(a.points, b.points, frame.t, {L, W});
          if (!p) continue;
          const afterS = frame.t - a.endpoint.t, beforeS = b.endpoint.t - frame.t, horizon = Math.min(afterS, beforeS);
          const uncertainty = base + 1.5 * horizon + .25 * speedDisagreement * horizon;
          const player = { id: `estimado:${associationId}`, team: a.endpoint.team, role: a.endpoint.role, x: p.x, y: p.y,
            state: 'estimado', source: 'predicho', kind: 'reconstruccion_corte', association_id: associationId, gap_id: gap.id,
            before_key: a.endpoint.key, after_key: b.endpoint.key, horizon_s: horizon,
            motion_algorithm: candidate?.metrics.bridge_algorithm ?? null, endpoint_velocity_preserved: true,
            uncertainty_m: uncertainty, uncertainty_kind: 'heuristica_no_calibrada' };
          if (!byFrame.has(frame.f)) byFrame.set(frame.f, { frame: frame.f, t: frame.t, players: [] });
          byFrame.get(frame.f).players.push(player);
        }
      }
      gap.candidates = candidates;
    }
    report.gaps.push(gap);
  }
  // Never draw two associations for the same observed identity in one frame. A
  // nearly coincident same-team pair is hidden conservatively and audited.
  for (const frame of byFrame.values()) {
    const kept = [];
    for (const player of frame.players.sort((a, b) => a.uncertainty_m - b.uncertainty_m)) {
      if (kept.some(other => other.before_key === player.before_key || other.after_key === player.after_key
        || other.team === player.team && other.role === player.role && distance(other, player) < .25)) {
        report.diagnostics.push({ frame: frame.frame, association_id: player.association_id, reason: 'marcador_estimado_duplicado_o_coincidente' });
      } else kept.push(player);
    }
    frame.players = kept;
  }
  report.estimates = [...byFrame.values()].filter(frame => frame.players.length).sort((a, b) => a.t - b.t);
  report.summary = { gaps: report.gaps.length, eligible_gaps: report.gaps.filter(gap => gap.eligible).length,
    approved_gaps: report.gaps.filter(gap => gap.status === 'approved').length,
    accepted_associations: report.gaps.reduce((sum, gap) => sum + gap.associations.filter(link => link.status === 'accepted').length, 0),
    estimated_frames: report.estimates.length, estimated_positions: report.estimates.reduce((sum, frame) => sum + frame.players.length, 0),
    unconfirmed_candidates: report.gaps.reduce((sum, gap) => sum + gap.candidates.filter(link => ['candidate', 'suggested'].includes(link.status)).length, 0) };
  return report;
}

/** Read only separately stored estimates; never extrapolate beyond a saved frame. */
export function estimatesAt(report, t) {
  const frames = report.estimates || [], dt = 1 / (report.fps || 25);
  if (!frames.length || !Number.isFinite(t) || t < frames[0].t - 1e-9 || t >= frames.at(-1).t + dt - 1e-9) return [];
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (frames[mid].t <= t + 1e-9) lo = mid; else hi = mid - 1; }
  const frame = frames[lo], next = frames[lo + 1];
  if (t >= frame.t + dt - 1e-9) return [];
  return frame.players.map(player => {
    const q = next && next.t - frame.t <= dt * 1.1 ? next.players.find(other => other.association_id === player.association_id) : null;
    if (!q || t <= frame.t) return { ...player };
    const s = Math.max(0, Math.min(1, (t - frame.t) / (next.t - frame.t)));
    return { ...player, x: player.x + s * (q.x - player.x), y: player.y + s * (q.y - player.y),
      uncertainty_m: player.uncertainty_m + s * (q.uncertainty_m - player.uncertainty_m) };
  });
}

/** Internal masking check on measured, same-identity continuous tracks. It does
 * not measure true identity matching or unseen-cut accuracy. No model fitting. */
export function evaluateReconstruction(raw, { gaps = [1, 2], strideS = 1, ...options } = {}) {
  const tracks = reconstructionTracks(raw, options), fps = Number(raw.fps) || 25;
  const rows = [];
  for (const requestedGap of gaps) {
    const gap = Number(requestedGap), errors = { bridge: [], linear: [], constant_velocity: [], hold_last: [] };
    let windows = 0;
    if (!(gap > 0 && gap <= MAX_GAP)) continue;
    for (const points of tracks.values()) {
      let lastStart = -Infinity;
      for (let a = 0; a < points.length; a++) {
        const p0 = points[a];
        if (p0.t - lastStart < strideS - 1e-9) continue;
        const b = points.findIndex(p => Math.abs(p.t - p0.t - gap) <= .6 / fps);
        if (b <= a + 1) continue;
        const p1 = points[b], before = points.slice(0, a + 1), after = points.slice(b);
        const v = velocity(before, 'before'), vAfter = velocity(after, 'after');
        if (!v || !vAfter || v.speed > MAX_SPEED || vAfter.speed > MAX_SPEED) continue;
        const hidden = points.slice(a + 1, b);
        if (!hidden.length || [p0, ...hidden, p1].slice(1).some((p, k) => p.t - [p0, ...hidden, p1][k].t > 1.6 / fps)) continue;
        lastStart = p0.t; windows++;
        for (const target of hidden) {
          const h = target.t - p0.t, s = h / (p1.t - p0.t);
          const predicted = reconstructBridge(before, after, target.t);
          errors.bridge.push(distance(target, predicted));
          errors.linear.push(distance(target, { x: p0.x + s * (p1.x - p0.x), y: p0.y + s * (p1.y - p0.y) }));
          errors.constant_velocity.push(distance(target, { x: p0.x + h * v.vx, y: p0.y + h * v.vy }));
          errors.hold_last.push(distance(target, p0));
        }
      }
    }
    rows.push({ gap_s: gap, windows, positions: errors.bridge.length, ...Object.fromEntries(Object.entries(errors)
      .map(([method, values]) => [method, { median_m: quantile(values, .5), p90_m: quantile(values, .9) }])) });
  }
  return { method: 'ocultacion_interna_sin_ajuste', evaluated_states: 'detectado', rows,
    limitations: ['Referencia: posiciones medidas por el pipeline, no anotaciones independientes del estadio.',
      'Identidad fijada dentro de cada tramo; no valida la asociación entre cámaras.',
      'Los métodos retrospectivos utilizan observaciones posteriores; los causales no.'] };
}
