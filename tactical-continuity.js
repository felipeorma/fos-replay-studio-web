// A virtual tactical VIEW, never a fabricated camera calibration or observation.
// The retrospective view moves only reviewed, one-to-one cross-camera identities.
// Unmatched people retain a dated snapshot, not an unconfirmed moving identity.
import {reconstructionFrames, reconstructionKey, reconstructionTracks, reconstructBridge, validatedMotionWindow,reviewedObservationWindow} from './camera-reconstruction.js?v=3f8c7c600687d4dca360bcf54437da4cbaa0e7875a3772906779c1fcb094f0c6';
import {buildMotionCurve} from './motion-model.js?v=3f8c7c600687d4dca360bcf54437da4cbaa0e7875a3772906779c1fcb094f0c6';
import {mlState} from './prediction_ml.js?v=3f8c7c600687d4dca360bcf54437da4cbaa0e7875a3772906779c1fcb094f0c6';

const dist = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const inside = p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x>=0 && p.x<=105 && p.y>=0 && p.y<=68;
const unique = players => {
  const out=[];
  // A reviewed bidirectional identity has priority over a causal forecast.
  for (const p of [...players].sort((a,b)=>(a.kind==='bridge'?-1:0)-(b.kind==='bridge'?-1:0))) {
    if (!inside(p) || out.some(q=>
        (p.roster_id&&q.roster_id===p.roster_id)||
        (p.continuity_id && q.continuity_id===p.continuity_id) ||
        (!p.roster_id&&!q.roster_id&&p.before_key&&q.before_key===p.before_key))) continue;
    out.push(p);
  }
  return out;
};
const empty = reason => ({players:[],mode:'sin_evidencia',reason,
  uncertainty_m:null,viewport:'full_pitch',source:'no_evidence'});

/** Causal, camera/identity-separated social context for the existing forest. */
export function continuityModelContext(raw, tracks) {
  const data={frames:(raw.frames||[]).map(()=>({p:[]}))}, modelTracks=new Map();
  for (const [key, points] of tracks) {
    const series=points.map(p=>({...p,id:key}));
    modelTracks.set(key,series);
    for (const p of series) data.frames[p.i]?.p.push(p);
  }
  return {data,tracks:modelTracks};
}

function slopeSample(points,t0,t1) {
  const dt=t1-t0, a=reconstructBridge(points.before,points.after,t0), b=reconstructBridge(points.before,points.after,t1);
  if (!a || !b) return null;
  return {vx:dt>0?(b.x-a.x)/dt:0,vy:dt>0?(b.y-a.y)/dt:0};
}
function bridgeCurve(before,after) {
  const anchor=before.at(-1), end=after[0], duration=end.t-anchor.t;
  const n=Math.max(1,Math.ceil(duration*60)), samples=[];
  for(let k=0;k<=n;k++) {
    const h=duration*k/n, t=anchor.t+h, p=reconstructBridge(before,after,t);
    const v=slopeSample({before,after},Math.max(anchor.t,t-1/120),Math.min(end.t,t+1/120));
    if (!p || !v) return null;
    samples.push({t:h,h_s:h,x:p.x,y:p.y,...v});
  }
  return {samples,source:'reviewed_retrospective_bridge',diagnostics:{anchor_t:anchor.t}};
}

const roleOf = player => {
  if (player.ref || player.is_referee===true || String(player.is_referee).toLowerCase()==='true' || player.cls===2) return 'arbitro';
  const role=player.rol||player.role||'jugador';
  return role==='goalkeeper'?'portero':role==='player'?'jugador':role;
};
const scopeOf = p => JSON.stringify([p.segment,String(p.id),p.identity_segment??null,p.team,p.role]);

/** A reviewed link joins complete measured track runs, never a bare tracker ID.
 * The runs keep role/team/identity changes and reused same-camera IDs separated. */
