// Analyst annotations are drawings, never new tracking observations. References
// stay bound to one source/revision and an explicit identity domain.
export const ANNOTATION_SCHEMA = 'fos-tactical-annotations-v1';
export const ANNOTATION_LIMITS = Object.freeze({items: 200, refs: 22, points: 64, bytes: 1_000_000, history: 60});
const TYPES = new Set(['highlight', 'link', 'zone']);
const MODES = new Set(['track', 'continuity', 'slot']);
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(`${name} no válido.`);
  return value;
};
const token = (value, name) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) fail(`${name} no válido.`);
  return text(String(value), 160, name);
};
const teamOf = player => player.team === 0 || player.team === 1 ? player.team : null;

export function annotationScope(scope) {
  if (!object(scope)) fail('Falta el origen de las anotaciones.');
  return {source: text(scope.source, 1024, 'Origen'), revision: text(scope.revision, 256, 'Revisión')};
}
const sameScope = (a, b) => a.source === b.source && a.revision === b.revision;

function cleanRef(ref) {
  if (!object(ref) || !MODES.has(ref.kind)) fail('Referencia de jugador no válida.');
  const id = text(ref.id, 160, 'Identificador');
  const team = ref.team ?? null;
  if (team !== null && team !== 0 && team !== 1) fail('Equipo de referencia no válido.');
  if (ref.kind === 'track') {
    if (!Number.isSafeInteger(ref.segment) || ref.segment < 0) fail('Falta el tramo de cámara de la referencia.');
    return {kind: 'track', id, segment: ref.segment, identity_segment: token(ref.identity_segment, 'Tramo de identidad'), team};
  }
  if (ref.kind === 'slot') {
    if (!Number.isSafeInteger(ref.slot) || ref.slot < 0 || ref.slot >= 22) fail('Casilla anónima no válida.');
    return {kind: 'slot', id, slot: ref.slot, generation: token(ref.generation, 'Ocupación de casilla'), phase: token(ref.phase, 'Fase'), team};
  }
  return {kind: 'continuity', id, team};
}

/** Default raw-track references cannot cross a camera cut or identity split.
 * Continuity must be explicitly selected by a caller with a reviewed map.
 * A slot reference denotes an anonymous estimated slot, not a physical person.
 */
export function annotationRef(player, {segment = 0, mode = 'track'} = {}) {
  if (!object(player) || !MODES.has(mode)) fail('No hay un jugador seleccionable.');
  if (mode === 'continuity') return cleanRef({kind: mode, id: player.continuity_id, team: teamOf(player)});
  if (mode === 'slot') return cleanRef({kind: mode, id: player.id, slot: player.slot,
    generation: player.occupant_generation, phase: player.segment_id ?? player.phase, team: teamOf(player)});
  return cleanRef({kind: mode, id: String(player.id ?? ''), segment,
    identity_segment: player.identity_segment, team: teamOf(player)});
}

