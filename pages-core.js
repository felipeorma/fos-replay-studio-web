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
  if (end > duration + 0.05) throw new Error('El tramo supera la duración del video.');
  return {start, end: Math.min(end, duration)};
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
