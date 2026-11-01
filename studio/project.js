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
  if (!Array.isArray(p.seeds)) bad.push('seeds debe ser una lista');
  return bad;
}

export function serializeProject(p) { return JSON.stringify(p, null, 2); }

export function parseProject(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
  const bad = projectProblems(p);
  if (bad.length) throw new Error('Proyecto no válido: ' + bad.join('; ') + '.');
  return {...newProject({clip: {...p.clip, id: p.clip.id}}), ...p, layers: {...DEFAULT_LAYERS, ...(p.layers || {})}};
}