export const annotationKey = ref => JSON.stringify(cleanRef(ref));
function point(p) {
  if (!object(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 105 || p.y < 0 || p.y > 68) fail('Punto fuera de la cancha.');
  return {x: p.x, y: p.y};
}
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function convexHull(points) {
  const sorted = [...new Map(points.map(p => [`${p.x}:${p.y}`, p])).values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return [];
  const half = values => {
    const out = [];
    for (const p of values) { while (out.length > 1 && cross(out.at(-2), out.at(-1), p) <= 1e-9) out.pop(); out.push(p); }
    return out;
  };
  const lower = half(sorted), upper = half([...sorted].reverse());
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return hull.length >= 3 ? hull : [];
}

/** t1=null means no end; finite intervals are [t0,t1), in video seconds. */
export function createAnnotation(input) {
  if (!object(input) || !TYPES.has(input.type)) fail('Tipo de anotación no válido.');
  const scope = annotationScope(input.scope), id = text(input.id, 96, 'ID de anotación');
  const t0 = input.t0 ?? 0, t1 = input.t1 ?? null;
  if (!Number.isFinite(t0) || t0 < 0 || (t1 !== null && (!Number.isFinite(t1) || t1 <= t0))) fail('Intervalo de anotación no válido.');
  const color = input.color ?? '#ffd23f', alpha = input.alpha ?? 0.18;
  if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) fail('Color no válido.');
  if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) fail('Opacidad no válida.');
  if (input.on !== undefined && typeof input.on !== 'boolean') fail('Visibilidad no válida.');
  const rawRefs = input.refs ?? [], rawPoints = input.points ?? [];
  if (!Array.isArray(rawRefs) || rawRefs.length > ANNOTATION_LIMITS.refs || !Array.isArray(rawPoints) || rawPoints.length > ANNOTATION_LIMITS.points) fail('Demasiados puntos o jugadores.');
  const refs = rawRefs.map(cleanRef), points = rawPoints.map(point);
  if (new Set(refs.map(annotationKey)).size !== refs.length) fail('El jugador está repetido.');
  if (refs.some(ref => ref.kind === 'slot') && refs.some(ref => ref.kind !== 'slot')) fail('No mezcles identidades con casillas anónimas.');
  if (points.length && (input.type !== 'zone' || refs.length)) fail('Una zona usa jugadores o puntos fijos, no ambos.');
  if (input.type === 'highlight' && refs.length !== 1) fail('Selecciona un jugador para destacar.');
  if (input.type === 'link' && refs.length < 2) fail('Selecciona al menos dos jugadores para enlazar.');
  if (input.type === 'zone' && (points.length ? convexHull(points).length < 3 : refs.length < 3)) fail('La zona necesita al menos tres puntos no alineados o tres jugadores.');
  const label = typeof input.label === 'string' ? input.label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '';
  return {id, type: input.type, scope, refs, points, t0, t1, color: color.toLowerCase(), alpha, label, on: input.on !== false};
}

function matches(ref, player, segment, mode) {
  if ((ref.kind !== mode && !(mode === 'continuity' && ref.kind === 'track')) || (ref.team !== null && ref.team !== teamOf(player))) return false;
  if (ref.kind === 'continuity') return ref.id === player.continuity_id;
  if (ref.kind === 'slot') return ref.slot === player.slot && ref.id === player.id &&
    ref.generation === token(player.occupant_generation, 'Ocupación de casilla') && ref.phase === token(player.segment_id ?? player.phase, 'Fase');
  return ref.id === String(player.id) && ref.segment === segment && ref.identity_segment === token(player.identity_segment, 'Tramo de identidad');
}
const isEstimated = q => q.est > 0 || q.estimated === true || q.estimated_speed === true ||
  q.identity_status === 'anonymous_slot_hypothesis' || (q.position_source && q.position_source !== 'detectado') ||
  ['estimated', 'interpolated', 'interpolado', 'predicho'].includes(q.displayState || q.state || q.source);

/** Resolve only current coordinates. No holding, extrapolation or inferred IDs.
 * A missing middle reference breaks a link; it never creates a shortcut. Zones
 * are the convex envelope of all selected members and disappear if one is absent.
 * Fixed zones use the same envelope, making unordered clicks safe to display.
 */
