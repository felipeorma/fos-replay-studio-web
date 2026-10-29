import {parseTime, playbackRange, cameraLabel, isVideo, displayTime, privatePCOrigin, readPrivatePC, savePrivatePC, forgetPrivatePC, privatePCDashboard} from './pages-core.js?v=3f8c7c600687d4dca360bcf54437da4cbaa0e7875a3772906779c1fcb094f0c6';
const $ = id => document.getElementById(id), preview = $('preview');
let videoURL = null, frameReady = null, sourceRevision = 0, opening = false;
const notice = (text, error = false) => { $('setupStatus').textContent = text; $('setupStatus').classList.toggle('error', error); };
function flow(stage, text, error = false) {
  const current = {load: 0, analyze: 1, ready: 2}[stage] ?? 0;
  ['stepLoad', 'stepAnalyze', 'step2D'].forEach((id, index) => {
    const step = $(id); if (!step) return;
    step.dataset.state = index < current ? 'complete' : index === current ? 'active' : 'pending';
    if (index === current) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
  });
  if ($('pipelineStatus')) { $('pipelineStatus').textContent = text; $('pipelineStatus').classList.toggle('error', error); }
}
function selectedRange() { return playbackRange($('fromTime').value, $('toTime').value, preview.duration); }
const endpointTime = seconds => displayTime(Math.floor(seconds * 100) / 100);
function updateRange() {
  for (const id of ['videoFile', 'trackingFiles', 'cameraFile', 'fromTime', 'toTime', 'cameraType']) $(id).disabled = opening;
  for (const id of ['markStart', 'markEnd']) if ($(id)) $(id).disabled = !videoURL || !Number.isFinite(preview.duration) || opening;
  try {
    const range = selectedRange();
    for (const button of document.querySelectorAll('[data-clip-seconds]')) button.setAttribute('aria-pressed', String(range.end === range.start + Number(button.dataset.clipSeconds)));
    if ($('clipDuration')) { $('clipDuration').textContent = `${+(range.end - range.start).toFixed(2)} s / 30 s`; $('clipDuration').classList.remove('error'); }
    $('previewButton').disabled = !videoURL || opening; $('openButton').disabled = !videoURL || opening;
  } catch (error) {
    for (const button of document.querySelectorAll('[data-clip-seconds]')) button.setAttribute('aria-pressed', 'false');
    if ($('clipDuration')) { $('clipDuration').textContent = videoURL ? error.message : 'Hasta 30 segundos'; $('clipDuration').classList.toggle('error', !!videoURL); }
    $('previewButton').disabled = true; $('openButton').disabled = true;
  }
}
function chooseVideo(f) {
  if (!isVideo(f)) { notice('Selecciona un archivo de video compatible.', true); return; }
  ++sourceRevision; opening = false;
  document.body.dataset.workspace = 'closed';
  $('trackingFiles').value = ''; $('cameraFile').value = '';
  $('workspace').hidden = true;
  $('analystFrame').src = 'about:blank'; frameReady = null;
  preview.pause(); $('previewButton').disabled = true;
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(f); preview.src = videoURL;
  if ($('previewEmpty')) $('previewEmpty').hidden = true;
  $('videoMetadata').textContent = f.name;
  $('openButton').disabled = true;
  notice('Leyendo el video en este dispositivo…');
  flow('load', 'Leyendo el archivo. Todavía no hay detecciones.');
}
$('videoFile').onchange = () => chooseVideo($('videoFile').files[0]);
preview.addEventListener('loadedmetadata', () => {
  if (!Number.isFinite(preview.duration) || preview.duration <= 0) return notice('No pude leer la duración de este video.', true);
  $('fromTime').value = '0:00'; $('toTime').value = endpointTime(Math.min(30, preview.duration));
  $('videoMetadata').textContent = `${preview.videoWidth} × ${preview.videoHeight} · duración ${displayTime(preview.duration)} · se conserva la proporción original`;
  updateRange(); notice('Video listo. Revisa hasta 30 segundos. Para detectar jugadores y líneas, abre el análisis en tu PC.');
  flow('analyze', 'Elige el tramo. El análisis automático se ejecuta en tu PC privado.');
});
preview.addEventListener('error', () => { notice('El navegador no puede reproducir este archivo. Prueba MP4 H.264/AAC.', true); $('previewButton').disabled = true; $('openButton').disabled = true; flow('load', 'El formato de video no pudo abrirse.', true); });
for (const id of ['fromTime', 'toTime']) $(id).addEventListener('input', updateRange);
for (const button of document.querySelectorAll('[data-clip-seconds]')) button.addEventListener('click', () => {
  try { const start = parseTime($('fromTime').value); $('toTime').value = endpointTime(Math.min(preview.duration, start + Number(button.dataset.clipSeconds))); updateRange(); }
  catch { notice('Selecciona primero un video y un inicio válido.', true); }
});
if ($('markStart')) $('markStart').onclick = () => { $('fromTime').value = endpointTime(preview.currentTime); $('toTime').value = endpointTime(Math.min(preview.duration, preview.currentTime + 30)); updateRange(); };
if ($('markEnd')) $('markEnd').onclick = () => { $('fromTime').value = endpointTime(Math.max(0, preview.currentTime - 30)); $('toTime').value = endpointTime(preview.currentTime); updateRange(); };
if ($('dropzone')) {
  for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.add('dragging'); });
  for (const name of ['dragleave', 'drop']) $('dropzone').addEventListener(name, event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); });
  $('dropzone').addEventListener('drop', event => {
    const files = event.dataTransfer.files;
    if (!isVideo(files[0])) return notice('Selecciona un archivo de video compatible.', true);
    $('videoFile').files = files; chooseVideo(files[0]);
  });
}
preview.addEventListener('timeupdate', () => {
  try { const range = selectedRange(); if (!preview.paused && preview.currentTime >= range.end) preview.pause(); } catch { /* incomplete input */ }
});
$('previewButton').onclick = async () => {
  try { const range = selectedRange(); preview.currentTime = range.start; await preview.play(); } catch (e) { notice(e.message, true); }
};
function getAnalyst() {
  if (!frameReady) {
    const revision = sourceRevision;
    frameReady = new Promise((resolve, reject) => {
      const frame = $('analystFrame');
      const cleanup = () => { clearTimeout(timer); frame.removeEventListener('load', loaded); frame.removeEventListener('error', failed); };
      const failed = () => { cleanup(); if (revision === sourceRevision) frameReady = null; reject(new Error('No se pudo iniciar Analyst. Vuelve a abrir el 2D.')); };
      const loaded = () => {
        if (frame.contentWindow?.fosPages) { cleanup(); resolve(frame.contentWindow.fosPages); }
        else failed();
      };
      const timer = setTimeout(failed, 20000);
      frame.addEventListener('load', loaded); frame.addEventListener('error', failed);
      frame.src = 'analyst.html?v=3f8c7c600687d4dca360bcf54437da4cbaa0e7875a3772906779c1fcb094f0c6';
    });
  }
  return frameReady;
}
$('setupForm').onsubmit = async event => {
  event.preventDefault();
  if (opening) return;
  const revision = sourceRevision;
  try {
    const video = $('videoFile').files[0]; if (!isVideo(video)) throw new Error('Selecciona primero un video.');
    const range = selectedRange(), type = $('cameraType').value; cameraLabel(type);
    const tracking = [...$('trackingFiles').files], camera = $('cameraFile').files[0] || null;
    opening = true; preview.pause(); updateRange(); $('workspace').hidden = false;
    notice('Abriendo los archivos locales en Analyst…');
    const analyst = await getAnalyst();
    if (revision !== sourceRevision) return;
    const opened = await analyst.open({video, tracking, camera, range, type});
    if (revision !== sourceRevision) return;
    const hasTracking = tracking.length > 0;
    const unavailable = opened?.calibration?.kind === 'unavailable';
    document.body.dataset.workspace = 'open';
    $('workspaceNote').textContent = `${cameraLabel(type)} · ${displayTime(range.start)}–${displayTime(range.end)} · ${unavailable ? 'sin calibración: no hay posiciones 2D confirmadas' : hasTracking ? 'tracking importado, calidad pendiente de tus datos' : 'video sin detecciones: añade tracking para ver jugadores 2D'}`;
    notice(unavailable ? 'Video abierto, pero falta calibración: este tracking no contiene posiciones 2D. Los archivos siguen en tu dispositivo.' : 'Abierto. El video y los datos no se han subido. Guarda o exporta tus anotaciones antes de cerrar.', unavailable);
    flow(hasTracking && !unavailable ? 'ready' : 'analyze', unavailable ? opened.calibration.detail : hasTracking ? '2D abierto con tracking importado. Revisa su calibración.' : 'Video abierto. Faltan detecciones: analiza con tu PC o importa tracking.', unavailable);
    $('workspace').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (e) { if (revision === sourceRevision) { notice(e.message, true); flow('analyze', e.message, true); $('workspace').hidden = true; document.body.dataset.workspace = 'closed'; } }
  finally { if (revision === sourceRevision) { opening = false; updateRange(); } }
};
addEventListener('pagehide', () => { if (videoURL) URL.revokeObjectURL(videoURL); });

function setupPrivatePC() {
  const input = $('privatePCUrl'), link = $('privatePCOpen'), status = $('privatePCStatus');
  const message = (text, error = false) => { status.textContent = text; status.classList.toggle('error', error); };
  const hide = () => { link.hidden = true; link.removeAttribute('href'); };
  const show = origin => {
    link.setAttribute('href', privatePCDashboard(origin));
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    link.hidden = false;
  };
  hide();
  try {
    const saved = readPrivatePC(localStorage);
    if (saved) { input.value = saved; show(saved); message('Dirección guardada en este navegador. Abre tu PC para analizar.'); }
  } catch { message('No se pudo recuperar una dirección privada válida. Puedes introducirla de nuevo.', true); }
  input.addEventListener('input', () => { hide(); message('Guarda la dirección para abrir el análisis en tu PC.'); });
  $('privatePCForm').addEventListener('submit', event => {
    event.preventDefault(); hide();
    try {
      const validated = privatePCOrigin(input.value);
      let saved;
      try { saved = savePrivatePC(localStorage, validated); }
      catch { message('Este navegador no permite guardar la dirección. Habilita el almacenamiento local para este sitio y vuelve a intentarlo.', true); return; }
      input.value = saved; show(saved); message('Dirección guardada sólo en este navegador. El análisis se abre en tu PC.');
    } catch (error) { message(error.message, true); }
  });
  $('privatePCForget').addEventListener('click', () => {
    hide(); input.value = '';
    try { forgetPrivatePC(localStorage); message('Dirección eliminada de este navegador.'); }
    catch { message('No se pudo borrar el almacenamiento. Elimina los datos de este sitio desde tu navegador.', true); }
  });
}
setupPrivatePC();
updateRange();
flow('load', 'Carga un video. Selecciona una jugada de hasta 30 segundos.');
