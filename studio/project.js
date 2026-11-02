// FOS Studio · proyecto (fos-studio-project/1): lo que guarda quien edita. No lleva el video ni los datos: solo qué clip, qué tramo y qué capas/anotaciones.
// Las etapas siguientes llenan `annotations` (reflectores, pausas con texto, texto sobre la cancha, líneas) y `seeds` (jugadores puestos a mano) sin cambiar este esquema.

export const PROJECT_SCHEMA = 'fos-studio-project/1';
export const MAX_ANALYSIS_SECONDS = 30;   // el análisis de un tramo nuevo: de 1 a 30 s (el mismo límite del dashboard)

export const DEFAULT_LAYERS = {apolonio: true, footprint: true, estimated: true, ball: true, referees: true, fieldLines: true, feetRings: true};

export function newProject(bundle) {
  const dur = bundle.clip.frames / bundle.clip.fps;
  return {schema: PROJECT_SCHEMA, clip: {id: bundle.clip.id, fps: bundle.clip.fps, frames: bundle.clip.frames},
    range: {start: 0, end: Math.min(dur, MAX_ANALYSIS_SECONDS)}, videoOffset: 0, gain: 0.9, layers: {...DEFAULT_LAYERS}, annotations: [], seeds: [], notes: ''};
}

/** Cambia el tramo analizado. Devuelve {ok, error, range}: el tramo debe caer dentro del clip y durar entre 1 y 30 s (o lo que dure el clip si es más corto). */
export function setRange(project, start, end) {
  const dur = project.clip.frames / project.clip.fps;
  if (![start, end].every(v => typeof v === 'number' && isFinite(v))) return {ok: false, error: 'Escribe el inicio y el final en segundos.', range: project.range};
  if (start < 0 || end > dur + 1e-9) return {ok: false, error: `El tramo debe estar dentro del clip (0–${dur.toFixed(1)} s).`, range: project.range};
  if (end <= start) return {ok: false, error: 'El final debe ser mayor que el inicio.', range: project.range};
  const need = Math.min(1, dur);
  if (end - start < need - 1e-9) return {ok: false, error: `El tramo debe durar al menos ${need.toFixed(0)} s.`, range: project.range};
  if (end - start > MAX_ANALYSIS_SECONDS + 1e-9) return {ok: false, error: `El tramo analizado puede durar como máximo ${MAX_ANALYSIS_SECONDS} s.`, range: project.range};
  project.range = {start, end};
  return {ok: true, error: '', range: project.range};
}

export function projectProblems(p) {
  const bad = [];
  if (!p || p.schema !== PROJECT_SCHEMA) return [`esquema ${JSON.stringify(p && p.schema)} (se esperaba ${PROJECT_SCHEMA})`];
  if (!p.clip || !(p.clip.fps > 0) || !(p.clip.frames > 0)) bad.push('clip inválido');
  else {
    const dur = p.clip.frames / p.clip.fps, r = p.range || {};
    if (!(r.start >= 0) || !(r.end <= dur + 1e-9) || !(r.end > r.start)) bad.push('tramo fuera del clip');
    else if (r.end - r.start > MAX_ANALYSIS_SECONDS + 1e-9) bad.push(`el tramo pasa de ${MAX_ANALYSIS_SECONDS} s`);
  }
  if (!Array.isArray(p.annotations)) bad.push('annotations debe ser una lista');
  else if (!bad.length) p.annotations.forEach((a, i) => annotationProblems(a, p).forEach(m => bad.push(`anotación ${i + 1}: ${m}`)));
  if (!Array.isArray(p.seeds)) bad.push('seeds debe ser una lista');
  return bad;
}

// ---------------------------------------------------------------- anotaciones (etapa 2): reflector, texto en el campo, línea de jugadores, pausa con texto
export const ANNOTATION_TYPES = ['spotlight', 'pitchText', 'line', 'freeze'];
export const LINE_NAMES = ['Defensa', 'Mediocampo', 'Delantera'];
export const FREEZE_LIMITS = {min: 0.5, max: 10};
export const TEXT_LIMITS = {maxChars: 60, minSize: 0.8, maxSize: 12};
const num = v => typeof v === 'number' && isFinite(v);
const isHex = c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);