function reviewedIdentities(reconstruction,tracks,diagnostics,raw) {
  const entries=[...tracks.entries()].map(([node,points])=>({node,points,first:points[0],last:points.at(-1)}));
  const proposed=[];
  for (const gap of reconstruction?.gaps||[]) {
    if (!gap.eligible || gap.status!=='approved' || !(gap.duration_s>0&&gap.duration_s<=3+1e-9)) continue;
    for (const link of gap.associations||[]) {
      if (link.status!=='accepted' || link.reasons?.length) continue;
      const before=(gap.before||[]).find(p=>p.key===link.beforeKey),after=(gap.after||[]).find(p=>p.key===link.afterKey);
      const a=before&&entries.find(e=>e.last.key===before.key&&Math.abs(e.last.t-before.t)<1e-8);
      const b=after&&entries.find(e=>e.first.key===after.key&&Math.abs(e.first.t-after.t)<1e-8);
      const reject=reason=>diagnostics.push({gap_id:gap.id,before_key:link.beforeKey,after_key:link.afterKey,reason});
      if (!a || !b) {reject('enlace_sin_tramos_medidos_actuales');continue;}
      if (a.last.team!==b.first.team || a.last.role!==b.first.role ||
          a.last.segment===b.first.segment || !(b.first.t>a.last.t&&b.first.t-a.last.t<=3+1e-9)) {
        reject('enlace_fuera_de_ambito_equipo_rol_camara_o_tiempo');continue;
      }
      const path=link.motion_path&&raw.return_continuity_review?.reviewed_motion_window===true
        ?validatedMotionWindow(link.motion_path,a.points,b.points):null;
      if(link.motion_path&&!path){reject('ventana_de_movimiento_obsoleta_o_no_revisada');continue;}
      const curve=path?.samples?.length?{samples:path.samples.map(p=>({...p,t:p.t-path.start_s})),
        source:'reviewed_motion_window',diagnostics:{window_s:path.window_s,
          max_observation_deviation_m:path.max_observation_deviation_m}}:bridgeCurve(a.points,b.points);
      if (!curve) {reject('enlace_sin_puente_de_movimiento_factible');continue;}
      proposed.push({gap,link:path?{...link,motion_path:path}:link,a,b,curve,type:'camera_cut_bridge',source:'validated_reconstruction_association'});
    }
  }
  // Explicitly reviewed, short same-camera tracker fragments establish identity
  // only. They do not interpolate or assert C1 motion between noisy observations.
  for(const link of raw?.identity_continuation_review?.links||[]) {
    const beforeKey=link.before_key??link.beforeKey,afterKey=link.after_key??link.afterKey;
    const id=`fragment:${link.before_frame}:${link.after_frame}:${beforeKey}:${afterKey}`;
    const reject=reason=>diagnostics.push({fragment_id:id,before_key:beforeKey,after_key:afterKey,reason});
    if((link.status??link.review_status)!=='assistant_reviewed'||!link.evidence||!link.reviewer||!link.source) {
      reject('fragmento_sin_revision_y_proveniencia_explicita');continue;
    }
    const a=entries.find(e=>e.last.key===beforeKey&&e.last.f===link.before_frame),
      b=entries.find(e=>e.first.key===afterKey&&e.first.f===link.after_frame);
    if(!a||!b){reject('fragmento_sin_extremos_medidos_exactos');continue;}
    const duration=b.first.t-a.last.t;
    if(a.node===b.node||a.last.segment!==b.first.segment||a.last.team!==b.first.team||a.last.role!==b.first.role||
        !(duration>0&&duration<=.5+1e-9)) {
      reject('fragmento_fuera_de_ambito_equipo_rol_camara_o_tiempo');continue;
    }
    const interposed=entries.some(entry=>entry!==a&&entry!==b&&entry.first.segment===a.last.segment&&
      (entry.first.key===beforeKey||entry.first.key===afterKey)&&
      entry.points.some(p=>p.t>=a.last.t-1e-9&&p.t<=b.first.t+1e-9));
    if(interposed){reject('fragmento_con_identidad_interpuesta_o_ocupada');continue;}
    proposed.push({gap:{id},link:{beforeKey,afterKey,provenance:{status:'assistant_reviewed',
      evidence:link.evidence,reviewer:link.reviewer,source:link.source}},a,b,curve:null,
      type:'fragment_continuation',source:'reviewed_fragment_continuation'});
  }
  // Reject every edge in a conflicting assignment, rather than choosing by order.
  const edges=proposed.filter(edge=>{
    const conflict=proposed.some(other=>other!==edge&&(other.a.node===edge.a.node||other.b.node===edge.b.node));
    if (conflict) diagnostics.push({gap_id:edge.gap.id,before_key:edge.link.beforeKey,after_key:edge.link.afterKey,reason:'identidad_canonica_no_uno_a_uno'});
    return !conflict;
  });
  const parent=new Map(), nodes=new Map();
  const root=node=>{let p=node;while(parent.has(p))p=parent.get(p);return p;};
  for(const edge of edges.sort((a,b)=>a.a.last.t-b.a.last.t)) {
    nodes.set(edge.a.node,edge.a);nodes.set(edge.b.node,edge.b);
    parent.set(root(edge.b.node),root(edge.a.node));
  }
  const idFor=node=>{
    const first=nodes.get(root(node)).first;
    return `continuity:${JSON.stringify([first.segment,first.id,first.identity_segment??null,first.team,first.role,first.f])}`;
  };
  const identity_map=[...nodes.values()].map(entry=>({continuity_id:idFor(entry.node),
    key:entry.first.key,scope:scopeOf(entry.first),segment:entry.first.segment,raw_id:entry.first.id,
    identity_segment:entry.first.identity_segment??null,team:entry.first.team,role:entry.first.role,
    start_s:entry.first.t,end_s:entry.last.t,start_frame:entry.first.f,end_frame:entry.last.f,
    source:'reviewed_identity_graph'}));
  const identity_links=edges.map(edge=>({continuity_id:idFor(edge.a.node),gap_id:edge.gap.id,
    before_key:edge.link.beforeKey,after_key:edge.link.afterKey,
    before_frame:edge.a.last.f,after_frame:edge.b.first.f,start_s:edge.a.last.t,end_s:edge.b.first.t,
    team:edge.a.last.team,role:edge.a.last.role,status:'accepted',
    type:edge.type,source:edge.source,
    ...(edge.link.provenance?{provenance:edge.link.provenance}:{})}));
  return {identity_map,identity_links,edges};
}

