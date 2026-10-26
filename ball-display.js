// Legacy detector imports need temporal evidence before a ball is drawn.
// Manual/stadium data without confidences and already checked notebook output are preserved.
export function confirmBallFrames(frames, cuts = [], {anchorConf = .25, supportS = .35, maxGapS = .3, maxSpeed = 55} = {}) {
  if (!frames.some(f => f.b && !f.b.quality_checked && f.b.est !== 'interpolado' && Number.isFinite(f.b.conf))) return frames;
  const out = frames.map(f => ({...f, b: null})), segments = new Map();
  const boundaries = [...cuts].sort((a, b) => a - b);
  frames.forEach((f, i) => {
    if (!f.b || f.b.est === 'interpolado') return;
    const segment = boundaries.filter(c => c <= f.f).length;
    if (!segments.has(segment)) segments.set(segment, []);
    segments.get(segment).push({i, t: f.t, b: f.b});
  });
  let trajectory = 0;
  const conf = p => Number.isFinite(p.b.conf) ? p.b.conf : 1;
  const speed = (a, b) => b.t > a.t ? Math.hypot(b.b.x-a.b.x, b.b.y-a.b.y)/(b.t-a.t) : Infinity;
  for (const observations of segments.values()) {
    const anchors = observations.filter(p => conf(p) >= anchorConf);
    let kept = observations.filter(p => {
      if (conf(p) >= anchorConf) return true;
      let j = 0; while (j < anchors.length && anchors[j].t <= p.t) j++;
      const left = anchors[j-1], right = anchors[j]; let a, b;
      if (left && right && p.t-left.t <= supportS && right.t-p.t <= supportS) [a, b] = [left, right];
      else if (left && anchors[j-2] && p.t-left.t <= .2 && left.t-anchors[j-2].t <= .15) [a, b] = [anchors[j-2], left];
      else if (right && anchors[j+1] && right.t-p.t <= .2 && anchors[j+1].t-right.t <= .15) [a, b] = [right, anchors[j+1]];
      if (!a || speed(a, b) > maxSpeed) return false;
      const u = (p.t-a.t)/(b.t-a.t), x = a.b.x+u*(b.b.x-a.b.x), y = a.b.y+u*(b.b.y-a.b.y);
      return Math.hypot(p.b.x-x, p.b.y-y) <= .8+2*Math.min(Math.abs(p.t-a.t), Math.abs(p.t-b.t));
    });
    const rejected = new Set();
    for (let j=1; j<kept.length-1; j++) {
      const [a,p,b] = kept.slice(j-1,j+2);
      if (b.t-a.t <= maxGapS && speed(a,p)>maxSpeed && speed(p,b)>maxSpeed && speed(a,b)<=maxSpeed) rejected.add(j);
    }
    kept = kept.filter((_,j) => !rejected.has(j));
    const groups = [];
    for (const p of kept) {
      const last = groups.at(-1)?.at(-1);
      if (!last || p.t-last.t>maxGapS+1e-9 || speed(last,p)>maxSpeed) groups.push([]);
      groups.at(-1).push(p);
    }
    for (const group of groups) {
      if (group.length<2 || !group.some(p=>conf(p)>=anchorConf)) continue;
      trajectory++;
      for (const p of group) out[p.i].b = {...p.b, trajectory_id: trajectory, quality_checked: true};
      for (let j=1;j<group.length;j++) {
        const a=group[j-1], b=group[j];
        for (let i=a.i+1;i<b.i;i++) {
          const u=(frames[i].t-a.t)/(b.t-a.t);
          out[i].b={x:a.b.x+u*(b.b.x-a.b.x),y:a.b.y+u*(b.b.y-a.b.y),est:'interpolado',conf:0,trajectory_id:trajectory,quality_checked:true};
        }
      }
    }
  }
  return out;
}
