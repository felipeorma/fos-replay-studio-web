// Dashboard rules shared by the browser and the regression tests.
import { frameAtOrBefore } from "./analysis.js?v=3f8c7c600687d4dca360bcf54437da4cbaa0e7875a3772906779c1fcb094f0c6";
import { displayAt } from "./display.js?v=3f8c7c600687d4dca360bcf54437da4cbaa0e7875a3772906779c1fcb094f0c6";
export const DEFAULT_SETTINGS = {
  version: 1,
  colors: {
    team0: "#2474ed",
    team1: "#f8f8f5",
    referee: "#f5cb43",
    goalkeeper0: "#a968ed",
    goalkeeper1: "#35cf91",
  },
  layers: {
    voronoi: true,
    network: false,
    select: false,
    line: true,
    footprint: true,
    estimates: false,
  },
  voronoi: { gain: 0.9, alpha: 0.26, grid: 0.5 },
  network: { team: "both", maxEdge: 35 },
  line: { team: "0", selected: [] },
  roles: {},
  role_sources: {},
  continuity: {
    enabled: false,
    model: "retrospective",
    camera: "full_pitch",
    estimatedVoronoi: false,
  },
  reconstruction: {
    maxGapS: 3,
    maxAfterS: 1,
    approvedGaps: [],
    associations: [],
    rejectedAssociations: [],
  },
};

export function timeSeconds(minutes, seconds) {
  const m = Number(minutes),
    s = Number(seconds);
  if (
    String(minutes).trim() === "" ||
    String(seconds).trim() === "" ||
    !Number.isInteger(m) ||
    m < 0 ||
    !Number.isFinite(s) ||
    s < 0 ||
    s >= 60
  )
    throw new Error(
      "Escribe minutos y segundos válidos (segundos entre 0 y 59,99).",
    );
  return m * 60 + s;
}

export function calibrationSummary(raw = {}, camera = {}) {
  raw = raw || {};
  const total = Array.isArray(raw.frames) ? raw.frames.length : Number(raw.info?.frames) || 0;
  const calibrated = Number.isInteger(raw.calibrated_frames) && raw.calibrated_frames >= 0
    ? raw.calibrated_frames : null;
  const reports = camera.chunks || camera.reports || camera.camera_reports || raw.camera_reports || [];
  const rows = Array.isArray(reports) ? reports : Object.values(reports);
  const weak = rows.some(q => /débil|debil|mala|weak|approx/i.test(String(q.quality?.level || q.quality || '')));
  if (total > 0 && calibrated === 0) return {kind: 'unavailable', total, calibrated,
    title: 'Sin calibración para generar el 2D', detail: `0 de ${total} cuadros calibrados. El video se analizó, pero no hay coordenadas de cancha confirmadas.`};
  if (weak) return {kind: 'weak', total, calibrated, title: 'Calibración aproximada · revisar líneas',
    detail: 'La geometría automática es débil y necesita revisión; no acredita exactitud de distancias.'};
  if (calibrated !== null && calibrated < total) return {kind: 'partial', total, calibrated,
    title: 'Calibración parcial · hay planos sin geometría', detail: `${calibrated} de ${total} cuadros con calibración candidata; revisa cada plano.`};
  return {kind: 'unreviewed', total, calibrated, title: 'Calibración pendiente de revisión',
    detail: 'Contrasta las líneas con el original. La presencia de una matriz no demuestra precisión.'};
}

export function validateTimeframe(
  start,
  end,
  duration = Infinity,
  maximum = 30,
) {
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start)
    throw new Error("El final debe ser posterior al inicio.");
  if (end < start + 1)
    throw new Error("Elige un fragmento de al menos 1 segundo.");
  if (duration !== Infinity && (!Number.isFinite(duration) || duration <= 0))
    throw new Error("No se pudo leer la duración del video.");
  if (Number.isFinite(duration) && end > duration)
    throw new Error("El intervalo termina después del video.");
  if (!Number.isFinite(maximum) || maximum <= 0)
    throw new Error("El máximo de segundos del fragmento no es válido.");
  if (end > start + maximum)
    throw new Error(
      `Elige un fragmento de hasta ${maximum} segundos para este análisis.`,
    );
  return { start, end, duration: end - start };
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, seconds),
    m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function selectionTimes(selection, fallbackDuration) {
  const start =
    selection.start_s ??
    selection.start ??
    selection.source_start_relative_s ??
    0;
  const end =
    selection.end_s ??
    selection.end ??
    selection.source_end_relative_s ??
    start + fallbackDuration;
  const playbackStart = selection.source_start_relative_s ?? start;
  return { start, end, playbackStart };
}