/** Add a derived stable identity to current measured observations. The caller
 * supplies the current raw frame/clock; id, rid, coordinates and roles stay intact.
 * Unreviewed, reused or role/team-changed identities receive no canonical label. */
export function annotateContinuityObserved(report,players,{segment,t,frame}={}) {
  const hasFrame=Number.isFinite(frame),hasTime=Number.isFinite(t);
  return (players||[]).map(player=>{
    const p={...player};delete p.continuity_id;delete p.roster_id;
    const camera=Number.isFinite(segment)?segment:player.segment;
    if (!Number.isFinite(camera) || (!hasFrame&&!hasTime)) return p;
    const id=String(player.track_id??player.rid??player.id),role=roleOf(player),team=Number(player.team);
    if (![0,1].includes(team)||!['jugador','portero'].includes(role)) return p;
    const key=reconstructionKey(player,camera),scope=JSON.stringify([camera,id,player.identity_segment??null,team,role]);
    const bindings=(report?.identity_map||[]).filter(binding=>binding.key===key&&binding.scope===scope&&
      (hasFrame?frame>=binding.start_frame&&frame<=binding.end_frame:
        t>=binding.start_s-1e-9&&t<=binding.end_s+1/(report.fps||25)-1e-9));
    if (bindings.length===1) p.continuity_id=bindings[0].continuity_id;
    const roster=(report?.roster_identity_map||[]).filter(binding=>binding.key===key&&binding.scope===scope&&
      (hasFrame?frame>=binding.start_frame&&frame<=binding.end_frame:
        t>=binding.start_s-1e-9&&t<=binding.end_s+1/(report.fps||25)-1e-9));
    if(roster.length===1){p.roster_id=roster[0].roster_id;if(roster[0].continuity_id)p.continuity_id=roster[0].continuity_id;}
    return p;
  });
}

/** Map positions from a reviewed fit remain derived estimates, separate from
 * raw detections. Preserve raw IDs, teams, measured positions and camera. */
export function continuityFrame(report,frame,{segment,t=frame.t}={}) {
  const positionStates={reviewed_motion_window:'smoothed_estimate_from_reviewed_detections',
    reviewed_retrospective_bridge:'retrospective_estimate_from_reviewed_detections',
    reviewed_fragment_interpolation:'interpolated_estimate_from_reviewed_identity_fragment',
    reviewed_fragment_motion_window:'smoothed_estimate_from_reviewed_identity_fragment'};
  const state=continuityAt(report,t),candidates=state.players.filter(p=>Object.hasOwn(positionStates,p.source));
  const map=players=>annotateContinuityObserved(report,players,{segment,t,frame:frame.f}).filter(p=>
    !(report.roster_review?.view_exclusions||[]).some(r=>r.key===reconstructionKey(p,segment)&&r.frames.includes(frame.f))&&
    !(report.roster_identity_map||[]).some(b=>b.key===reconstructionKey(p,segment)&&b.scope===JSON.stringify([segment,String(p.rid??p.id),p.identity_segment??null,p.team,roleOf(p)])&&
      frame.f>b.end_frame&&b.end_frame<Math.round(b.end_s*(report.fps||25)))) .map(p=>{
    const key=reconstructionKey(p,segment);
    const q=candidates.find(q=>(q.before_key===key||q.after_key===key)&&q.team===p.team&&q.role===roleOf(p));
    if(!q)return p;
    return {...p,observed_x:p.x,observed_y:p.y,x:q.x,y:q.y,s:q.s,
      continuity_id:q.continuity_id,position_source:q.source,
      position_state:positionStates[q.source],position_correction_m:dist(p,q)};
  });
  const p=map(frame.p||[]),o=map(frame.o||[]),seen=new Set();
  return {...frame,p:p.filter(q=>{if(!q.roster_id)return true;if(seen.has(q.roster_id))return false;seen.add(q.roster_id);return true;}),o};
}

