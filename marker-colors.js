// Marker styles are presentation preferences; they never classify a shirt.
const valid = value => /^#[0-9a-f]{6}$/i.test(value || '');
export function markerColor(player, teams = {}, colors = {}) {
  const team = player.team;
  if (player.ref || ['arbitro', 'referee'].includes(player.role))
    return valid(colors.referee) ? colors.referee : '#f5cb43';
  if (['portero', 'goalkeeper', 'keeper'].includes(player.role))
    return valid(colors[`goalkeeper${team}`]) ? colors[`goalkeeper${team}`] : '#9ba7ae';
  if (valid(colors[`team${team}`])) return colors[`team${team}`];
  return valid(teams?.[team]?.color) ? teams[team].color : ['#3f8fd2', '#e8780f'][team] || '#888888';
}
