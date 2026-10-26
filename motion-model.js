// Causal short-horizon curves from measured history. Existing forests are optional;
// this wrapper trains nothing and never creates a player identity or a camera pose.
import { lsSlope, mlAt, mlModel, TAU as ML_TAU } from './prediction_ml.js';

const clampVector = (v, limit) => {
  const length = Math.hypot(v.x, v.y);
  return length > limit && length > 0 ? { x: v.x * limit / length, y: v.y * limit / length } : v;
};
const norm = v => Math.hypot(v.x, v.y);
const finitePoint = p => p && [p.t, p.x, p.y].every(Number.isFinite);
const inside = (p, L, W) => p.x >= 0 && p.x <= L && p.y >= 0 && p.y <= W;
const measuredPoint = p => (!p.state || ['detected', 'detectado', 'measured', 'observed'].includes(String(p.state).toLowerCase()))
  && !['predicho', 'estimado', 'interpolado', 'interpolated', 'predicted', 'estimated', 'prediction', 'forecast'].includes(String(p.source || '').toLowerCase());
const identity = p => JSON.stringify([p.id ?? p.track_id ?? null, p.segment ?? p.cut_segment ?? null,
  p.identity_segment ?? null, p.identity_key ?? null, p.team ?? null, p.role ?? p.rol ?? null]);

function historyOf(points) {
  if (!Array.isArray(points) || !points.length || !finitePoint(points.at(-1))) return [];
  const key = identity(points.at(-1)), end = points.at(-1).t, history = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (!finitePoint(p) || identity(p) !== key || end - p.t > 1.3 + 1e-9) break;
    if (history.length && (history[0].t <= p.t || history[0].t - p.t > .24 + 1e-9)) break;
    if (!measuredPoint(p)) break;
    history.unshift(p);
  }
  return history;
}

function snapshot(anchor, duration, diagnostics) {
  const count = Math.ceil(duration * 60), samples = [];
  for (let i = 0; i <= count; i++) {
    const t = i === count ? duration : i / 60;
    samples.push({ t, x: anchor.x, y: anchor.y, vx: 0, vy: 0 });
  }
  return { samples, source: 'last_known_snapshot', diagnostics };
}

/** Relative times 0..duration_s, at 60 Hz. h=0 is exactly the measured anchor.
 * Initial velocity comes only from the last .6 s. Max speed/acceleration are
 * policies, not learned physical guarantees or calibrated uncertainty. */
