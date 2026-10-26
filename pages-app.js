import {playbackRange, cameraLabel, isVideo, displayTime, privatePCOrigin, readPrivatePC, savePrivatePC, forgetPrivatePC, privatePCDashboard} from './pages-core.js';
const $ = id => document.getElementById(id), preview = $('preview');
let videoURL = null, frameReady = null;
const notice = (text, error = false) => { $('setupStatus').textContent = text; $('setupStatus').classList.toggle('error', error); };
function selectedRange() { return playbackRange($('fromTime').value, $('toTime').value, preview.duration); }
$('videoFile').onchange = () => {
  const f = $('videoFile').files[0];
  if (!isVideo(f)) { notice('Selecciona un archivo de video compatible.', true); return; }
  preview.pause(); $('previewButton').disabled = true;
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(f); preview.src = videoURL;
  notice('Leyendo el video en este dispositivo…');
};
preview.addEventListener('loadedmetadata', () => {
  if (!Number.isFinite(preview.duration) || preview.duration <= 0) return notice('No pude leer la duración de este video.', true);
  $('fromTime').value = '0:00'; $('toTime').value = displayTime(Math.min(60, preview.duration));
  $('videoMetadata').textContent = `${preview.videoWidth} × ${preview.videoHeight} · duración ${displayTime(preview.duration)} · se conserva la proporción original`;
  $('previewButton').disabled = false; notice('Video listo. Puedes reproducir el tramo o añadir tracking para el mapa 2D.');
});
preview.addEventListener('error', () => notice('El navegador no puede reproducir este archivo. Prueba MP4 H.264/AAC.', true));
preview.addEventListener('timeupdate', () => {
  try { const range = selectedRange(); if (!preview.paused && preview.currentTime >= range.end) preview.pause(); } catch { /* incomplete input */ }
});
$('previewButton').onclick = async () => {
  try { const range = selectedRange(); preview.currentTime = range.start; await preview.play(); } catch (e) { notice(e.message, true); }
};
function getAnalyst() {
  if (!frameReady) {
    frameReady = new Promise((resolve, reject) => {
      const frame = $('analystFrame');
      frame.addEventListener('load', () => {
        if (frame.contentWindow.fosPages) resolve(frame.contentWindow.fosPages);
        else { frameReady = null; reject(new Error('No se pudo iniciar Analyst. Recarga la página.')); }
      }, {once: true});
      frame.src = 'analyst.html';
    });
  }
  return frameReady;
}
$('setupForm').onsubmit = async event => {
  event.preventDefault();
  try {
    const video = $('videoFile').files[0]; if (!isVideo(video)) throw new Error('Selecciona primero un video.');
    const range = selectedRange(), type = $('cameraType').value; cameraLabel(type);
    preview.pause(); $('openButton').disabled = true; $('workspace').hidden = false;
    notice('Abriendo los archivos locales en Analyst…');
    const analyst = await getAnalyst();
    await analyst.open({video, tracking: [...$('trackingFiles').files], camera: $('cameraFile').files[0] || null, range, type});
    const hasTracking = $('trackingFiles').files.length > 0;
    $('workspaceNote').textContent = `${cameraLabel(type)} · ${displayTime(range.start)}–${displayTime(range.end)} · ${hasTracking ? 'tracking importado, calidad pendiente de tus datos' : 'video sin detecciones: añade tracking para ver jugadores 2D'}`;
    notice('Abierto. El video y los datos no se han subido. Guarda o exporta tus anotaciones antes de cerrar.');
    $('workspace').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (e) { notice(e.message, true); }
  finally { $('openButton').disabled = false; }
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