export function resolveAnnotations(items, {scope: rawScope, t, segment = 0, players = [], mode = 'track'} = {}) {
  const scope = annotationScope(rawScope);
  if (!Number.isFinite(t) || !Array.isArray(items) || items.length > ANNOTATION_LIMITS.items || !Array.isArray(players) || !MODES.has(mode)) return [];
  const out = [];
  for (const original of items) {
    let a;
    try { a = createAnnotation(original); } catch { continue; }
    if (!sameScope(a.scope, scope) || !a.on || t < a.t0 || (a.t1 !== null && t >= a.t1)) continue;
    const resolved = a.refs.map(ref => {
      const candidates = players.filter(p => {
        try { point(p); return matches(ref, p, segment, mode); } catch { return false; }
      });
      return candidates.length === 1 ? candidates[0] : null;
    });
    let points = [], segments = [];
    if (a.type === 'highlight') { if (!resolved[0]) continue; points = [point(resolved[0])]; }
    if (a.type === 'link') {
      for (let i = 1; i < resolved.length; i++) if (resolved[i - 1] && resolved[i]) segments.push([point(resolved[i - 1]), point(resolved[i])]);
      if (!segments.length) continue;
      points = resolved.filter(Boolean).map(point);
    }
    if (a.type === 'zone') {
      if (resolved.some(p => !p)) continue;
      points = convexHull(a.points.length ? a.points : resolved.map(point));
      if (points.length < 3) continue;
    }
    out.push({...a, points, segments, estimated: a.refs.some(ref => ref.kind === 'slot') || !!resolved.some(q => q && isEstimated(q)),
      anonymous: a.refs.some(ref => ref.kind === 'slot'), missing: resolved.filter(q => !q).length});
  }
  return out;
}

/** All mutations/imports are validated before the current state or undo changes. */
export function createAnnotationStore({scope: rawScope, annotations = []} = {}) {
  const scope = annotationScope(rawScope);
  const validate = items => {
    if (!Array.isArray(items) || items.length > ANNOTATION_LIMITS.items) fail('Demasiadas anotaciones.');
    const result = items.map(createAnnotation);
    if (result.some(a => !sameScope(a.scope, scope))) fail('Las anotaciones pertenecen a otro análisis.');
    if (new Set(result.map(a => a.id)).size !== result.length) fail('ID de anotación repetido.');
    return result;
  };
  let items = validate(annotations), past = [], future = [];
  const commit = next => {
    next = validate(next);
    past.push(items); if (past.length > ANNOTATION_LIMITS.history) past.shift();
    items = next; future = [];
    return clone(items);
  };
  return {
    get scope() { return clone(scope); },
    list: () => clone(items),
    add(spec) {
      let id = spec?.id, n = 1;
      if (id === undefined) { while (items.some(a => a.id === `annotation-${n}`)) n++; id = `annotation-${n}`; }
      const a = createAnnotation({...spec, id, scope: spec?.scope ?? scope});
      commit([...items, a]); return clone(a);
    },
    update(id, patch) {
      if (!object(patch)) fail('Edición de anotación no válida.');
      const index = items.findIndex(a => a.id === id);
      if (index < 0) return false;
      if (patch.id !== undefined && patch.id !== id) fail('No se puede cambiar el ID de una anotación.');
      const changed = createAnnotation({...items[index], ...patch, id});
      const next = [...items]; next[index] = changed;
      commit(next); return clone(changed);
    },
    remove(id) { if (!items.some(a => a.id === id)) return false; commit(items.filter(a => a.id !== id)); return true; },
    clear() { if (!items.length) return false; commit([]); return true; },
    undo() { if (!past.length) return false; future.push(items); items = past.pop(); return true; },
    redo() { if (!future.length) return false; past.push(items); items = future.pop(); return true; },
    export() { return JSON.stringify({schema: ANNOTATION_SCHEMA, scope, annotations: items}, null, 2); },
    import(value) {
      if (typeof value === 'string') {
        if (value.length > ANNOTATION_LIMITS.bytes) fail('Archivo de anotaciones demasiado grande.');
        value = JSON.parse(value);
      } else {
        const serialized = JSON.stringify(value);
        if (!serialized || serialized.length > ANNOTATION_LIMITS.bytes) fail('Archivo de anotaciones demasiado grande.');
      }
      if (!object(value) || value.schema !== ANNOTATION_SCHEMA || !sameScope(annotationScope(value.scope), scope)) fail('Archivo de anotaciones de otro análisis o formato.');
      return commit(validate(value.annotations));
    },
  };
}