function persistentRoster(report,tracks,frames,fps) {
  const review=report.roster_review,entries=[...tracks.values()].map((points,i)=>({points,i,start:points[0].f,end:points.at(-1).f})),events=new Map(),bindings=[],parent=entries.map(e=>e.i);
  const root=i=>{while(parent[i]!==i)i=parent[i];return i;};
  const canonicalOf=e=>report.identity_map.find(b=>b.scope===scopeOf(e.points[0])&&
    b.start_frame===e.points[0].f&&b.end_frame===e.points.at(-1).f)?.continuity_id;
  report.reviewed_roster_links=[];
  if(review?.status==='assistant_reviewed'&&review.reviewer&&review.source)for(const link of review.links||[]) {
    if(link.status!=='assistant_reviewed'||!link.evidence)continue;
    const find=(key,f,identity,side)=>{
      const candidates=entries.filter(e=>e.points[0].key===key&&
        (identity===undefined||e.points[0].identity_key===identity)&&
        f>=e.points[0].f&&(f<=e.points.at(-1).f||side==='before'&&f-e.points.at(-1).f<=fps*.5));
      const exact=candidates.filter(e=>e.points.some(p=>p.f===f));
      return exact.length?exact:candidates;
    };
    const a=find(link.before_key,link.before_frame,link.before_identity_key,'before'),
      b=find(link.after_key,link.after_frame,link.after_identity_key,'after');
    if(a.length!==1||b.length!==1||a[0]===b[0])continue;
    const aa=a[0],bb=b[0],p=aa.points[0],q=bb.points[0],gap=(link.after_frame-link.before_frame)/fps;
    if(p.segment!==q.segment||p.team!==q.team||p.role!==q.role||!(gap>=0&&gap<=3)||
      (link.team!==undefined&&link.team!==p.team)||(link.role!==undefined&&link.role!==p.role))continue;
    const ca=entries.filter(e=>root(e.i)===root(aa.i)).map(canonicalOf).filter(Boolean),
      cb=entries.filter(e=>root(e.i)===root(bb.i)).map(canonicalOf).filter(Boolean);
    if(new Set([...ca,...cb]).size>1)continue;
    parent[root(bb.i)]=root(aa.i);
    if(!link.alias_only){aa.end=Math.min(aa.end,link.before_frame);aa.displayEnd=Math.max(aa.end,link.after_frame-1);bb.start=Math.max(bb.start,link.after_frame);}
    report.reviewed_roster_links.push({...link,identity_only:true,hidden_motion_authorized:false});
  }
  const groupInfo=new Map();
  for(const e of entries) {
    const r=root(e.i);if(!groupInfo.has(r))groupInfo.set(r,{entries:[],canonical:[]});
    groupInfo.get(r).entries.push(e);const c=canonicalOf(e);if(c)groupInfo.get(r).canonical.push(c);
  }
  for(const entry of entries) {
    const points=entry.points,first=points[0],last=points.at(-1),group=groupInfo.get(root(entry.i)),
      canonical=group.canonical[0],groupFirst=group.entries.map(e=>e.points[0]).sort((a,b)=>a.t-b.t)[0];
    // An isolated box cannot become a permanent extra player. A reviewed
    // identity or a supported same-shot run supplies evidence for the register.
    if(!canonical&&group.entries.length===1&&!group.entries.some(e=>e.points.length>=8&&e.points.at(-1).t-e.points[0].t>=.5-1e-9))continue;
    const id=canonical||`seen:${JSON.stringify([groupFirst.segment,groupFirst.id,groupFirst.identity_segment??null,groupFirst.team,groupFirst.role,groupFirst.f])}`;
    bindings.push({key:first.key,scope:scopeOf(first),segment:first.segment,raw_id:first.id,
      team:first.team,role:first.role,start_frame:entry.start,end_frame:entry.displayEnd??entry.end,
      start_s:first.t,end_s:last.t,roster_id:id,continuity_id:canonical??null});
    for(const point of points) {
      if(point.f<entry.start||point.f>entry.end||(review?.view_exclusions||[]).some(r=>r.key===point.key&&r.frames.includes(point.f)))continue;
      if(!events.has(point.f))events.set(point.f,[]);
      events.get(point.f).push({id:`remembered:${id}`,roster_id:id,
        ...(canonical?{continuity_id:canonical}:{}),before_key:point.key,
        source_track_id:point.source_track_id,team:point.team,role:point.role,
        x:point.x,y:point.y,state:'ultimo_estado',source:'last_known_snapshot',kind:'snapshot',
        t_observed:point.t,observed_frame:point.f,observed_segment:point.segment,
        uncertainty_m:null,uncertainty_kind:'not_current_position',identity_status:canonical?'reviewed':'camera_scoped_unresolved'});
    }
  }
  report.roster_identity_map=bindings;
  const latest=new Map();report.roster_timeline=[];
  for(let i=0;i<frames.length;i++) {
    const frame=frames[i],f=Number(frame.frame??frame.f??i),t=Number(frame.t??f/fps);
    for(const p of events.get(f)||[])latest.set(p.roster_id,p);
    report.roster_timeline.push({frame:f,t,players:[...latest.values()].map(p=>({...p}))});
  }
  report.roster_policy={enabled:true,mode:'retain_supported_seen_identities',
    observations_are:'actual detections; missing points are dated historical states, never fabricated detections',
    automatic_cross_camera_identity:false,minimum_unreviewed_observations:8,minimum_unreviewed_span_s:.5,
    start_s:Number(frames[0].t??0),end_s:Number(frames.at(-1).t??(frames.length-1)/fps)+1/fps};
}

