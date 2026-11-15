import type {Simulation} from './simulator';
import type {DexScope} from './registry';
/** Venue views are selected from one collected block, never recollected on filter changes. */
export function simulationForVenue(s:Simulation,scope:DexScope):Simulation{
 if(scope==='all')return s;
 const routes=s.routes.filter(r=>r.venue===scope),view=s.venues?.[scope];
 if(s.status==='error')return {...s,routes,points:[],probe:{buyPrice:null,sellPrice:null}};
 if(!view)return {...s,status:'unavailable',routes,points:[],probe:{buyPrice:null,sellPrice:null}};
 const status=view.points.some(p=>p.status==='ok')?'ok':view.points.length&&view.points.every(p=>p.status==='error')?'error':'unavailable';
 return {...s,...view,routes,status,error:status==='error'?'RPC quote requests failed':undefined};
}
