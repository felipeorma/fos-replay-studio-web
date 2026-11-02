// FOS Studio · aplicación (etapa 1). Une el video del usuario con el paquete de análisis y el mapa 2D; el tramo y las capas viven en el proyecto.
import {parseBundle, bundleProblems, slotInfo} from './bundle.js';
import {newProject, setRange, parseProject, serializeProject, MAX_ANALYSIS_SECONDS, addAnnotation, updateAnnotation, removeAnnotation, activeAnnotations, freezesBetween, TEXT_LIMITS} from './project.js';
import {frameAt} from './geometry.js';
import {detectEngine, analysisRangeProblems, uploadVideo, startAnalysis, waitForAnalysis, buildBundle, cancelJob, videoUrl, calibrationAdvice} from './engine.js';
import {createMapRenderer, drawVideoOverlay, syncPitchTexts, tintOf, KEEPER, REF, LIME} from './render.js';

const $ = id => document.getElementById(id);
const S = {bundle: null, project: null, t: 0, playing: false, rate: 1, sel: null, hasVideo: false, videoUrl: null, last: 0, raf: 0, armed: null, picking: [], freeze: null, consumed: new Set(), videoFile: null, fileDuration: 0, engine: null, analysis: null};
const esc = v => String(v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const LINE_COLORS = {Defensa: '#C8F169', Mediocampo: '#4FC3FF', Delantera: '#FF8A5B'};
const map = createMapRenderer($('map')), video = $('video');
const fmt = (v, d = 2) => v.toFixed(d), pct = v => `${Math.round(v * 100)}%`, es = v => String(v).replace('.', ',');
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento: no pasa nada */ } },
};

function say(text, error = false) { const s = $('status'); s.textContent = text; s.classList.toggle('error', error); }

// ---------------------------------------------------------------- carga del paquete y del proyecto
function loadBundle(bundle) {
  pause();
  S.bundle = bundle; S.sel = null;
  const saved = store.get(`fos-studio:project:${bundle.clip.id}`);
  let project = null;
  if (saved) { try { project = parseProject(saved); if (project.clip.frames !== bundle.clip.frames) project = null; } catch (e) { project = null; } }
  S.project = project || newProject(bundle);
  $('clipTitle').textContent = bundle.clip.title || bundle.clip.id; $('clipSub').textContent = bundle.clip.subtitle || '';
  $('videoFrame').style.aspectRatio = `${bundle.clip.width} / ${bundle.clip.height}`;
  const [t0, t1] = bundle.teams;
  $('legend').innerHTML = [[t0.color, t0.name], [t1.color, t1.name], [KEEPER, 'portero'], [REF, 'árbitro y jueces de línea']].map(([c, n]) => `<span><i style="background:${esc(c)}"></i>${esc(n)}</span>`).join('') + '<span><i class="hollow"></i>estimado (no se ve)</span>';
  $('bar0').style.background = tintOf(t0.color); $('bar1').style.background = tintOf(t1.color);
  $('lnTeam').innerHTML = bundle.teams.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('');
  S.armed = null; S.picking = []; S.freeze = null; armUi(); renderAnnList();
  syncControls(); seek(S.project.range.start);
}

function syncControls() {
  const p = S.project, {start, end} = p.range;
  $('slider').min = start; $('slider').max = end; $('slider').step = 1 / S.bundle.clip.fps;
  $('rangeStart').value = fmt(start, 1); $('rangeEnd').value = fmt(end, 1); $('videoOffset').value = fmt(p.videoOffset, 1);
  $('rangeInfo').textContent = `${es(fmt(end - start, 1))} s de ${MAX_ANALYSIS_SECONDS} s como máximo`;
  document.querySelectorAll('[data-layer]').forEach(c => { c.checked = !!p.layers[c.dataset.layer]; });
  $('gain').value = p.gain; gainLabel();
}
const gainLabel = () => { const g = +$('gain').value; $('gainOut').textContent = g === 0 ? '0 · Voronoi (el más cercano)' : `${es(g.toFixed(2).replace(/0$/, ''))} · Apolonio`; };
const persist = () => { if (S.project) store.set(`fos-studio:project:${S.bundle.clip.id}`, serializeProject(S.project)); };