export function buildMotionCurve(points, {
  duration_s = 3, maxSpeed = 9, maxAcceleration = 6, model = 'kinematic',
  mlState = null, weights = null, L = 105, W = 68,
} = {}) {
  const diagnostics = { version: 1, requested_model: model, trained_now: false,
    warnings: [], boundary_policy: 'abstain_motion_keep_last_known', samples_hz: 60 };
  const anchor = Array.isArray(points) ? points.at(-1) : null;
  if (!finitePoint(anchor) || !inside(anchor, L, W))
    return { samples: [], source: 'unsupported_anchor', diagnostics: { ...diagnostics, reason: 'unsupported_anchor' } };
  if (!measuredPoint(anchor))
    return { samples: [], source: 'unsupported_anchor', diagnostics: { ...diagnostics, reason: 'unmeasured_anchor' } };
  const duration = Math.min(3, Math.max(0, Number.isFinite(duration_s) ? duration_s : 3));
  if (duration !== duration_s) diagnostics.warnings.push('horizon_limited_to_0_3_s');
  const speedCap = Math.min(9, Math.max(.1, Number.isFinite(maxSpeed) ? maxSpeed : 9));
  const accelCap = Math.min(6, Math.max(.1, Number.isFinite(maxAcceleration) ? maxAcceleration : 6));
  const history = historyOf(points), slope = history.length ? lsSlope(history, history.length - 1, .6) : null;
  diagnostics.anchor_t = anchor.t;
  diagnostics.history_points = history.length;
  diagnostics.history_span_s = history.length ? history.at(-1).t - history[0].t : 0;
  diagnostics.max_speed_m_s = speedCap; diagnostics.max_acceleration_m_s2 = accelCap;
  if (!slope) return snapshot(anchor, duration, { ...diagnostics, reason: 'insufficient_measured_velocity_history' });
  const initialRaw = { x: slope.vx, y: slope.vy }, initial = clampVector(initialRaw, speedCap);
  diagnostics.initial_velocity_m_s = { vx: initial.x, vy: initial.y };
  if (norm(initialRaw) > speedCap) diagnostics.warnings.push('initial_velocity_estimate_limited');
  const tau = Math.max(1, norm(initial) / accelCap);
  diagnostics.damping_tau_s = tau;
  let learned = false;
  if (model === 'learned') {
    try {
      const accepted = mlModel(weights);
      const stateAnchor = mlState && mlState.s > 0 ? { x: mlState.xa, y: mlState.ya }
        : mlState ? { x: L - mlState.xa, y: W - mlState.ya } : null;
      learned = !!(accepted && weights.adopted === true && L === 105 && W === 68
        && (mlState?.s === 1 || mlState?.s === -1) && Array.isArray(mlState?.x)
        && mlState.x.length === weights.features.length && mlState.x.every(Number.isFinite)
        && [mlState.vx, mlState.vy, mlState.s].every(Number.isFinite)
        && stateAnchor && Math.hypot(stateAnchor.x - anchor.x, stateAnchor.y - anchor.y) < 1e-6);
    } catch { learned = false; }
    if (!learned) diagnostics.warnings.push('learned_model_or_state_unavailable_kinematic_fallback');
  }
  const count = Math.ceil(duration * 60), samples = [{ t: 0, x: anchor.x, y: anchor.y, vx: initial.x, vy: initial.y }];
  let position = { x: anchor.x, y: anchor.y }, velocity = { ...initial }, residual = { x: 0, y: 0 };
  let highestAcceleration = 0, highestSpeed = norm(velocity);
  for (let i = 1; i <= count; i++) {
    const t = i === count ? duration : i / 60, dt = t - samples.at(-1).t;
    const decay = Math.exp(-t / tau), run = tau * (1 - decay);
    const base = { x: anchor.x + initial.x * run, y: anchor.y + initial.y * run };
    let desired = { x: initial.x * decay, y: initial.y * decay };
    if (learned) {
      const horizon = Math.max(.5, t), predicted = mlAt(weights, mlState, horizon);
      const modelRun = ML_TAU * (1 - Math.exp(-horizon / ML_TAU));
      const modelVelocity = clampVector({ x: mlState.vx, y: mlState.vy }, speedCap);
      const direction = mlState.s > 0 ? 1 : -1;
      const modelBase = { x: anchor.x + direction * modelVelocity.x * modelRun,
        y: anchor.y + direction * modelVelocity.y * modelRun };
      const warm = Math.min(1, t / .5), alpha = 1 - Math.exp(-dt / .25);
      const target = { x: warm * (predicted.x - modelBase.x), y: warm * (predicted.y - modelBase.y) };
      if (![target.x, target.y].every(Number.isFinite)) {
        diagnostics.warnings.push('nonfinite_learned_output_kinematic_fallback');
        const fallback = buildMotionCurve(points, { duration_s: duration, maxSpeed: speedCap, maxAcceleration: accelCap, model: 'kinematic', L, W });
        return { ...fallback, diagnostics: { ...fallback.diagnostics, requested_model: model,
          warnings: [...diagnostics.warnings, ...fallback.diagnostics.warnings] } };
      }
      residual = { x: residual.x + alpha * (target.x - residual.x), y: residual.y + alpha * (target.y - residual.y) };
      desired.x += 2 * (base.x + residual.x - position.x);
      desired.y += 2 * (base.y + residual.y - position.y);
    }
    desired = clampVector(desired, speedCap);
    const change = clampVector({ x: desired.x - velocity.x, y: desired.y - velocity.y }, accelCap * dt);
    const nextVelocity = { x: velocity.x + change.x, y: velocity.y + change.y };
    const next = { x: position.x + .5 * (velocity.x + nextVelocity.x) * dt,
      y: position.y + .5 * (velocity.y + nextVelocity.y) * dt };
    if (!inside(next, L, W)) return snapshot(anchor, duration, {
      ...diagnostics, attempted_model: learned ? 'learned_residual_bounded' : 'kinematic_damped',
      reason: 'boundary_motion_abstention', boundary_contact_horizon_s: t,
    });
    highestAcceleration = Math.max(highestAcceleration, norm(change) / dt);
    highestSpeed = Math.max(highestSpeed, norm(nextVelocity));
    position = next; velocity = nextVelocity;
    samples.push({ t, x: next.x, y: next.y, vx: nextVelocity.x, vy: nextVelocity.y });
  }
  diagnostics.curve_max_speed_m_s = highestSpeed;
  diagnostics.curve_max_acceleration_m_s2 = highestAcceleration;
  diagnostics.learned_used = learned;
  if (learned) {
    diagnostics.weights_trained = weights.trained;
    diagnostics.learned_residual_lowpass_s = .25;
    diagnostics.learned_warmstart_s = .5;
    diagnostics.learned_horizons_s = [.5, 1, 1.5, 2, 3];
  }
  return { samples, source: learned ? 'learned_residual_bounded' : 'kinematic_damped', diagnostics };
}

/** Linear readout between already bounded curve samples; never beyond its horizon. */
export function motionAt(curve, t) {
  const samples = curve?.samples || [];
  if (!samples.length || !Number.isFinite(t) || t < 0 || t > samples.at(-1).t + 1e-9) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (samples[mid].t <= t) lo = mid; else hi = mid - 1; }
  const a = samples[lo], b = samples[lo + 1];
  if (!b) return { ...a, t };
  const s = (t - a.t) / (b.t - a.t);
  return { t, x: a.x + s * (b.x - a.x), y: a.y + s * (b.y - a.y),
    vx: a.vx + s * (b.vx - a.vx), vy: a.vy + s * (b.vy - a.vy) };
}
