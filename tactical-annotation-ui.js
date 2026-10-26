import {annotationRef, annotationKey, createAnnotationStore, resolveAnnotations} from './tactical-annotations.js';

const names = {highlight: 'Destacar jugador', link: 'Enlazar jugadores', zone: 'Zona de jugadores'};
const minimum = {highlight: 1, link: 2, zone: 3};
const timeLabel = value => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;

export function tacticalPlayerRef(player, context) {
  const mode = context.mode === 'slot' ? 'slot' : context.mode === 'continuity' && player.continuity_id ? 'continuity' : 'track';
  return annotationRef(player, {segment: context.segment, mode});
}

/** Canvas-only paint: no tracking, interpolation or replacement positions. */
export function paintTacticalAnnotations(ctx, pt, geometries, {phase = 'under', radius = 15} = {}) {
  for (const item of geometries) {
    if ((item.type === 'highlight') !== (phase === 'over')) continue;
    const points = item.points.map(q => pt(q.x, q.y));
    if (points.some(q => !q || !Number.isFinite(q.x) || !Number.isFinite(q.y))) continue;
    ctx.save(); ctx.strokeStyle = item.color; ctx.fillStyle = item.color;
    ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = 3;
    ctx.setLineDash(item.estimated ? [5, 4] : []);
    if (item.type === 'highlight') {
      for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI); ctx.stroke(); }
    } else if (item.type === 'link') {
      ctx.beginPath();
      for (const [a, b] of item.segments) {
        const p = pt(a.x, a.y), q = pt(b.x, b.y);
        if (!p || !q) continue;
        ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    } else if (points.length >= 3) {
      ctx.beginPath(); points.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath();
      ctx.globalAlpha = item.alpha; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
    }
    if (item.label && points.length) {
      const x = points.reduce((sum, p) => sum + p.x, 0) / points.length,
        y = Math.min(...points.map(p => p.y)) - radius - 6;
      ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.font = '600 12px system-ui';
      ctx.textAlign = 'center'; ctx.fillStyle = '#101717';
      const width = ctx.measureText(item.label).width + 12;
      ctx.fillRect(x - width / 2, y - 13, width, 19); ctx.fillStyle = item.color; ctx.fillText(item.label, x, y);
    }
    ctx.restore();
  }
}