// ---------------------------------------------------------------- reproducción
function seek(t) {
  const {start, end} = S.project.range;
  S.t = Math.min(end, Math.max(start, t));
  S.consumed = new Set(S.project.annotations.filter(a => a.type === 'freeze' && a.t <= S.t + 1e-9).map(a => a.id));   // las pausas anteriores a este instante ya pasaron
  if (S.freeze) endFreeze(false);
  if (S.hasVideo) video.currentTime = S.t + S.project.videoOffset;
  render();
}
async function play() {
  if (S.playing || !S.bundle) return;
  const {start, end} = S.project.range;
  if (S.t >= end - 1e-3) seek(start);
  S.playing = true; S.last = performance.now(); buttons();
  if (S.hasVideo) { video.playbackRate = S.rate; try { await video.play(); } catch (e) { S.playing = false; buttons(); say('El navegador no dejó reproducir el video: pulsa play otra vez.', true); return; } }
  S.raf = requestAnimationFrame(tick);
}
function pause() { S.playing = false; cancelAnimationFrame(S.raf); if (S.freeze) endFreeze(false); if (S.hasVideo) video.pause(); buttons(); }
function startFreeze(a, now) {
  S.t = a.t; S.freeze = {a, until: now + a.duration * 1000};
  if (S.hasVideo) { video.pause(); video.currentTime = a.t + S.project.videoOffset; }
  $('videoFrame').classList.add('frozen'); render();
}
function endFreeze(resume) {
  S.freeze = null; $('videoFrame').classList.remove('frozen'); $('caption').hidden = true;
  if (resume && S.playing && S.hasVideo) video.play().catch(() => {});
}
function tick(now) {
  if (!S.playing) return;
  if (S.freeze) {                                                  // pausa con texto: el video y el mapa se quedan quietos hasta que pase el tiempo
    if (now < S.freeze.until) { S.last = now; render(); S.raf = requestAnimationFrame(tick); return; }
    endFreeze(true);
  }
  const prev = S.t;
  S.t = S.hasVideo ? video.currentTime - S.project.videoOffset : S.t + (now - S.last) / 1000 * S.rate;
  S.last = now;
  const {start, end} = S.project.range;
  const hit = freezesBetween(S.project, prev, Math.min(S.t, end)).find(a => !S.consumed.has(a.id));
  if (hit) { S.consumed.add(hit.id); startFreeze(hit, now); S.raf = requestAnimationFrame(tick); return; }
  if (S.t >= end) { if ($('loop').checked) { seek(start); } else { seek(end); pause(); return; } }
  else if (S.t < start - 0.05) seek(start);
  render();
  S.raf = requestAnimationFrame(tick);
}
function buttons() { const b = $('btnPlay'); b.textContent = S.playing ? '⏸' : '▶'; b.setAttribute('aria-label', S.playing ? 'Pausa' : 'Reproducir'); }
function step(n) { pause(); const fps = S.bundle.clip.fps; seek((Math.round(S.t * fps) + n) / fps); }