export function cutSegment(data, frame) {
  return (data.cuts || []).filter((f) => f <= frame.f).length;
}

export function dashboardFrame(data, t, revision = 0) {
  if (!data.frames.length || !Number.isFinite(t))
    return { f: 0, t, p: [], o: [], b: null };
  const first = data.frames[0],
    last = data.frames.at(-1);
  if (t < first.t - 1e-9 || t > last.t + 1 / data.fps + 1e-9)
    return { f: t < first.t ? first.f : last.f, t, p: [], o: [], b: null };
  return displayAt(data, frameAtOrBefore(data, t), t, revision, { fade: 0 });
}

export function positionEvidence(player, rawRecord) {
  if(player.position_source==='reviewed_motion_window')
    return `${rawRecord?.state==='interpolated'?'interpolado':'detectado'} · posición 2D ajustada/estimada`;
  if(player.position_source==='reviewed_retrospective_bridge')return 'posición 2D estimada desde última detección';
  if(player.position_source==='reviewed_fragment_interpolation')return 'posición interpolada · identidad revisada';
  if(player.position_source==='reviewed_fragment_motion_window')return 'posición 2D ajustada/estimada · identidad revisada';
  if (
    player.displayState === "interpolated" ||
    ["interpolated", "interpolado"].includes(
      rawRecord?.state || rawRecord?.source,
    )
  )
    return "interpolado";
  return rawRecord ? "detectado" : "sin observación en este cuadro";
}

// A track number is neither a shirt number nor a permanent match identity.
// A manually linked line never follows an ID into another camera segment.
export function markerKey(player, segment) {
  return JSON.stringify([
    segment,
    String(player.id),
    player.identity_segment ?? null,
  ]);
}

// Roles retain the raw camera scope; line selections can follow a reviewed
// canonical identity. An ambiguous reused raw key is never migrated.
export function selectionKey(player,segment) {
  return player.continuity_id||markerKey(player,segment);
}
export function resolvedSelections(selected,report) {
  return selected.map(key=>{
    const ids=[...new Set((report?.identity_map||[]).filter(b=>b.key===key).map(b=>b.continuity_id))];
    return ids.length===1?ids[0]:key;
  });
}

export function toggleSelected(selected, key) {
  return selected.includes(key)
    ? selected.filter((k) => k !== key)
    : [...selected, key];
}

export function reviewedFrame(frame, settings, segment) {
  const p = [],
    o = [];
  for (const original of [...frame.p, ...(frame.o || [])]) {
    const observedRole = original.role || original.rol;
    const q = observedRole ? { ...original, role: observedRole } : original;
    const role = settings.roles?.[markerKey(q, segment)];
    if (role === "referee") o.push({ ...q, ref: true, role: "arbitro" });
    else if (role === "unknown") o.push({ ...q, ref: false, role: "dudoso" });
    else if (/^(team|goalkeeper)[01]$/.test(role || ""))
      p.push({
        ...q,
        team: Number(role.at(-1)),
        ref: false,
        role: role.startsWith("goalkeeper") ? "portero" : "jugador",
      });
    else if (q.ref || ["arbitro", "juez_linea"].includes(observedRole))
      o.push({ ...q, ref: true });
    else (q.team === undefined ? o : p).push(q);
  }
  return { ...frame, p, o };
}

export function defensiveLinks(frame, settings, segment,report=null) {
  const selected = new Set(resolvedSelections(settings.line.selected,report)),
    team = Number(settings.line.team);
  const players = frame.p
    .filter((q) => q.team === team && (selected.has(selectionKey(q, segment))||selected.has(markerKey(q,segment))))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return {
    players,
    links: players.slice(1).map((b, i) => ({ a: players[i], b })),
  };
}