/** Shared, deliberately separate annotation layer for Analyst and Dashboard. */
export function createTacticalAnnotationPanel({container, getContext, onChange = () => {}, onArm = () => {}, storage}) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let store = null, scopeKey = '', armed = false, selected = [], type = 'highlight', shown = true, editingId = null, editingPoints = [];
  const doc = container.ownerDocument;
  container.classList.add('tactical-annotations');
  container.innerHTML = `<div class="ta-heading"><h2>Anotaciones 2D</h2><label><input data-ta="shown" type="checkbox" checked> Ver</label></div>
    <p class="ta-intro">Destaca un jugador, enlaza una línea o marca la zona entre varios. Pausa y toca los puntos del mapa.</p>
    <div class="ta-tools" role="group" aria-label="Anotaciones de jugadores">
      <button type="button" data-type="highlight" aria-pressed="false">Destacar</button>
      <button type="button" data-type="link" aria-pressed="false">Enlazar</button>
      <button type="button" data-type="zone" aria-pressed="false">Marcar zona</button>
    </div>
    <p data-ta="selection" class="ta-selection" aria-live="polite">Elige una herramienta para empezar.</p>
    <div class="ta-fields"><label>Nombre opcional<input data-ta="label" maxlength="60" placeholder="Defensa, presión…"></label><label>Color<input data-ta="color" type="color" value="#ffd23f"></label></div>
    <div class="ta-time"><label>Desde (s)<input data-ta="start" type="number" min="0" step=".1" value="0"></label><label>Hasta (s)<input data-ta="end" type="number" min="0" step=".1" placeholder="Fin del video"></label></div>
    <div class="ta-actions"><button data-ta="startNow" type="button">Desde ahora</button><button data-ta="endNow" type="button">Hasta ahora</button></div>
    <div class="ta-actions"><button data-ta="add" type="button" disabled>Guardar anotación</button><button data-ta="cancel" type="button">Terminar selección</button></div>
    <div data-ta="list" class="ta-list"></div>
    <div class="ta-actions"><button data-ta="undo" type="button">Deshacer</button><button data-ta="redo" type="button">Rehacer</button><button data-ta="clear" type="button">Borrar todas</button></div>
    <div class="ta-actions"><button data-ta="export" type="button">Exportar anotaciones</button><button data-ta="import" type="button">Importar JSON</button><input data-ta="file" type="file" accept=".json,application/json" hidden></div>
    <p data-ta="evidence" class="ta-evidence"></p><p data-ta="status" class="ta-status" role="status">Abre un análisis para anotar.</p>
    <a data-ta="calibration" class="ta-calibration" href="index.html#limits" target="_blank" rel="noopener">Revisar calibración con puntos de cancha ↗</a>`;
  const el = name => container.querySelector(`[data-ta="${name}"]`);
  const notice = (message, error = false) => { el('status').textContent = message; el('status').classList.toggle('ta-error', error); };
  const context = () => getContext() || {};
  const validScope = s => s && typeof s.source === 'string' && s.source && typeof s.revision === 'string' && s.revision;
  const storageKey = () => `fos-tactical-annotations-v1:${scopeKey}`;
  function controls() {
    const ready = !!store;
    for (const button of container.querySelectorAll('button')) button.disabled = !ready;
    const enough = type === 'zone' && editingPoints.length >= 3 || selected.length >= minimum[type] && (type !== 'highlight' || selected.length === 1);
    el('add').disabled = !ready || !enough;
    el('add').textContent = editingId ? 'Aplicar cambios' : 'Guardar anotación';
    for (const button of container.querySelectorAll('[data-type]')) button.setAttribute('aria-pressed', String(armed && button.dataset.type === type));
    el('selection').textContent = armed
      ? `${names[type]}: ${selected.length} ${context().mode === 'slot' ? 'casillas' : 'puntos'} elegidos. ${type === 'link' ? 'Se enlazan en el orden de tus clics.' : type === 'zone' ? 'La zona sigue la envolvente de los elegidos.' : 'Toca un jugador.'}`
      : 'Elige una herramienta para empezar.';
    el('evidence').textContent = context().mode === 'slot'
      ? 'Casillas anónimas: el dibujo sigue estimaciones del modelo, no identidades confirmadas.'
      : 'El enlace conserva su segmento e identidad revisada. Si falta un jugador, no se inventa su posición.';
    container.classList.toggle('ta-armed', armed);
  }
  function list() {
    el('list').replaceChildren();
    const items = store?.list() || [];
    if (!items.length) { const p = doc.createElement('p'); p.className = 'ta-empty'; p.textContent = 'Todavía no hay anotaciones.'; el('list').append(p); }
    for (const item of items) {
      const row = doc.createElement('div'), toggle = doc.createElement('input'), text = doc.createElement('span'), remove = doc.createElement('button'), edit = doc.createElement('button'), actions = doc.createElement('div');
      row.className = 'ta-item'; toggle.type = 'checkbox'; toggle.checked = item.on; toggle.style.accentColor = item.color;
      toggle.setAttribute('aria-label', `Mostrar ${item.label || names[item.type]}`);
      toggle.onchange = () => { store.update(item.id, {on: toggle.checked}); changed(); };
      text.textContent = `${item.label || names[item.type]} · ${timeLabel(item.t0)}–${item.t1 === null ? 'fin' : timeLabel(item.t1)}`;
      edit.type = 'button'; edit.textContent = 'Editar'; edit.setAttribute('aria-label', `Editar ${item.label || names[item.type]}`);
      edit.onclick = () => {
        editingId = item.id; selected = item.refs; editingPoints = item.points; type = item.type; armed = false;
        el('label').value = item.label; el('color').value = item.color; el('start').value = String(item.t0); el('end').value = item.t1 === null ? '' : String(item.t1);
        controls(); notice('Edita nombre, color o intervalo y pulsa «Aplicar cambios».');
      };
      remove.type = 'button'; remove.textContent = 'Eliminar'; remove.setAttribute('aria-label', `Eliminar ${item.label || names[item.type]}`);
      remove.onclick = () => { store.remove(item.id); if (editingId === item.id) { editingId = null; selected = []; editingPoints = []; } changed(); };
      actions.className = 'ta-item-actions'; actions.append(edit, remove);
      row.append(toggle, text, actions); el('list').append(row);
    }
    controls();
  }
  function changed() {
    try { if (!storage) throw new Error('Sin almacenamiento local'); storage.setItem(storageKey(), store.export()); notice('Anotaciones guardadas en este navegador. Exporta el JSON para conservar una copia.'); }
    catch { notice('No pude guardar en el navegador. Exporta las anotaciones para conservarlas.', true); }
    list(); onChange();
  }
  function sync() {
    const c = context(), key = validScope(c.scope) ? JSON.stringify(c.scope) : '';
    if (key === scopeKey && (!!store === !!key)) return c;
    scopeKey = key; selected = []; armed = false; editingId = null; editingPoints = [];
    store = key ? createAnnotationStore({scope: c.scope}) : null;
    if (store) {
      try { const saved = storage?.getItem(storageKey()); if (saved) store.import(saved); notice(storage ? 'Anotaciones vinculadas a este análisis; guardado local automático.' : 'Guardado local no disponible. Puedes trabajar y exportar el JSON.'); }
      catch { notice('La copia local no corresponde a esta revisión. No se ha importado.', true); }
      el('start').value = Math.max(0, Number(c.t) || 0).toFixed(1); el('end').value = '';
    } else notice('Abre un análisis y espera su revisión de datos para anotar.');
    list(); return c;
  }
  for (const button of container.querySelectorAll('[data-type]')) button.onclick = () => {
    const c = sync(); if (!store) return;
    const next = button.dataset.type; armed = !(armed && type === next); type = next; selected = []; editingId = null; editingPoints = [];
    el('start').value = Math.max(0, Number(c.t) || 0).toFixed(1);
    el('end').value = Math.min(c.duration || Infinity, Math.max(0, Number(c.t) || 0) + 10).toFixed(1);
    if (armed) onArm(); controls(); onChange();
  };
  el('shown').onchange = () => { shown = el('shown').checked; onChange(); };
  el('cancel').onclick = () => { armed = false; selected = []; editingId = null; editingPoints = []; controls(); onChange(); };
  el('calibration').onclick = () => { el('calibration').href = context().calibrationUrl || 'calibration-review.html'; };
  el('startNow').onclick = () => { el('start').value = Math.max(0, Number(context().t) || 0).toFixed(1); };
  el('endNow').onclick = () => { el('end').value = Math.max(0, Number(context().t) || 0).toFixed(1); };
  el('add').onclick = () => {
    sync(); if (!store) return;
    try {
      const t0 = el('start').value.trim(), t1 = el('end').value.trim();
      if (!t0) throw new Error('Indica el instante inicial.');
      const spec = {type, refs: selected, points: editingPoints, t0: Number(t0), t1: t1 ? Number(t1) : null, color: el('color').value,
        label: el('label').value.trim(), alpha: .18};
      if (editingId) store.update(editingId, spec); else store.add(spec);
      selected = []; armed = false; editingId = null; editingPoints = []; changed();
    } catch (error) { notice(error.message, true); }
  };
  for (const name of ['undo', 'redo', 'clear']) el(name).onclick = () => { sync(); if (store?.[name]()) { editingId = null; selected = []; armed = false; editingPoints = []; changed(); } };
  el('export').onclick = () => {
    sync(); if (!store) return;
    const url = URL.createObjectURL(new Blob([store.export()], {type: 'application/json'})), a = doc.createElement('a');
    a.href = url; a.download = 'fos-anotaciones-2d.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  el('import').onclick = () => el('file').click();
  el('file').onchange = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try { sync(); if (!store) throw new Error('Abre primero el análisis correspondiente.'); if (file.size > 1_000_000) throw new Error('El archivo de anotaciones es demasiado grande.'); store.import(await file.text()); selected = []; armed = false; editingId = null; editingPoints = []; changed(); }
    catch (error) { notice(error.message, true); }
    finally { event.target.value = ''; }
  };
  controls(); list();
  return {
    sync,
    get armed() { return armed; },
    cancelSelection() { armed = false; selected = []; editingId = null; editingPoints = []; controls(); },
    pickAt(point, tolerance = 3) {
      const c = sync(); if (!armed || !store) return false;
      const candidates = (c.players || []).filter(q => q.state !== 'ultimo_estado' && q.kind !== 'snapshot' && Number.isFinite(q.x) && Number.isFinite(q.y) && q.x >= 0 && q.x <= 105 && q.y >= 0 && q.y <= 68);
      const picked = candidates.flatMap(q => {
        try { return [{ref: tacticalPlayerRef(q, c), distance: Math.hypot(q.x - point.x, q.y - point.y)}]; } catch { return []; }
      }).filter(x => x.distance <= tolerance).sort((a, b) => a.distance - b.distance)[0];
      if (picked) {
        const ref = picked.ref, key = annotationKey(ref), index = selected.findIndex(x => annotationKey(x) === key);
        if (index >= 0) selected.splice(index, 1); else if (type === 'highlight') selected = [ref]; else selected.push(ref);
        controls(); onChange();
      }
      return true;
    },
    draw(ctx, pt, options = {}) {
      const c = sync(); if (!store || !shown) return;
      const geometries = resolveAnnotations(store.list(), c);
      paintTacticalAnnotations(ctx, pt, geometries, options);
      if (armed && selected.length && options.phase === 'over') {
        const drafts = selected.map((ref, i) => ({id: `draft-${i}`, type: 'highlight', scope: c.scope, refs: [ref], t0: 0, t1: null, color: el('color').value, label: '', alpha: .18, on: true}));
        paintTacticalAnnotations(ctx, pt, resolveAnnotations(drafts, c), {...options, radius: 19});
      }
    },
    export() { sync(); return store ? JSON.parse(store.export()) : null; },
    import(value) { sync(); if (!store) throw new Error('Abre primero el análisis correspondiente.'); store.import(value); selected = []; armed = false; editingId = null; editingPoints = []; changed(); },
  };
}