/** Derived artifact: raw tracking, exclusions, ball and homographies stay intact. */
export function buildContinuity(raw,reconstruction,options={}) {
  const fps=Number(raw.fps)||25, frames=raw.frames||[], tracks=reconstructionTracks(raw,options);
  const model=['retrospective','bounded_velocity','learned'].includes(options.model)?options.model:'retrospective';
  const report={version:1,method:'virtual_tactical_continuity',fps,display_hz:60,
    model,viewport:'full_pitch',max_horizon_s:3,training_started:false,
    limitations:['El modelo estima únicamente personas vistas; solo conserva identidad entre cámaras mediante enlaces aceptados y uno a uno.',
      'En modo retrospectivo, las personas sin enlace confirmado conservan su último estado fechado; no se pronostica su identidad o movimiento.',
      'La cámara virtual es una vista fija del mapa, no una huella TV o homografía estimada.',
      'Una instantánea conserva su tiempo observado; no es posición actual durante celebración/repetición.',
      'Incertidumbre heurística y geometría aproximada, sin confianza probabilística calibrada.'],
    segments:[],diagnostics:[],identity_links:[],identity_map:[],scene_evidence:options.sceneEvidence||null};
  if(!frames.length) return report;
  const identities=reviewedIdentities(reconstruction,tracks,report.diagnostics,raw);
  if(options.rosterReview)report.roster_review=options.rosterReview;
  report.identity_links=identities.identity_links;report.identity_map=identities.identity_map;
  const context=options.weights?continuityModelContext(raw,tracks):null;
  const atFrame=new Map();
  for(const points of tracks.values()) for(const p of points) {
    if(!atFrame.has(p.f)) atFrame.set(p.f,[]);
    atFrame.get(p.f).push(p);
  }
  const timeOf=(fr,i)=>Number(fr.t??i/fps), numberOf=(fr,i)=>Number(fr.frame??fr.f??i);
  const evidence=new Map(reconstructionFrames(raw,options).map(fr=>[fr.f,fr]));
  const usable=(fr,i)=>{
    const frame=evidence.get(numberOf(fr,i));
    return frame?.calibrated===true&&!frame.quality.bad;
  };
  let previous=null;
  for(let i=0;i<frames.length;i++) {
    const f=numberOf(frames[i],i), observations=atFrame.get(f)||[];
    if(usable(frames[i],i)) { if(observations.length) previous={i,f,t:timeOf(frames[i],i),players:observations}; continue; }
    const begin=i;
    while(i+1<frames.length&&!usable(frames[i+1],i+1)) i++;
    if(!previous) continue;
    const right=frames[i+1], lastTime=timeOf(frames[i],i)+1/fps;
    const originalGap=(reconstruction?.gaps||[]).find(g=>g.missing_start_frame===numberOf(frames[begin],begin));
    // No VLM prediction can grant live-continuity approval or establish identity.
    const approved=originalGap?.eligible && originalGap.status==='approved' &&
      Number.isFinite(originalGap.duration_s) && originalGap.duration_s<=3+1e-9;
    const snapshot={start_s:previous.t,end_s:right?timeOf(right,i+1):lastTime,
      mode:'ultimo_estado',reason:'Último estado conocido; sin observaciones para actualizar trayectorias.',
      gap_id:originalGap?.id||`view:${previous.f}:${right?numberOf(right,i+1):'end'}`,
      t_observed:previous.t,players:unique(annotateContinuityObserved(report,previous.players,{segment:previous.players[0]?.segment,frame:previous.f}).map(p=>({id:`snapshot:${p.key}`,
        before_key:p.key,source_track_id:p.source_track_id,team:p.team,role:p.role,x:p.x,y:p.y,
        ...(p.continuity_id?{continuity_id:p.continuity_id}:{}),
        state:'ultimo_estado',source:'last_known_snapshot',kind:'snapshot',t_observed:p.t,
        uncertainty_m:null,uncertainty_kind:'not_current_position'})))};
    if(!approved) {report.segments.push(snapshot);continue;}
    const leftT=originalGap.start_s;
    let firstAfter=null;
    for(let j=i+1;j<frames.length;j++) {
      const fr=frames[j], ff=numberOf(fr,j);
      if((atFrame.get(ff)||[]).length) {firstAfter=timeOf(fr,j);break;}
      if(timeOf(fr,j)-leftT>3) break;
    }
    if(firstAfter===null||firstAfter-leftT>3+1e-9) {report.segments.push(snapshot);continue;}
    const segment={...snapshot,end_s:firstAfter,mode:'estimado',reason:
      model==='retrospective'?'Puentes de identidad revisada; las personas sin enlace conservan un estado fechado hasta el retorno.':
        'Pronóstico causal de personas vistas; no confirma su identidad al regresar la cámara.',curves:[],players:[]};
    for(const endpoint of originalGap.before||[]) {
      const entry=[...tracks.entries()].find(([,pts])=>pts.at(-1).key===endpoint.key && Math.abs(pts.at(-1).t-endpoint.t)<1e-8);
      if(!entry || !inside(endpoint)) continue;
      const [trackKey,before]=entry, edge=model==='retrospective'
        ?identities.edges.find(edge=>edge.gap.id===originalGap.id&&edge.link.beforeKey===endpoint.key):null;
      let curve, startT=endpoint.t,endT=firstAfter, kind='forecast', afterKey=null, continuityId=null;
      if(edge) {
        curve=edge.curve;startT=edge.link.motion_path?.start_s??endpoint.t;
        endT=edge.link.motion_path?.end_s??edge.b.first.t;
        kind='bridge';afterKey=edge.link.afterKey;
        continuityId=report.identity_links.find(link=>link.gap_id===originalGap.id&&link.before_key===endpoint.key)?.continuity_id;
      } else if (model==='retrospective') {
        curve={samples:[{t:0,x:endpoint.x,y:endpoint.y,vx:0,vy:0},
          {t:firstAfter-endpoint.t,x:endpoint.x,y:endpoint.y,vx:0,vy:0}],
          source:'last_known_snapshot',diagnostics:{reason:'identity_not_confirmed',anchor_t:endpoint.t}};
        kind='snapshot';
      } else {
        const direction=options.attackDirections?.[endpoint.team];
        let state=null;
        if(context&&[-1,1].includes(direction)) state=mlState(context.tracks,context.data,
          trackKey,context.tracks.get(trackKey),before.length-1,direction);
        curve=buildMotionCurve(before,{duration_s:Math.min(3,firstAfter-endpoint.t),
          model:model==='learned'?'learned':'kinematic',mlState:state,weights:options.weights});
      }
      if(!curve?.samples?.length) continue;
      if(curve.source==='last_known_snapshot') kind='snapshot';
      segment.start_s=Math.min(segment.start_s,startT);
      segment.end_s=Math.max(segment.end_s,endT);
      segment.curves.push({id:`continuidad:${originalGap.id}:${endpoint.key}`,before_key:endpoint.key,
        ...(continuityId?{continuity_id:continuityId}:{}),
        after_key:afterKey,team:endpoint.team,role:endpoint.role,source_track_id:endpoint.source_track_id,
        start_s:startT,end_s:endT,kind,curve,t_observed:endpoint.t,
        base_uncertainty_m:Math.max(originalGap.camera_quality?.before?.baseline_m||3,
          originalGap.camera_quality?.after?.baseline_m||3),
        state:kind==='snapshot'?'ultimo_estado':'estimado'});
    }
    if(segment.curves.length) {
      if(segment.curves.every(c=>c.kind==='snapshot')) {
        segment.mode='ultimo_estado';segment.reason=snapshot.reason;
      }
      report.segments.push(segment);
    } else report.segments.push(snapshot);
  }
  // A reviewed same-shot identity fragment can interpolate its short missing
  // interval from the two accepted feet. This is a new derived estimate, not a
  // resurrection of the rejected raw box or a C1 claim about noisy observations.
  for(const edge of identities.edges.filter(edge=>edge.type==='fragment_continuation')) {
    const a=edge.a.last,b=edge.b.first,duration=b.t-a.t;
    const reject=reason=>report.diagnostics.push({fragment_id:edge.gap.id,
      before_key:edge.link.beforeKey,after_key:edge.link.afterKey,reason});
    if(!inside(a)||!inside(b)||!(duration>0&&duration<=.5+1e-9)||a.segment!==b.segment||
        [...evidence.values()].some(fr=>fr.t>=a.t-1e-9&&fr.t<=b.t+1e-9&&
          (fr.segment!==a.segment||!fr.calibrated||fr.quality.bad))) {
      reject('fragmento_sin_geometria_calibrada_del_mismo_plano');continue;
    }
    const window=raw.return_continuity_review?.reviewed_motion_window===true
      ?reviewedObservationWindow(edge.a.points,edge.b.points):null;
    const vx=(b.x-a.x)/duration,vy=(b.y-a.y)/duration;
    if(!window&&(!Number.isFinite(vx)||!Number.isFinite(vy)||Math.hypot(vx,vy)>9+1e-9)) {
      reject('fragmento_movimiento_sin_soporte_velocidad');continue;
    }
    const identity=report.identity_links.find(link=>link.type==='fragment_continuation'&&
      link.gap_id===edge.gap.id&&link.before_key===edge.link.beforeKey);
    if(!identity?.continuity_id){reject('fragmento_sin_identidad_canonica');continue;}
    const source=window?'reviewed_fragment_motion_window':'reviewed_fragment_interpolation';
    const start=window?.start_s??a.t,end=window?.end_s??b.t;
    const curve=window?{source,diagnostics:{anchor_t:a.t,endpoint_t:b.t,window_s:window.window_s,
      max_observation_deviation_m:window.max_observation_deviation_m,correction_limit_m:window.correction_limit_m,
      observed_points_checked:window.observed_points_checked,max_speed_m_s:window.max_speed_m_s,
      max_acceleration_m_s2:window.max_acceleration_m_s2,algorithm:window.algorithm,
      endpoint_velocity_preserved:window.endpoint_velocity_preserved,outer_endpoints_exact:window.outer_endpoints_exact},
      samples:window.samples.map(p=>({...p,t:p.t-window.start_s}))}
      :{source,diagnostics:{anchor_t:a.t,endpoint_t:b.t,constant_velocity_m_s:Math.hypot(vx,vy),
        limitation:'Short linear fragment interpolates position only; no C1 or acceleration-limit claim at its ends.'},
        samples:[{t:0,x:a.x,y:a.y,vx,vy},{t:duration,x:b.x,y:b.y,vx,vy}]};
    report.segments.push({start_s:start,end_s:end,mode:'estimado',gap_id:edge.gap.id,
      reason:window?'Ajuste breve de movimiento entre fragmentos de identidad revisada; no sustituye detecciones.'
        :'Interpolación breve entre dos pies observados de la misma identidad revisada.',players:[],
      curves:[{id:`continuidad:${edge.gap.id}`,before_key:edge.link.beforeKey,after_key:edge.link.afterKey,
        continuity_id:identity.continuity_id,team:a.team,role:a.role,source_track_id:a.source_track_id,
        start_s:start,end_s:end,kind:'bridge',state:'estimado',t_observed:a.t,
        base_uncertainty_m:Math.max(evidence.get(a.f)?.quality.baseline_m||3,evidence.get(b.f)?.quality.baseline_m||3),
        curve}]});
  }
  report.segments.sort((a,b)=>a.start_s-b.start_s);
  if(options.persistentRoster===true)persistentRoster(report,tracks,frames,fps);
  report.summary={segments:report.segments.length,
    predicted_segments:report.segments.filter(s=>s.mode==='estimado').length,
    snapshot_segments:report.segments.filter(s=>s.mode==='ultimo_estado').length,
    reviewed_bridges:report.segments.reduce((s,q)=>s+(q.curves||[]).filter(c=>c.kind==='bridge'&&!['reviewed_fragment_interpolation','reviewed_fragment_motion_window'].includes(c.curve.source)).length,0),
    fragment_interpolations:report.segments.reduce((s,q)=>s+(q.curves||[]).filter(c=>c.curve.source==='reviewed_fragment_interpolation').length,0),
    fragment_motion_windows:report.segments.reduce((s,q)=>s+(q.curves||[]).filter(c=>c.curve.source==='reviewed_fragment_motion_window').length,0),
    confirmed_identity_links:report.identity_links.length,
    unmatched_snapshots:report.segments.reduce((s,q)=>s+(q.curves||[]).filter(c=>c.kind==='snapshot').length,0),
    causal_forecasts:report.segments.reduce((s,q)=>s+(q.curves||[]).filter(c=>c.kind==='forecast').length,0)};
  if(report.roster_timeline)report.summary.persistent_roster_identities=report.roster_timeline.at(-1)?.players.length||0;
  return report;
}

