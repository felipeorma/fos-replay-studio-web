// FOS Studio · paquete de análisis (fos-studio-bundle/1): lo que sale de tools/studio/export_bundle.py. Aquí se valida y se carga; nada se sube a ningún sitio.

export const BUNDLE_SCHEMA = 'fos-studio-bundle/1';

/** Revisa que un paquete tenga la forma esperada. Devuelve la lista de problemas (vacía = bien). */
export function bundleProblems(b) {
  const bad = [];
  if (!b || typeof b !== 'object') return ['el archivo no es un objeto JSON'];
  if (b.schema !== BUNDLE_SCHEMA) bad.push(`esquema ${JSON.stringify(b.schema)} (se esperaba ${BUNDLE_SCHEMA})`);
  const c = b.clip || {};
  if (!(c.fps > 0)) bad.push('clip.fps inválido');
  if (!(c.frames > 0)) bad.push('clip.frames inválido');
  if (!(c.width > 0 && c.height > 0)) bad.push('clip.width/height inválidos');
  if (!b.pitch || b.pitch.length !== 105 || b.pitch.width !== 68) bad.push('la cancha debe ser de 105 × 68 m');
  if (!Array.isArray(b.teams) || b.teams.length !== 2) bad.push('faltan los dos equipos');
  for (const key of ['H', 'slots', 'ball', 'referee', 'assistants']) {
    if (!Array.isArray(b[key])) bad.push(`falta «${key}»`);
    else if (c.frames > 0 && b[key].length !== c.frames) bad.push(`«${key}» tiene ${b[key].length} cuadros y el clip ${c.frames}`);
  }
  if (!bad.length) {
    const s = b.slots[0];
    if (!Array.isArray(s) || s.length !== 22 || s.some(p => !Array.isArray(p) || p.length !== 5 || p.some(v => typeof v !== 'number' || !isFinite(v)))) bad.push('cada cuadro debe traer 22 casillas de 5 números [x, y, visto, radio, velocidad]');
    const h = b.H.find(Boolean);
    if (h && (h.length !== 9 || h.some(v => typeof v !== 'number' || !isFinite(v)))) bad.push('una homografía no tiene 9 números válidos');
  }
  return bad;
}

export function parseBundle(text) {
  let b;
  try { b = JSON.parse(text); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
  const bad = bundleProblems(b);
  if (bad.length) throw new Error('Paquete de análisis no válido: ' + bad.slice(0, 3).join('; ') + '.');
  return b;
}

/** Rol de una casilla: portero (0 y 11) o jugador de campo del equipo que le toca. */
export const slotInfo = j => ({team: j < 11 ? 0 : 1, keeper: j === 0 || j === 11, number: j < 11 ? j : j - 11});
