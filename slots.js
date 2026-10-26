// The eleven of each team, always on the pitch (tools/tracking/team_state.py makes the data): twenty-two slots that never appear or disappear. A slot is a position of the team, not a person with a
// name: it follows a player while he is in view (`vis` 1) and is estimated, with a radius of doubt, while he is not (`vis` 0). Between two steps everything is a straight line, and `vis` too, so a
// marker goes from solid to hollow and back through every shade, never with a pop.

export const N = 11;
export const slotId = m => `${m < N ? 'A' : 'B'}${m % N + 1}`;          // 'A1' is the goalkeeper of team 0, 'B7' the seventh slot of team 1
export const slotLabel = m => m % N === 0 ? 'POR' : String(m % N + 1);   // what is written inside the circle until the analyst gives the player a number

/** The slots of a stretch ready to search: {t: Float64Array, d: Float32Array (steps × 22 × 4: x, y, vis, r), n}. Null when the file has no steps or they are not 22 slots. */
export function prepareSlots(raw) {
  const fr = raw && raw.frames;
  if (!fr || !fr.length || !fr[0].s || fr[0].s.length !== 2 * N) return null;
  const t = new Float64Array(fr.length), d = new Float32Array(fr.length * 2 * N * 4),
    velocity = fr.every(f=>Array.isArray(f.v)&&f.v.length===2*N) ? new Float32Array(fr.length*2*N*2) : null,
    active = new Uint8Array(fr.length*2*N);
  for (let i = 0; i < fr.length; i++) {
    if(!Number.isFinite(fr[i].t)||(i&&fr[i].t<=fr[i-1].t)||fr[i].s?.length!==2*N)return null;
    t[i] = fr[i].t;
    for (let m = 0; m < 2 * N; m++) {
      const s = fr[i].s[m], o = (i * 2 * N + m) * 4;
      if(s?.length!==4||!s.every(Number.isFinite))return null;
      d[o] = s[0]; d[o + 1] = s[1]; d[o + 2] = s[2]; d[o + 3] = s[3];
      active[i*2*N+m]=fr[i].active?.[m]===false?0:1;
      if(velocity){const v=fr[i].v[m],k=(i*2*N+m)*2;if(v?.length!==2||!v.every(Number.isFinite))return null;velocity[k]=v[0];velocity[k+1]=v[1];}
    }
  }
  return {t, d, velocity, active, evidence:fr.map(f=>f.e||null), phases:fr.map(f=>f.phase||null),
    segments:fr.map(f=>f.segment_id??null), interpolable:fr.map(f=>f.interpolate_from_previous!==false),
    discontinuities:fr.map(f=>f.clock_discontinuity||null),
    n: fr.length, tracks: raw.tracks || null, policy:raw.policy||null};
}

/** The index of the last step at or before `t` (0 before the first). */
export function stepAt(sl, t) {
  let lo = 0, hi = sl.n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (sl.t[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}

/** The twenty-two slots at time `t`, between two steps: [{slot, id, team, x, y, est, r, s}] where `est` goes from 0 (in view) to 1 (estimated), `r` is the radius of doubt in metres and `s` the speed in m/s
 *  (from the two steps; 0 when estimated). Past the ends of the data the first or last step. A hole of more than `hold` seconds between two steps is not drawn across: the earlier step is held. */
export function slotsAt(sl, t, hold = 2.5) {
  const i = stepAt(sl, t), j = Math.min(i + 1, sl.n - 1), t0 = sl.t[i], t1 = sl.t[j];
  const continuous=sl.interpolable?.[j]!==false&&(!sl.segments||sl.segments[i]===sl.segments[j]);
  const u = continuous&&t1 > t0 && t > t0 && t1 - t0 <= hold ? Math.min(1, (t - t0) / (t1 - t0)) : 0, out = [];
  for (let m = 0; m < 2 * N; m++) {
    if(sl.active&&sl.active[i*2*N+m]===0)continue;
    const a = (i * 2 * N + m) * 4, b = (j * 2 * N + m) * 4, d = sl.d;
    let x = d[a] + (d[b] - d[a]) * u, y = d[a + 1] + (d[b + 1] - d[a + 1]) * u;
    const vis = d[a + 2] + (d[b + 2] - d[a + 2]) * u, r = d[a + 3] + (d[b + 3] - d[a + 3]) * u;
    const dt = t1 - t0, both = d[a + 2] > .5 && d[b + 2] > .5 && dt > 0 && dt <= .5;
    let speed=both?Math.min(12,Math.hypot(d[b]-d[a],d[b+1]-d[a+1])/dt):0;
    if(continuous&&sl.velocity&&dt>0&&dt<=hold&&t>=t0&&t<=t1){
      const k=(i*2*N+m)*2,l=(j*2*N+m)*2,v=sl.velocity;
      const u2=u*u,u3=u2*u,h00=2*u3-3*u2+1,h10=u3-2*u2+u,h01=-2*u3+3*u2,h11=u3-u2;
      const axis=(p0,p1,v0,v1)=>h00*p0+h10*dt*v0+h01*p1+h11*dt*v1;
      const derivative=(p0,p1,v0,v1)=>((6*u2-6*u)*p0+(-6*u2+6*u)*p1)/dt+(3*u2-4*u+1)*v0+(3*u2-2*u)*v1;
      x=axis(d[a],d[b],v[k],v[l]);y=axis(d[a+1],d[b+1],v[k+1],v[l+1]);
      speed=Math.hypot(derivative(d[a],d[b],v[k],v[l]),derivative(d[a+1],d[b+1],v[k+1],v[l+1]));
    }
    const evidence=sl.evidence?.[i]?.[m];
    out.push({slot: m, id: slotId(m), team: m < N ? 0 : 1, x, y, est: 1 - vis, r, s:speed,
      ...(evidence?{position_source:evidence.source,evidence_state:evidence.evidence_state,
        last_observed_at:evidence.last_observed_at,identity_status:'anonymous_slot_hypothesis',
        observation:evidence.observation,occupant_generation:evidence.occupant_generation,
        estimated_speed:true,phase:sl.phases?.[i],clock_discontinuity:sl.discontinuities?.[i],
        segment_id:sl.segments?.[i]}:{})});
  }
  return out;
}

/** {tracker number -> slot id} from the file ('tracks': {track: slot}), for the tables that still speak of the tracker's numbers. */
export const slotOfTrack = (sl, tid) => sl && sl.tracks && sl.tracks[tid] !== undefined ? slotId(sl.tracks[tid]) : null;
