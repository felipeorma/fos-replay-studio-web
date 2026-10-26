// The lines of players the analyst makes by clicking on them (the defence, the midfield, the forwards...) and the numbers and names he gives to the players.
// Nothing here knows about the page: a unit is {id, team, kind, name, color, ids, on}; `ids` are the numbers of the players as the display layer (display.js) gives them, so a player who the
// tracker renumbers stays in his line. The tracker's numbers mean nothing to a person: the analyst writes the shirt number and the name himself.

export const KINDS = [{kind: 'def', name: 'Defensa'}, {kind: 'mid', name: 'Mediocampo'}, {kind: 'fwd', name: 'Delantera'}, {kind: 'custom', name: 'Línea'}];
export const PALETTE = ['#ffffff', '#ffd23f', '#ff7ab2', '#7dffb3', '#b794ff', '#7cc4ff'];   // on grass or on the coloured space, these stay readable

/** A new, empty line for `team`: the next free colour, and a name that is not taken ("Defensa", "Defensa 2"...). */
export function newUnit(units, team, kind = 'custom') {
  const base = (KINDS.find(k => k.kind === kind) || KINDS[3]).name, mine = units.filter(u => u.team === team), taken = new Set(mine.map(u => u.name));
  let name = base, n = 2; while (taken.has(name)) name = `${base} ${n++}`;
  const used = new Set(mine.map(u => u.color)), color = PALETTE.find(c => !used.has(c)) || PALETTE[mine.length % PALETTE.length];
  const id = 1 + units.reduce((m, u) => Math.max(m, u.id), 0);
  return {id, team, kind, name, color, ids: [], on: true};
}

/** Adds the player to the line, or takes him out if he is in it; false (and nothing done) when he plays for the other team. Returns 'added', 'removed' or false. A player is in one line at a time of a kind: he can be in the defence and in a "Línea" of his own, not in two defences. */
export function toggleMember(units, unit, key, team) {
  if (team !== unit.team) return false;
  const at = unit.ids.indexOf(key); if (at >= 0) { unit.ids.splice(at, 1); return 'removed'; }
  if (unit.kind !== 'custom') for (const u of units) if (u !== unit && u.team === unit.team && u.kind === unit.kind) { const k = u.ids.indexOf(key); if (k >= 0) u.ids.splice(k, 1); }
  unit.ids.push(key); return 'added';
}

/** The line as it is in the frame `fr`: the members who are on the pitch now, from one touchline to the other, with the mean place (`x`), its distance from the own goal (`depth`, the team attacks towards `dir`: 1 is +x) and the width of the line. Null with fewer than one visible. */
export function unitShape(fr, unit, {dir = 1, L = 105} = {}) {
  const set = new Set(unit.ids), members = fr.p.filter(q => set.has(q.id) && q.team === unit.team).sort((a, b) => a.y - b.y);
  if (!members.length) return null;
  const x = members.reduce((s, q) => s + q.x, 0) / members.length, ys = members.map(q => q.y);
  return {members, visible: members.length, total: unit.ids.length, x, depth: dir >= 0 ? x : L - x, width: members.length > 1 ? ys[ys.length - 1] - ys[0] : 0};
}

/** What to write for a player: `inner` goes inside his circle (the shirt number he was given, or the last digits of the tracker's number) and `below` under it (his name, his speed in km/h). `look` is {num, name, speed} where `speed` is 'off', 'lines' (only the players of a line the analyst made) or 'all'; `inLine` says the player is in one. */
export function labelOf(names, q, look = {}, inLine = false) {
  const w = names && names[q.id] || {}, inner = look.num === false ? '' : (w.num ? String(w.num).slice(0, 3) : (String(q.id).length > 3 ? String(q.id).slice(-3) : String(q.id)));
  const below = [];
  if (look.name !== false && w.name) below.push(String(w.name).slice(0, 24));
  if ((look.speed === 'all' || look.speed === true || (look.speed === 'lines' && inLine)) && Number.isFinite(q.s)) below.push(`${Math.round(q.s * 3.6)} km/h`);
  return {inner, below, named: !!(w.num || w.name)};
}

/** The names of players as the analyst typed them, cleaned: a number of up to 3 characters and a name of up to 24; nothing at all removes the entry. */
export function setPlayer(names, key, {num, name}) {
  const n = String(num ?? '').trim().slice(0, 3), m = String(name ?? '').trim().slice(0, 24);
  if (!n && !m) delete names[key]; else names[key] = {...(n ? {num: n} : {}), ...(m ? {name: m} : {})};
  return names[key] || null;
}

/** What goes into the saved project and what comes back out of it (the ids of a line mean nothing once the data is another one, so the page empties them then). */
export const pack = (units, names, look) => ({units: units.map(u => ({...u, ids: [...u.ids]})), names: {...names}, look: {...look}});
export function unpack(p = {}) {
  const units = (p.units || []).filter(u => u && (u.team === 0 || u.team === 1)).map(u => ({id: u.id | 0, team: u.team, kind: u.kind || 'custom', name: String(u.name || 'Línea').slice(0, 24), color: u.color || PALETTE[0], ids: (u.ids || []).map(String), on: u.on !== false}));
  return {units, names: p.names && typeof p.names === 'object' ? {...p.names} : {}, look: {num: false, name: true, measure: true, ...(p.look || {}), speed: ['all', 'lines'].includes(p.look && p.look.speed) ? p.look.speed : p.look && p.look.speed === true ? 'all' : 'off'}};
}