/** Problemas de una anotación dentro de un proyecto (lista vacía = bien). */
export function annotationProblems(a, project) {
  if (!a || typeof a !== 'object') return ['anotación inválida'];
  if (!ANNOTATION_TYPES.includes(a.type)) return [`tipo desconocido «${a.type}»`];
  const bad = [], dur = project.clip.frames / project.clip.fps;
  if (typeof a.id !== 'string' || !a.id) bad.push('falta el id');
  if (a.type !== 'freeze') {
    if (!num(a.start) || !num(a.end)) bad.push('el inicio y el final deben ser números');
    else if (a.start < 0 || a.end > dur + 1e-9 || a.end <= a.start) bad.push(`el tramo (${a.start}–${a.end} s) no cabe en el clip (0–${dur.toFixed(1)} s)`);
  }
  if (a.type === 'spotlight') {
    if (!Number.isInteger(a.slot) || a.slot < 0 || a.slot > 21) bad.push('el jugador debe ser una casilla de 0 a 21');
  } else if (a.type === 'pitchText') {
    if (typeof a.text !== 'string' || !a.text.trim()) bad.push('el texto no puede estar vacío');
    else if (a.text.length > TEXT_LIMITS.maxChars) bad.push(`el texto pasa de ${TEXT_LIMITS.maxChars} caracteres`);
    if (!num(a.x) || !num(a.y) || a.x < 0 || a.x > 105 || a.y < 0 || a.y > 68) bad.push('la posición debe caer dentro de la cancha (105 × 68 m)');
    if (!num(a.size) || a.size < TEXT_LIMITS.minSize || a.size > TEXT_LIMITS.maxSize) bad.push(`el tamaño debe estar entre ${TEXT_LIMITS.minSize} y ${TEXT_LIMITS.maxSize} m`);
    if (!num(a.rotation) || a.rotation < -180 || a.rotation > 180) bad.push('la rotación va de -180 a 180 grados');
    if (!isHex(a.color)) bad.push('el color debe ser #RRGGBB');
  } else if (a.type === 'line') {
    if (a.team !== 0 && a.team !== 1) bad.push('el equipo debe ser 0 o 1');
    if (!Array.isArray(a.slots) || a.slots.length < 2 || a.slots.length > 6 || new Set(a.slots).size !== a.slots.length) bad.push('una línea lleva de 2 a 6 jugadores distintos');
    else if (a.slots.some(j => !Number.isInteger(j) || j < 0 || j > 21 || (j < 11 ? 0 : 1) !== a.team)) bad.push('todos los jugadores de la línea deben ser del mismo equipo');
    if (typeof a.name !== 'string' || !a.name.trim()) bad.push('la línea necesita un nombre');
    if (!isHex(a.color)) bad.push('el color debe ser #RRGGBB');
  } else if (a.type === 'freeze') {
    if (!num(a.t) || a.t < 0 || a.t > dur + 1e-9) bad.push('el instante de la pausa debe caer dentro del clip');
    if (!num(a.duration) || a.duration < FREEZE_LIMITS.min || a.duration > FREEZE_LIMITS.max) bad.push(`la pausa dura entre ${FREEZE_LIMITS.min} y ${FREEZE_LIMITS.max} s`);
    if (a.text != null && (typeof a.text !== 'string' || a.text.length > 80)) bad.push('el texto de la pausa pasa de 80 caracteres');
  }
  return bad;
}

const nextId = p => 'a' + (1 + Math.max(0, ...p.annotations.map(a => +String(a.id).slice(1) || 0)));

/** Agrega una anotación (el id lo pone el proyecto). Devuelve {ok, error, annotation}; si es inválida no cambia nada. */
export function addAnnotation(project, partial) {
  const a = {...partial, id: nextId(project)}, bad = annotationProblems(a, project);
  if (!bad.length && a.type === 'freeze' && project.annotations.some(o => o.type === 'freeze' && Math.abs(o.t - a.t) < 0.05)) bad.push('ya hay una pausa en ese instante');
  if (bad.length) return {ok: false, error: bad[0].charAt(0).toUpperCase() + bad[0].slice(1) + '.', annotation: null};
  project.annotations.push(a);
  return {ok: true, error: '', annotation: a};
}

export function updateAnnotation(project, id, patch) {
  const i = project.annotations.findIndex(a => a.id === id);
  if (i < 0) return {ok: false, error: 'No existe esa anotación.'};
  const a = {...project.annotations[i], ...patch, id}, bad = annotationProblems(a, project);
  if (bad.length) return {ok: false, error: bad[0].charAt(0).toUpperCase() + bad[0].slice(1) + '.'};
  project.annotations[i] = a;
  return {ok: true, error: '', annotation: a};
}

export function removeAnnotation(project, id) {
  const n = project.annotations.length;
  project.annotations = project.annotations.filter(a => a.id !== id);
  return project.annotations.length < n;
}

/** Las anotaciones con ventana de tiempo (todas menos las pausas) que están visibles en el instante t. */
export const activeAnnotations = (project, t) => project.annotations.filter(a => a.type !== 'freeze' && t >= a.start - 1e-9 && t <= a.end + 1e-9);

/** Las pausas que se cruzan al pasar del instante t0 al t1 (t0 < t1), en orden. */
export const freezesBetween = (project, t0, t1) => project.annotations.filter(a => a.type === 'freeze' && a.t > t0 + 1e-9 && a.t <= t1 + 1e-9).sort((a, b) => a.t - b.t);

export function serializeProject(p) { return JSON.stringify(p, null, 2); }

export function parseProject(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
  const bad = projectProblems(p);
  if (bad.length) throw new Error('Proyecto no válido: ' + bad.join('; ') + '.');
  return {...newProject({clip: {...p.clip, id: p.clip.id}}), ...p, layers: {...DEFAULT_LAYERS, ...(p.layers || {})}};
}
