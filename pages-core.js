/** File selection and playback range only. No inference or upload. */
export function parseTime(value) {
  const s = String(value).trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(s)) throw new Error('Usa segundos, min:seg o h:min:seg.');
  const parts = s.split(':').map(Number);
  if (parts.some(x => !Number.isFinite(x)) || parts.slice(1).some(x => x >= 60)) throw new Error('Los segundos y minutos internos deben ser menores que 60.');
  return parts.reduce((a, b) => a * 60 + b, 0);
}
export function playbackRange(from, to, duration) {
  const start = parseTime(from), end = parseTime(to);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Espera a que el navegador lea la duración del video.');
  if (start >= end) throw new Error('El final debe ser posterior al inicio.');
  if (end < start + 1 || end > start + 30) throw new Error('Elige un fragmento de 1 a 30 segundos.');
  if (end > duration) throw new Error('El tramo supera la duración del video.');
  return {start, end};
}
export function cameraLabel(type) {
  if (!['tv', 'tactical'].includes(type)) throw new Error('Selecciona TV o cámara táctica.');
  return type === 'tv' ? 'Transmisión TV' : 'Cámara táctica';
}
export function isVideo(file) {
  return !!file && (String(file.type).startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name));
}
export function displayTime(seconds) {
  const hundredths = Math.max(0, Math.round(seconds * 100));
  return `${Math.floor(hundredths / 6000)}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')}`;
}

/** A private PC address is a DNS HTTPS origin, never a credential or API URL. */
export function privatePCOrigin(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  const match = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net)\/?$/i.exec(input);
  if (!match || match[1].length > 253) throw new Error('Introduce la dirección HTTPS de tu PC terminada en .ts.net, sin puerto, ruta, usuario ni parámetros.');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw new Error('Usa sólo la dirección principal HTTPS de tu PC.');
  return url.origin;
}

export const PRIVATE_PC_STORAGE_KEY = 'fos.privatePC.origin.v1';

export function readPrivatePC(storage) {
  const saved = storage.getItem(PRIVATE_PC_STORAGE_KEY);
  return saved === null ? '' : privatePCOrigin(saved);
}

export function savePrivatePC(storage, value) {
  const origin = privatePCOrigin(value);
  storage.setItem(PRIVATE_PC_STORAGE_KEY, origin);
  return origin;
}

export function forgetPrivatePC(storage) {
  storage.removeItem(PRIVATE_PC_STORAGE_KEY);
}

export function privatePCDashboard(value) {
  return `${privatePCOrigin(value)}/dashboard.html`;
}
