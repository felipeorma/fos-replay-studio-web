// FOS Studio · geometría. Funciones puras (sin DOM) para pasar entre la cancha en metros y la imagen del video con la homografía de cada cuadro.
// Convención: H lleva un píxel de la imagen a metros (x a lo largo, 0–105; y a lo ancho, 0–68), 9 números por filas, como los guarda el paquete.

export const L = 105, W = 68;

/** Inversa de una matriz 3×3 (9 números por filas). null si es singular. */
export function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (!det || !isFinite(det)) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** Aplica la homografía a un punto: [x', y'] o null si cae en el infinito. */
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return Math.abs(w) < 1e-12 ? null : [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** Proyecta un punto de la cancha (m) a la imagen con la inversa Hinv. Devuelve null si el punto queda detrás de la cámara (w de otro signo que el del centro de la imagen). */
export function toImage(Hinv, x, y, wSign = 1) {
  const w = Hinv[6] * x + Hinv[7] * y + Hinv[8];
  if (Math.abs(w) < 1e-12 || Math.sign(w) !== wSign) return null;
  const px = (Hinv[0] * x + Hinv[1] * y + Hinv[2]) / w, py = (Hinv[3] * x + Hinv[4] * y + Hinv[5]) / w;
  return Math.abs(px) < 8000 && Math.abs(py) < 8000 ? [px, py] : null;
}

/** Signo de w al llevar a la imagen un punto de la cancha que sí se ve (el que cae en el centro de la imagen). */
export function wSignOf(H, Hinv, vw, vh) {
  const c = applyH(H, vw / 2, vh * 0.7);
  if (!c) return 1;
  const w = Hinv[6] * c[0] + Hinv[7] * c[1] + Hinv[8];
  return w < 0 ? -1 : 1;
}

/** Sutherland–Hodgman: recorta un polígono [[x, y], ...] con el rectángulo [x0, y0, x1, y1]. */
export function clipPolygon(poly, x0, y0, x1, y1) {
  const edges = [[p => p[0] >= x0, (a, b) => { const t = (x0 - a[0]) / (b[0] - a[0]); return [x0, a[1] + t * (b[1] - a[1])]; }],
    [p => p[0] <= x1, (a, b) => { const t = (x1 - a[0]) / (b[0] - a[0]); return [x1, a[1] + t * (b[1] - a[1])]; }],
    [p => p[1] >= y0, (a, b) => { const t = (y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y0]; }],
    [p => p[1] <= y1, (a, b) => { const t = (y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y1]; }]];
  let out = poly;
  for (const [inside, cross] of edges) {
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const a = inp[i], b = inp[(i + 1) % inp.length], ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) out.push(cross(a, b));
    }
    if (!out.length) break;
  }
  return out;
}

/** Lo que ve la cámara sobre la cancha: el polígono de la imagen (sin la franja de arriba, que es el público) llevado a metros y recortado a la cancha. [] si no hay. */
export function footprint(H, vw, vh) {
  if (!H) return [];
  const corners = [[0, 0.14 * vh], [vw, 0.14 * vh], [vw, 0.995 * vh], [0, 0.995 * vh]].map(p => applyH(H, p[0], p[1]));
  if (corners.some(c => !c)) return [];
  const poly = clipPolygon(corners, 0, 0, L, W);
  return poly.length >= 3 ? poly : [];
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Marcas de la cancha como polilíneas en metros (puntos cada ~0,5 m, para que la perspectiva las curve bien). */
export function pitchLines() {
  const dense = pts => {
    const out = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1], n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 0.5));
      for (let i = 0; i < n; i++) out.push([ax + (bx - ax) * i / n, ay + (by - ay) * i / n]);
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  const lines = [
    [[0, 0], [L, 0], [L, W], [0, W], [0, 0]], [[L / 2, 0], [L / 2, W]],
    [[0, 13.84], [16.5, 13.84], [16.5, 54.16], [0, 54.16]], [[L, 13.84], [L - 16.5, 13.84], [L - 16.5, 54.16], [L, 54.16]],
    [[0, 24.84], [5.5, 24.84], [5.5, 43.16], [0, 43.16]], [[L, 24.84], [L - 5.5, 24.84], [L - 5.5, 43.16], [L, 43.16]],
  ].map(dense);
  const circle = [];
  for (let i = 0; i <= 48; i++) circle.push([L / 2 + 9.15 * Math.cos(i / 48 * 2 * Math.PI), W / 2 + 9.15 * Math.sin(i / 48 * 2 * Math.PI)]);
  lines.push(circle);
  for (const [cx, sgn] of [[11, 1], [L - 11, -1]]) {   // los semicírculos de las áreas: solo la parte fuera del área grande
    const arc = [];
    for (let i = 0; i <= 30; i++) {
      const a = -0.93 + 1.86 * i / 30, x = cx + sgn * 9.15 * Math.cos(a);
      if (sgn > 0 ? x > 16.5 : x < L - 16.5) arc.push([x, W / 2 + 9.15 * Math.sin(a)]);
    }
    if (arc.length > 1) lines.push(arc);
  }
  return lines;
}

