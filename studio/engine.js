// FOS Studio · cliente del motor de análisis local. El motor es el servidor de este mismo proyecto (python3 server.py) corriendo en TU computador: detecta la cancha, los jugadores,
// el árbitro, el balón y las camisetas (dashboard_jobs.py) y arma el paquete del mapa 2D (studio_jobs.py). La página solo le habla al mismo origen; en una página publicada
// (GitHub Pages) no hay motor y el botón explica cómo abrir Studio desde el PC. El video solo se envía a ese servidor local, nunca a internet.
import {MAX_ANALYSIS_SECONDS} from './project.js';

/** Solo se habla con un servidor que es de este PC: localhost o un nombre privado de Tailscale (.ts.net). */
export const canUseEngine = loc => /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(loc.hostname) || loc.hostname.endsWith('.ts.net');

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Cancelado', 'AbortError')); }, {once: true});
});

async function call(fetchFn, url, opts) {
  let res;
  try { res = await fetchFn(url, opts); } catch (e) { if (e.name === 'AbortError') throw e; throw new Error('No pude hablar con el motor de análisis de tu PC.'); }
  let body = null;
  try { body = await res.json(); } catch (e) { /* sin cuerpo JSON */ }
  if (!res.ok) throw new Error((body && body.error) || `El motor respondió ${res.status}.`);
  return body;
}

/** ¿Hay motor? Devuelve {state: remote|offline|noenv|ready, message, maxSeconds}. */
export async function detectEngine(fetchFn, loc) {
  if (!canUseEngine(loc)) return {state: 'remote', message: 'Para analizar un video, abre Studio desde tu PC (python3 server.py y luego http://127.0.0.1:8000/studio/): el motor de detección corre en tu computador, no en esta página.'};
  try { await call(fetchFn, '/api/health'); } catch (e) { return {state: 'offline', message: 'No encuentro el motor de análisis. Inícialo con «python3 server.py» y abre esta página desde ese servidor.'}; }
  try {
    const env = await call(fetchFn, '/api/dashboard/env');
    if (!env || !env.ready) return {state: 'noenv', message: 'El motor está encendido pero falta el entorno de tracking (.venv_fos). Prepáralo con «Abrir_FOS.bat --prepare-only».'};
    return {state: 'ready', message: 'Motor de análisis listo en tu PC.', maxSeconds: Math.min(MAX_ANALYSIS_SECONDS, env.max_duration_s || MAX_ANALYSIS_SECONDS)};
  } catch (e) { return {state: 'offline', message: e.message}; }
}

/** Problemas de un tramo a analizar dentro de un archivo de `duration` s (vacío = bien). */
export function analysisRangeProblems(start, end, duration, max = MAX_ANALYSIS_SECONDS) {
  if (![start, end, duration].every(v => typeof v === 'number' && isFinite(v))) return 'Escribe «Desde» y «Hasta» en segundos.';
  if (start < 0 || end > duration + 1e-9) return `El tramo debe estar dentro del video (0–${duration.toFixed(1)} s).`;
  if (end < start + 1) return 'El tramo debe durar al menos 1 s.';
  if (end > start + max + 1e-9) return `Un tramo nuevo dura como máximo ${max} s.`;
  return '';
}

export const uploadVideo = (file, fetchFn) => call(fetchFn, `/api/dashboard/upload?name=${encodeURIComponent(file.name)}`, {method: 'POST', body: file, headers: {'Content-Type': 'application/octet-stream'}});
export const startAnalysis = (req, fetchFn) => call(fetchFn, '/api/dashboard/analyze', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({video: req.video, start: req.start, end: req.end, camera_type: req.cameraType || 'tv', device: 'auto'})});
export const cancelJob = (job, fetchFn) => call(fetchFn, `/api/dashboard/cancel?job=${encodeURIComponent(job)}`, {method: 'POST'});
export const videoUrl = job => `/api/dashboard/result?job=${encodeURIComponent(job)}&file=video`;

/** Espera a que termine un análisis. onProgress({progress 0–1, message}). Lanza si falla o se cancela. */
export async function waitForAnalysis(job, {fetchFn, onProgress = () => {}, signal, intervalMs = 1500}) {
  for (;;) {
    const st = await call(fetchFn, `/api/dashboard/status?job=${encodeURIComponent(job)}`, {signal});
    onProgress({progress: st.progress || 0, message: st.message || ''});
    if (st.status === 'done') return st;
    if (st.status === 'failed') throw new Error(st.error || st.message || 'El análisis falló.');
    if (st.status === 'cancelled') throw new DOMException('Cancelado', 'AbortError');
    await sleep(intervalMs, signal);
  }
}

/** Pide el paquete del mapa 2D de un análisis terminado, espera su conversión y lo descarga. */
export async function buildBundle(job, {fetchFn, onProgress = () => {}, signal, intervalMs = 1500}) {
  await call(fetchFn, `/api/studio/bundle?job=${encodeURIComponent(job)}`, {method: 'POST', signal});
  for (;;) {
    const st = await call(fetchFn, `/api/studio/status?job=${encodeURIComponent(job)}`, {signal});
    onProgress({message: st.message || ''});
    if (st.status === 'done') break;
    if (st.status === 'failed') throw new Error(st.message || 'No pude armar el mapa 2D.');
    await sleep(intervalMs, signal);
  }
  return call(fetchFn, `/api/studio/bundle?job=${encodeURIComponent(job)}`, {signal});
}

/** Lo que la calidad de la calibración le dice a quien mira: {level, text, trust}. */
export function calibrationAdvice(calibration) {
  if (!calibration || !calibration.level) return {level: 'sin informe', trust: 'unknown', text: 'El análisis no informó la calidad de la calibración: revisa que las líneas rojas calcen con las del campo.'};
  if (calibration.level === 'buena') return {level: 'buena', trust: 'good', text: 'Calibración buena: aun así, mira que las líneas rojas calcen con las del campo.'};
  if (calibration.level === 'débil') return {level: 'débil', trust: 'weak', text: 'Calibración débil: las posiciones pueden estar corridas. Revisa las líneas rojas sobre el video antes de usar el mapa.'};
  return {level: 'mala', trust: 'bad', text: 'Calibración mala: las posiciones no son fiables. No las uses para medir distancias.'};
}