function interpolate(curve,h) {
  const samples=curve.samples;
  if(!samples.length||h<0||h>samples.at(-1).t+1e-8)return null;
  let lo=0,hi=samples.length-1;
  while(lo<hi){const mid=(lo+hi+1)>>1;if(samples[mid].t<=h)lo=mid;else hi=mid-1;}
  const a=samples[lo],b=samples[lo+1];
  if(!b)return {...a};
  const u=Math.max(0,Math.min(1,(h-a.t)/(b.t-a.t)));
  return {x:a.x+(b.x-a.x)*u,y:a.y+(b.y-a.y)*u,vx:(a.vx||0)+((b.vx||0)-(a.vx||0))*u,
    vy:(a.vy||0)+((b.vy||0)-(a.vy||0))*u};
}

/** Continuous clock evaluation at any render rate, with exact causal anchoring. */
export function continuityAt(report,t) {
  if(!Number.isFinite(t))return empty('Tiempo inválido.');
  const segments=(report?.segments||[]).filter(s=>t>s.start_s+1e-9&&t<s.end_s-1e-9),
    policy=report?.roster_policy,roster=report?.roster_timeline||[];
  const inRoster=policy?.enabled&&t>=policy.start_s-1e-9&&t<policy.end_s-1e-9;
  if(!segments.length&&!inRoster)return empty('Fuera del intervalo revisado.');
  const players=[];
  for(const segment of segments) {
  if(segment.mode==='ultimo_estado'&&!segment.curves?.length) {
    // The persistent register is more complete than the last-frame snapshot.
    if(!inRoster)players.push(...segment.players.map(p=>({...p})));
    continue;
  }
  for(const c of segment.curves||[]) {
    if(t<=c.start_s||t>=c.end_s-1e-9)continue;
    const h=t-c.start_s,p=interpolate(c.curve,h);
    if(!p)continue;
    const nearest=c.kind==='bridge'?Math.min(h,c.end_s-t):h;
    players.push({...p,id:c.id,team:c.team,role:c.role,before_key:c.before_key,
      ...(c.continuity_id?{continuity_id:c.continuity_id,roster_id:c.continuity_id}:{}),
      after_key:c.after_key,source_track_id:c.source_track_id,kind:c.kind,state:c.state,
      source:c.curve.source,gap_id:segment.gap_id,t_observed:c.t_observed,
      uncertainty_m:c.kind==='snapshot'?null:c.base_uncertainty_m+1.5*nearest,
      uncertainty_kind:c.kind==='snapshot'?'not_current_position':'heuristica_no_calibrada',
      s:Math.hypot(p.vx||0,p.vy||0)});
  }
  }
  if(inRoster&&roster.length) {
    let lo=0,hi=roster.length-1;
    while(lo<hi){const m=(lo+hi+1)>>1;if(roster[m].t<=t+1e-9)lo=m;else hi=m-1;}
    if(roster[lo].t<=t+1e-9)players.push(...roster[lo].players.map(p=>({...p,age_s:Math.max(0,t-p.t_observed)})));
  }
  const kept=unique(players), uncertainties=kept.map(p=>p.uncertainty_m).filter(Number.isFinite);
  const snapshotOnly=kept.length>0&&kept.every(p=>p.kind==='snapshot');
  return {players:kept,mode:kept.length?(snapshotOnly?'ultimo_estado':'estimado'):'sin_evidencia',
    reason:snapshotOnly?'Últimos estados fechados; no son posiciones actuales.':segments[0]?.reason||'Registro persistente de personas vistas.',
    ...(snapshotOnly?{t_observed:Math.max(...kept.map(p=>p.t_observed))}:{}),
    uncertainty_m:uncertainties.length?Math.max(...uncertainties):null,
    viewport:'full_pitch',source:kept.length?(snapshotOnly?'last_known_snapshot':'bounded_motion_models'):'no_evidence'};
}