/** Cuadro (0…n-1) que corresponde a un instante del clip. */
export const frameAt = (t, fps, n) => Math.min(n - 1, Math.max(0, Math.round(t * fps)));

// ---------------------------------------------------------------- texto «escrito en el campo»
/** Producto de matrices 3×3 (9 números por filas). */
export function mul3(a, b) {
  const o = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return o;
}

/** De un píxel de la textura del texto (u, v; tw × th px) a metros sobre la cancha: centrado en (x, y), de `size` m de alto y girado `rotation` grados (la v crece hacia abajo = y crece). */
export function textureToMetres(x, y, size, rotation, tw, th) {
  const s = size / th, r = rotation * Math.PI / 180, c = Math.cos(r), n = Math.sin(r), cu = tw / 2, cv = th / 2;
  return [s * c, -s * n, x - s * (cu * c - cv * n), s * n, s * c, y - s * (cu * n + cv * c), 0, 0, 1];
}

/** Homografía de la textura a píxeles CSS del cuadro de video (cw × ch) con la inversa Hinv de la homografía de ese cuadro (vw × vh = tamaño del análisis). null si el texto cae detrás de la cámara. */
export function textHomography(Hinv, wSign, text, tw, th, vw, vh, cw, ch) {
  const A = textureToMetres(text.x, text.y, text.size, text.rotation, tw, th);
  for (const [u, v] of [[0, 0], [tw, 0], [tw, th], [0, th]]) {   // las cuatro esquinas deben estar delante de la cámara
    const mx = A[0] * u + A[1] * v + A[2], my = A[3] * u + A[4] * v + A[5];
    if (!toImage(Hinv, mx, my, wSign)) return null;
  }
  return mul3([cw / vw, 0, 0, 0, ch / vh, 0, 0, 0, 1], mul3(Hinv, A));
}

/** Una homografía 3×3 como `matrix3d` de CSS (por columnas; el navegador hace la perspectiva). */
export function cssMatrix3d(M) {
  const n = M[8] || 1, h = M.map(v => v / n);
  return `matrix3d(${[h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, 1].map(v => +v.toPrecision(10)).join(',')})`;
}

// ---------------------------------------------------------------- líneas de jugadores
/** Una línea (defensa, medio, delantera): los jugadores ordenados de banda a banda, la distancia media a su propio arco y el ancho. attack = hacia dónde ataca el equipo (+1: hacia x = 105). */
export function lineMetrics(points, attack) {
  const pts = [...points].sort((a, b) => a[1] - b[1]);
  const own = p => (attack > 0 ? p[0] : L - p[0]);
  return {points: pts, depth: pts.reduce((s, p) => s + own(p), 0) / pts.length, width: pts[pts.length - 1][1] - pts[0][1]};
}