export function pickPlayer(frame, x, y, radius, segment) {
  let found = null,
    d = radius;
  for (const q of [...frame.p, ...(frame.o || [])]) {
    const distance = Math.hypot(q.x - x, q.y - y);
    if (distance <= d) {
      found = { ...q, key: markerKey(q, segment),selection_key:selectionKey(q,segment) };
      d = distance;
    }
  }
  return found;
}

export function mergeSettings(saved = {}, colors = {}) {
  const d = structuredClone(DEFAULT_SETTINGS);
  for (const group of [
    "colors",
    "layers",
    "voronoi",
    "network",
    "line",
    "roles",
    "role_sources",
    "reconstruction",
    "continuity",
  ])
    d[group] = { ...d[group], ...(saved[group] || {}) };
  d.colors = { ...d.colors, ...colors };
  for (const k of Object.keys(d.colors))
    if (!/^#[0-9a-f]{6}$/i.test(d.colors[k]))
      d.colors[k] = DEFAULT_SETTINGS.colors[k] || "#888888";
  for (const k of Object.keys(DEFAULT_SETTINGS.layers))
    d.layers[k] =
      typeof d.layers[k] === "boolean"
        ? d.layers[k]
        : DEFAULT_SETTINGS.layers[k];
  for (const [k, min, max] of [
    ["gain", 0, 5],
    ["alpha", 0, 1],
    ["grid", 0.1, 5],
  ])
    if (
      !Number.isFinite(d.voronoi[k]) ||
      d.voronoi[k] < min ||
      d.voronoi[k] > max
    )
      d.voronoi[k] = DEFAULT_SETTINGS.voronoi[k];
  if (!Array.isArray(d.line.selected)) d.line.selected = [];
  d.line.selected = [
    ...new Set(d.line.selected.filter((k) => typeof k === "string")),
  ];
  if (!["0", "1"].includes(String(d.line.team))) d.line.team = "0";
  if (!["both", "0", "1"].includes(String(d.network.team)))
    d.network.team = "both";
  if (
    !Number.isFinite(d.network.maxEdge) ||
    d.network.maxEdge < 1 ||
    d.network.maxEdge > 105
  )
    d.network.maxEdge = 35;
  for (const [key, min, max] of [
    ["maxGapS", 1, 3],
    ["maxAfterS", 0, 1],
  ])
    if (!Number.isFinite(d.reconstruction[key]) ||
        d.reconstruction[key] < min || d.reconstruction[key] > max)
      d.reconstruction[key] = DEFAULT_SETTINGS.reconstruction[key];
  d.reconstruction.approvedGaps = [...new Set(
    (Array.isArray(d.reconstruction.approvedGaps)
      ? d.reconstruction.approvedGaps : []).filter(q => typeof q === "string" && q.length <= 200),
  )].slice(0, 500);
  for (const key of ["associations", "rejectedAssociations"])
    d.reconstruction[key] = (Array.isArray(d.reconstruction[key])
      ? d.reconstruction[key] : []).filter(q => q &&
        ["gapId", "beforeKey", "afterKey"].every(k =>
          typeof q[k] === "string" && q[k].length > 0 && q[k].length <= 200))
      .map(({ gapId, beforeKey, afterKey }) => ({ gapId, beforeKey, afterKey }))
      .slice(0, 1000);
  for (const key of ["enabled", "estimatedVoronoi"])
    if (typeof d.continuity[key] !== "boolean")
      d.continuity[key] = DEFAULT_SETTINGS.continuity[key];
  if (!["retrospective", "bounded_velocity"].includes(d.continuity.model))
    d.continuity.model = DEFAULT_SETTINGS.continuity.model;
  d.continuity.camera = "full_pitch";
  return d;
}

// A camera change cannot make an extrapolation into a measured observation.
// Rendering a stable full-pitch view does not create a TV calibration footprint.
export function continuityEvidence(frame, estimates = [], reason = "") {
  const observed = [...(frame.p || []), ...(frame.o || [])].length;
  const isSnapshot = q => q.state === "ultimo_estado" || q.kind === "snapshot",
    snapshots = estimates.filter(isSnapshot);
  const estimated = estimates.length - snapshots.length;
  const snapshot = snapshots.length;
  return {
    mode: observed ? "observado" : estimated ? "estimado" : snapshot ? "ultimo_estado" : "sin_evidencia",
    label: observed ? (estimated ? "Observado + estimado" : snapshot ? "Observado + último estado" : "Observado") :
      estimated ? "Estimado" : snapshot ? "Último estado conocido" : "Sin evidencia",
    observed,
    estimated,
    snapshot,
    reason,
    last_observed_s: snapshot ? Math.max(...snapshots.map(q =>
      Number.isFinite(q.t_observed) ? q.t_observed : 0)) : null,
    oldest_observed_s: snapshot ? Math.min(...snapshots.map(q =>
      Number.isFinite(q.t_observed) ? q.t_observed : 0)) : null,
    uncertainty_m: estimated ? Math.max(...estimates.filter(q => !isSnapshot(q)).map(q =>
      Number.isFinite(q.uncertainty_m) ? q.uncertainty_m : 0)) : null,
  };
}

export function continuityForDisplay(players, frame, segment) {
  const observed = [...(frame.p || []), ...(frame.o || [])],
    identities=new Set(observed.map(p=>p.continuity_id).filter(Boolean)),
    roster=new Set(observed.map(p=>p.roster_id).filter(Boolean)),
    keys = new Set(observed.map(q => markerKey({ ...q, id: q.rid ?? q.id }, segment))),
    role = q => q.ref ? "arbitro" : q.role || q.rol || "jugador";
  return players.filter(q => Number.isFinite(q.x) && Number.isFinite(q.y) &&
    !identities.has(q.continuity_id) && !roster.has(q.roster_id) &&
    (q.roster_id||(!keys.has(q.before_key) && !keys.has(q.after_key))) &&
    (q.roster_id||!observed.some(p=>!(p.continuity_id&&q.continuity_id&&p.continuity_id!==q.continuity_id)&&
      p.team===q.team&&role(p)===role(q)&&Math.hypot(p.x-q.x,p.y-q.y)<.25)));
}

// Video positions between two measured 25 Hz frames can be drawn at 60 Hz.
// This affects display cadence only, never source frame IDs or stored tracking.
export function dashboardPaintKey(time, revision = 0) {
  return `${Math.floor(time * 60 + 1e-7)}:${revision}`;
}

// Display may stitch fragments within a camera shot. Reconstruction audits use
// the actual observed ID, while honoring the role review of that display chain.
export function reconstructionReviewedRoles(data, settings) {
  const roles = {};
  if (!Object.keys(settings.roles || {}).length) return roles;
  for (const row of data.frames) {
    const segment = cutSegment(data, row), frame = dashboardFrame(data, row.t);
    for (const q of [...frame.p, ...(frame.o || [])]) {
      const role = settings.roles[markerKey(q, segment)];
      if (role) roles[markerKey({ ...q, id: q.rid ?? q.id }, segment)] = role;
    }
  }
  return roles;
}

export function addCutAssociation(reconstruction, gapId, beforeKey, afterKey) {
  const pair = { gapId, beforeKey, afterKey };
  const existing = reconstruction.associations || [];
  if (existing.some(q => q.gapId === gapId &&
      (q.beforeKey === beforeKey || q.afterKey === afterKey) &&
      (q.beforeKey !== beforeKey || q.afterKey !== afterKey)))
    throw new Error("Ese jugador ya tiene un enlace en este corte. Descarta el enlace anterior primero.");
  return {
    ...reconstruction,
    associations: [...existing.filter(q => !sameCutPair(q, pair)), pair],
    rejectedAssociations: (reconstruction.rejectedAssociations || [])
      .filter(q => !sameCutPair(q, pair)),
  };
}

export function discardCutAssociation(reconstruction, pair) {
  return {
    ...reconstruction,
    associations: (reconstruction.associations || []).filter(q => !sameCutPair(q, pair)),
    rejectedAssociations: [...(reconstruction.rejectedAssociations || [])
      .filter(q => !sameCutPair(q, pair)), { ...pair }],
  };
}

export function sameCutPair(a, b) {
  return ["gapId", "beforeKey", "afterKey"].every(key => a[key] === b[key]);
}
