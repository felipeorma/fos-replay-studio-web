// Reviewed continuity belongs to the 2D view. Video overlays and measured
// statistics keep the original observations, ball and camera geometry.
import {buildReconstruction} from './camera-reconstruction.js';
import {buildContinuity,continuityAt,continuityFrame} from './tactical-continuity.js';
import {continuityForDisplay,mergeSettings,reviewedFrame,reconstructionReviewedRoles} from './dashboard-core.js';

export async function analystTrackingSha(text) {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
}

export function prepareAnalystContinuity(raw,data,{reconstruction={},continuity={},settings={},trackingSha}={}) {
  const artifacts=[reconstruction,continuity].filter(a=>a&&Object.keys(a).length);
  if(!artifacts.length)return null;
  if(artifacts.some(a=>a.version!==1||a.report?.version!==1)||
    Object.keys(reconstruction).length&&!Array.isArray(reconstruction.report?.estimates)||
    Object.keys(continuity).length&&!Array.isArray(continuity.report?.segments))
    throw new Error('Archivo de continuidad o reconstrucción inválido.');
  if(!/^[a-f0-9]{64}$/i.test(trackingSha||'')||artifacts.some(a=>a.provenance?.tracking_sha256!==trackingSha))
    throw new Error('La revisión de continuidad no corresponde a este tracking. Abre los archivos de la misma revisión.');
  const prefs=mergeSettings({...settings,reconstruction:{...reconstruction.settings,...settings.reconstruction}});
  const reviewedRoles=reconstructionReviewedRoles(data,prefs);
  const rebuilt=buildReconstruction(raw,{...prefs.reconstruction,reviewedRoles});
  // Rebuild from this exact raw dataset and its reviewed associations; a saved
  // report cannot silently bind a bare ID to an unrelated camera/person.
  const report=buildContinuity(raw,rebuilt,{model:prefs.continuity.model,persistentRoster:true,reviewedRoles,
    rosterReview:continuity.report?.roster_review});
  return {report,settings:prefs,tracking_sha256:trackingSha};
}

export function analystContinuityFrame(report,frame,{segment,t=frame?.t,settings}={}) {
  if(!report||!frame)return frame;
  const reviewed=settings?reviewedFrame(frame,settings,segment):frame,
    observed=continuityFrame(report,reviewed,{segment,t}),state=continuityAt(report,t);
  const virtual=continuityForDisplay(state.players,observed,segment).map(p=>({...p,alpha:1}));
  return {...observed,virtual_players:virtual,continuity_mode:state.mode,continuity_reason:state.reason};
}

export function analystContinuityStatus(frame) {
  const virtual=frame?.virtual_players||[],snapshots=virtual.filter(p=>p.state==='ultimo_estado'||p.kind==='snapshot'),
    estimated=virtual.length-snapshots.length,
    adjusted=[...(frame?.p||[]),...(frame?.o||[])].filter(p=>p.position_source).length,
    observed=(frame?.p?.length||0)+(frame?.o?.length||0),
    times=snapshots.map(p=>p.t_observed).filter(Number.isFinite);
  const date=times.length?`${Math.min(...times).toFixed(2)}${Math.max(...times)-Math.min(...times)>1e-6?'–'+Math.max(...times).toFixed(2):''} s`:'';
  return {observed,estimated:estimated+adjusted,snapshots:snapshots.length,date,
    label:`${observed} observados · ${estimated+adjusted} posiciones estimadas${snapshots.length?
      ` · ${snapshots.length} últimos estados${date?' de '+date:''} (sin posición actual confirmada)`:''}`};
}

/** Only explicit same-origin dashboard result IDs are opened. No name matching
 * or searching other videos can accidentally import another clip's reviews. */
export async function readAnalystResult() { throw new Error('Importa los archivos locales.'); }