// ---------------------------------------------------------------- dibujo
function render() {
  if (!S.bundle) return;
  const {fps, frames} = S.bundle.clip, f = frameAt(S.t, fps, frames), p = S.project;
  const anns = activeAnnotations(p, S.t), opts = {layers: p.layers, gain: p.gain, sel: S.sel, annotations: anns, picking: S.picking};
  const info = map.draw(S.bundle, f, opts);
  const frame = $('videoFrame');
  if (S.hasVideo) { drawVideoOverlay($('overlay'), S.bundle, f, opts); syncPitchTexts($('textLayer'), S.bundle, f, anns, frame.clientWidth, frame.clientHeight); }
  else { const c = $('overlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height); syncPitchTexts($('textLayer'), S.bundle, f, [], 1, 1); }
  captionUi();
  $('slider').value = S.t;
  $('time').textContent = `${fmt(S.t - p.range.start)} / ${fmt(p.range.end - p.range.start)} s · cuadro ${f}`;
  const [t0, t1] = S.bundle.teams;
  if (info.pct == null) { $('bar0').style.width = '0'; $('bar1').style.width = '0'; $('pct0').textContent = p.layers.apolonio ? 'sin cámara en este cuadro' : 'capa apagada'; $('pct1').textContent = ''; }
  else { $('bar0').style.width = pct(info.pct); $('bar1').style.width = pct(1 - info.pct); $('pct0').textContent = `${t0.name} ${pct(info.pct)}`; $('pct1').textContent = `${pct(1 - info.pct)} ${t1.name}`; }
  playerPanel(f);
}
function playerPanel(f) {
  const el = $('player');
  if (S.sel == null) { el.textContent = 'Toca un jugador en el mapa.'; return; }
  const [x, y, vis, rad, v] = S.bundle.slots[f][S.sel], {team, keeper, number} = slotInfo(S.sel), name = S.bundle.teams[team].name;
  el.innerHTML = `<b>${keeper ? 'Portero' : `Jugador ${number}`} · ${esc(name)}</b><br>${vis > 0.5 ? 'medido en el video' : `estimado (duda de ±${es(fmt(rad, 1))} m)`}<br>Posición ${es(fmt(x, 1))} m, ${es(fmt(y, 1))} m<br>Velocidad ${es(fmt(v * 3.6, 1))} km/h`;
}

// ---------------------------------------------------------------- video del usuario
function loadVideo(file) {
  S.videoFile = file; S.fileDuration = 0;
  attachVideo(URL.createObjectURL(file), `«${file.name}»`, () => {
    S.fileDuration = video.duration;
    $('anStart').value = '0'; $('anEnd').value = String(Math.min(S.engine && S.engine.maxSeconds || MAX_ANALYSIS_SECONDS, Math.floor(video.duration * 10) / 10));
    updateAnalyzeUi();
  });
}
/** Pone un video (un archivo del usuario o el fragmento que devolvió el análisis) en el reproductor. */
function attachVideo(src, label, onMeta) {
  if (S.videoUrl && S.videoUrl.startsWith('blob:')) URL.revokeObjectURL(S.videoUrl);
  pause(); S.hasVideo = false;
  S.videoUrl = src; video.src = src;
  video.onloadedmetadata = () => {
    S.hasVideo = true; $('videoEmpty').hidden = true;
    const b = S.bundle.clip, ratio = video.videoWidth / video.videoHeight, want = b.width / b.height, notes = [];
    if (Math.abs(ratio - want) / want > 0.02) notes.push(`el video tiene otra proporción (${video.videoWidth}×${video.videoHeight}) que el análisis (${b.width}×${b.height}): las capas no calzarán`);
    if (video.duration + 1e-6 < S.project.videoOffset + b.frames / b.fps - 0.1) notes.push(`el video dura ${es(fmt(video.duration, 1))} s y el análisis necesita ${es(fmt(S.project.videoOffset + b.frames / b.fps, 1))} s: ajusta el desfase`);
    if (!S.analysis || !S.analysis.running) say(notes.length ? `Video ${label} cargado, pero ${notes.join('; ')}.` : `Video ${label} cargado (se abre en tu navegador).`, notes.length > 0);
    if (onMeta) onMeta();
    seek(S.project.range.start);
  };
  video.onerror = () => { S.hasVideo = false; $('videoEmpty').hidden = false; say('No pude abrir ese video. Prueba con un MP4 (H.264).', true); };
  video.onseeked = () => { if (!S.playing) { S.t = video.currentTime - S.project.videoOffset; render(); } };
  video.onended = () => { if (S.playing) { if ($('loop').checked) seek(S.project.range.start), video.play(); else pause(); } };
}

// ---------------------------------------------------------------- analizar con el motor local
const api = (...a) => fetch(...a);
const anMsg = (text, error = false) => { const m = $('anMsg'); m.textContent = text; m.style.color = error ? 'var(--danger)' : ''; };
const anProgress = (p, text) => { if (p != null) $('anBar').style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`; if (text) anMsg(text); };
function updateAnalyzeUi() {
  const ready = S.engine && S.engine.state === 'ready', running = !!(S.analysis && S.analysis.running), canEdit = ready && !!S.videoFile && !running;
  for (const id of ['anStart', 'anEnd', 'anCamera']) $(id).disabled = !canEdit;
  $('btnAnalyze').disabled = !canEdit || !S.fileDuration; $('btnCancel').hidden = !running;
  const st = $('engineState');
  if (S.engine) { st.textContent = S.engine.message + (ready && !S.videoFile ? ' Elige tu video para analizarlo.' : ''); st.className = 'small ' + (ready ? 'ready' : S.engine.state === 'remote' ? 'muted' : 'bad'); }
}
async function refreshEngine() {
  S.engine = await detectEngine(api, location);
  updateAnalyzeUi();
}
async function analyze() {
  if (!S.videoFile || !S.fileDuration || (S.analysis && S.analysis.running)) return;
  const start = parseFloat($('anStart').value), end = parseFloat($('anEnd').value), problem = analysisRangeProblems(start, end, S.fileDuration, S.engine.maxSeconds);
  if (problem) { anMsg(problem, true); return; }
  const ctl = new AbortController();
  S.analysis = {running: true, ctl, job: null}; $('anAdvice').hidden = true; pause(); updateAnalyzeUi();
  try {
    anProgress(0.02, 'Enviando el video a tu PC (puede tardar si el archivo es grande)…');
    const up = await uploadVideo(S.videoFile, api);
    anProgress(0.1, 'Empezando el análisis…');
    const {job} = await startAnalysis({video: up.id, start, end, cameraType: $('anCamera').value}, api);
    S.analysis.job = job;
    await waitForAnalysis(job, {fetchFn: api, signal: ctl.signal, onProgress: p => anProgress(0.1 + 0.75 * p.progress, p.message)});
    anProgress(0.9, 'Armando el mapa 2D con los 22 jugadores…');
    const bundle = await buildBundle(job, {fetchFn: api, signal: ctl.signal, onProgress: p => anProgress(null, p.message)});
    const bad = bundleProblems(bundle);
    if (bad.length) throw new Error('El motor devolvió un paquete que no entiendo: ' + bad[0] + '.');
    loadBundle(bundle);
    attachVideo(videoUrl(job), '(fragmento analizado)');
    anProgress(1, 'Listo: el mapa 2D está arriba. Revisa que las líneas rojas calcen con las del campo.');
    const advice = calibrationAdvice(bundle.provenance && bundle.provenance.calibration), notes = (bundle.provenance && bundle.provenance.warnings || []).map(w => w.charAt(0).toUpperCase() + w.slice(1) + '.');
    const box = $('anAdvice'); box.hidden = false; box.className = `advice ${advice.trust}`; box.textContent = [advice.text, ...notes].join(' ');
    say(`Análisis terminado: calibración ${advice.level}.`, advice.trust === 'bad');
  } catch (err) {
    anProgress(0, err.name === 'AbortError' ? 'Análisis cancelado.' : err.message);
    if (err.name !== 'AbortError') anMsg(err.message, true);
  } finally { S.analysis.running = false; updateAnalyzeUi(); }
}
$('btnAnalyze').onclick = analyze;
$('btnCancel').onclick = async () => { const a = S.analysis; if (!a) return; a.ctl.abort(); if (a.job) { try { await cancelJob(a.job, api); } catch (e) { /* ya terminó */ } } };

// ---------------------------------------------------------------- eventos
$('btnVideo').onclick = () => $('videoFile').click();
$('videoFile').onchange = e => { const f = e.target.files[0]; if (f && S.bundle) loadVideo(f); e.target.value = ''; };
$('btnBundle').onclick = () => $('bundleFile').click();
$('bundleFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { loadBundle(parseBundle(await f.text())); say(`Paquete «${f.name}» abierto.`); } catch (err) { say(err.message, true); }
};
$('btnSave').onclick = () => {
  if (!S.project) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([serializeProject(S.project)], {type: 'application/json'})); a.download = `fos-studio-${S.bundle.clip.id}.proyecto.json`; a.click(); URL.revokeObjectURL(a.href);
  say('Proyecto guardado: tramo, capas y anotaciones (sin el video).');
};
$('btnOpen').onclick = () => $('projectFile').click();
$('projectFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !S.bundle) return;
  try {
    const p = parseProject(await f.text());
    if (p.clip.id !== S.bundle.clip.id || p.clip.frames !== S.bundle.clip.frames) throw new Error(`Ese proyecto es de otro clip («${p.clip.id}», ${p.clip.frames} cuadros).`);
    S.project = p; persist(); syncControls(); seek(p.range.start); say('Proyecto abierto.');
  } catch (err) { say(err.message, true); }
};
$('btnPlay').onclick = () => (S.playing ? pause() : play());
$('btnPrev').onclick = () => step(-1); $('btnNext').onclick = () => step(1);
$('slider').oninput = e => { pause(); seek(+e.target.value); };
$('rate').onchange = e => { S.rate = +e.target.value; if (S.hasVideo) video.playbackRate = S.rate; };
$('btnRange').onclick = () => {
  const r = setRange(S.project, parseFloat($('rangeStart').value), parseFloat($('rangeEnd').value)), m = $('rangeMsg');
  m.textContent = r.ok ? 'Tramo aplicado.' : r.error; m.classList.toggle('ok', r.ok);
  if (r.ok) { persist(); syncControls(); seek(Math.min(Math.max(S.t, r.range.start), r.range.end)); } else syncControls();
};
$('btnFull').onclick = () => {
  const dur = S.bundle.clip.frames / S.bundle.clip.fps, r = setRange(S.project, 0, Math.min(dur, MAX_ANALYSIS_SECONDS)), m = $('rangeMsg');
  m.textContent = r.ok ? (dur > MAX_ANALYSIS_SECONDS ? `Se tomaron los primeros ${MAX_ANALYSIS_SECONDS} s.` : 'Tramo: todo el clip.') : r.error; m.classList.toggle('ok', r.ok);
  persist(); syncControls(); seek(S.project.range.start);
};
$('videoOffset').onchange = e => { const v = parseFloat(e.target.value); if (isFinite(v) && v >= 0) { S.project.videoOffset = v; persist(); seek(S.t); } else syncControls(); };
document.querySelectorAll('[data-layer]').forEach(c => { c.onchange = () => { S.project.layers[c.dataset.layer] = c.checked; persist(); render(); }; });
$('gain').oninput = e => { S.project.gain = +e.target.value; gainLabel(); persist(); render(); };
function nearestSlot(ev, team = null) {
  const f = frameAt(S.t, S.bundle.clip.fps, S.bundle.clip.frames), [mx, my] = map.toPitch(ev);
  let best = null, bd = 3;   // el más cercano a menos de 3 m
  S.bundle.slots[f].forEach(([x, y], j) => { if (team != null && (j < 11 ? 0 : 1) !== team) return; const d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = j; } });
  return {slot: best, at: [mx, my]};
}
$('map').addEventListener('click', ev => {
  if (!S.bundle) return;
  if (S.armed === 'text') {
    const [x, y] = map.toPitch(ev), r = addTimed({type: 'pitchText', text: $('txtText').value.trim(), x: +x.toFixed(1), y: +y.toFixed(1), size: parseFloat($('txtSize').value), rotation: parseFloat($('txtRot').value), color: $('txtColor').value});
    S.armed = null; armUi(); if (r.ok) $('txtText').value = '';
    return;
  }
  if (S.armed === 'line') {
    const {slot} = nearestSlot(ev, +$('lnTeam').value);
    if (slot != null) { S.picking = S.picking.includes(slot) ? S.picking.filter(j => j !== slot) : [...S.picking, slot]; armUi(); render(); }
    return;
  }
  const {slot} = nearestSlot(ev);
  S.sel = slot === S.sel ? null : slot; render();
});

// ---------------------------------------------------------------- anotaciones
const annMsg = (text, ok = false) => { const m = $('annMsg'); m.textContent = text; m.classList.toggle('ok', ok); };
const slotName = j => { const {team, keeper, number} = slotInfo(j); return `${keeper ? 'Portero' : `Jugador ${number}`} · ${S.bundle.teams[team].name}`; };
/** Ventana por omisión de una anotación nueva: desde este instante hasta el final del tramo (o los últimos 3 s si estamos al final). */
function defaultWindow() { const {start, end} = S.project.range, a = Math.min(Math.max(start, S.t), end - 0.5); return {start: +a.toFixed(2), end: end}; }
function addTimed(partial) {
  const r = addAnnotation(S.project, {...defaultWindow(), ...partial});
  annMsg(r.ok ? 'Anotación agregada.' : r.error, r.ok);
  if (r.ok) { persist(); renderAnnList(); render(); }
  return r;
}
function armUi() {
  $('addText').classList.toggle('armed', S.armed === 'text'); $('addText').textContent = S.armed === 'text' ? 'Toca el mapa…' : 'Colocar en el mapa';
  $('txtHint').textContent = S.armed === 'text' ? 'Toca en el mapa donde va el texto.' : '';
  $('lnPick').classList.toggle('armed', S.armed === 'line'); $('lnPick').textContent = S.armed === 'line' ? 'Terminar de elegir' : 'Elegir en el mapa';
  if (S.armed) $('map').scrollIntoView({block: 'nearest'});   // el formulario está más abajo que el mapa: al armar, se lleva el mapa a la vista para tocarlo
  $('lnMake').disabled = !(S.picking.length >= 2 && S.picking.length <= 6);
  $('lnHint').textContent = S.armed === 'line' ? `Toca los jugadores de ${S.bundle.teams[+$('lnTeam').value].name} (${S.picking.length} elegidos, de 2 a 6).` : S.picking.length ? `${S.picking.length} jugadores elegidos.` : '';
}
$('addSpot').onclick = () => { if (S.sel == null) { annMsg('Primero toca un jugador en el mapa.'); return; } addTimed({type: 'spotlight', slot: S.sel, color: LIME}); };
$('addText').onclick = () => {
  if (S.armed === 'text') { S.armed = null; armUi(); return; }
  if (!$('txtText').value.trim()) { annMsg('Escribe el texto primero.'); return; }
  S.armed = 'text'; S.picking = []; armUi(); annMsg('');
};
$('addFreeze').onclick = () => {
  const r = addAnnotation(S.project, {type: 'freeze', t: +S.t.toFixed(2), duration: parseFloat($('frzDur').value), text: $('frzText').value.trim()});
  annMsg(r.ok ? 'Pausa agregada: se aplica al reproducir.' : r.error, r.ok);
  if (r.ok) { S.consumed.add(r.annotation.id); persist(); renderAnnList(); }
};
$('lnPick').onclick = () => { S.armed = S.armed === 'line' ? null : 'line'; if (S.armed) { S.picking = []; annMsg(''); } armUi(); render(); };
$('lnTeam').onchange = () => { S.picking = []; armUi(); render(); };
$('lnMake').onclick = () => {
  const kind = $('lnKind').value, team = +$('lnTeam').value;
  const r = addTimed({type: 'line', team, name: kind, slots: [...S.picking].sort((a, b) => a - b), color: LINE_COLORS[kind]});
  if (r.ok) { S.picking = []; S.armed = null; armUi(); render(); }
};
function annSummary(a) {
  if (a.type === 'spotlight') return ['REFLECTOR', slotName(a.slot)];
  if (a.type === 'pitchText') return ['TEXTO EN EL CAMPO', `«${a.text}»`];
  if (a.type === 'line') return ['LÍNEA', `${a.name} · ${S.bundle.teams[a.team].name} (${a.slots.length} jugadores)`];
  return ['PAUSA', `${String(a.duration).replace('.', ',')} s${a.text ? ` · «${a.text}»` : ''}`];
}
function renderAnnList() {
  const ol = $('annList'), list = S.project ? S.project.annotations : [];
  $('annEmpty').hidden = list.length > 0; ol.textContent = '';
  for (const a of list) {
    const li = document.createElement('li'), top = document.createElement('div'), [tag, what] = annSummary(a);
    top.className = 'top';
    const label = document.createElement('span'), b = document.createElement('span'); b.className = 'tag'; b.textContent = tag; label.append(b, what);
    const btns = document.createElement('span'), go = document.createElement('button'), del = document.createElement('button');
    for (const [btn, text] of [[go, 'Ir'], [del, 'Borrar']]) { btn.type = 'button'; btn.className = 'mini'; btn.textContent = text; }
    go.onclick = () => { pause(); seek(a.type === 'freeze' ? a.t : a.start); };
    del.onclick = () => { removeAnnotation(S.project, a.id); persist(); renderAnnList(); render(); annMsg('Anotación borrada.', true); };
    btns.append(go, ' ', del); top.append(label, btns);
    const times = document.createElement('div'); times.className = 'times';
    const fields = a.type === 'freeze' ? [['t', 'En el segundo', a.t], ['duration', 'Dura (s)', a.duration]] : [['start', 'Desde (s)', a.start], ['end', 'Hasta (s)', a.end]];
    for (const [key, name, value] of fields) {
      const lab = document.createElement('label'), inp = document.createElement('input');
      inp.type = 'number'; inp.step = '0.1'; inp.value = String(+value.toFixed(2)); inp.setAttribute('aria-label', `${name} de ${tag.toLowerCase()}`);
      inp.onchange = () => { const r = updateAnnotation(S.project, a.id, {[key]: parseFloat(inp.value)}); annMsg(r.ok ? 'Cambio aplicado.' : r.error, r.ok); if (r.ok) persist(); renderAnnList(); render(); };
      lab.append(name + ' ', inp); times.append(lab);
    }
    li.append(top, times); ol.append(li);
  }
}
function captionUi() {
  const c = $('caption');
  if (!S.freeze) { c.hidden = true; return; }
  const left = Math.max(0, (S.freeze.until - performance.now()) / 1000);
  c.hidden = false; c.textContent = '';
  if (S.freeze.a.text) { const t = document.createElement('span'); t.textContent = S.freeze.a.text; c.append(t); }
  const n = document.createElement('span'); n.className = 'count'; n.textContent = `⏸ ${Math.ceil(left)} s`; c.append(n);
}

window.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range') return;
  if (e.key === ' ') { e.preventDefault(); S.playing ? pause() : play(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
});
new ResizeObserver(() => render()).observe($('map'));

// ---------------------------------------------------------------- arranque: el clip de demostración (solo posiciones en metros)
(async () => {
  try {
    const res = await fetch('demo/javier-correa.bundle.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadBundle(parseBundle(await res.text()));
    say('Clip de demostración cargado. Elige tu video para ver las capas sobre la imagen, o usa solo el mapa 2D.');
  } catch (err) { $('clipTitle').textContent = 'Sin clip'; say(`No pude cargar el clip de demostración (${err.message}). Usa «Abrir paquete».`, true); }
})();
refreshEngine();
window.fosStudio = {state: S, seek, play, pause, render, addAnnotation: partial => addTimed(partial)};   // para las pruebas en el navegador
