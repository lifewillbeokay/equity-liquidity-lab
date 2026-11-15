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

import {DEPLOYMENTS,SIZES,type ChainKey,type Issuer} from './registry';
import {groupOf,stockOf} from './market';
import type {QuotePoint} from './simulator';
export type IssuerView={issuerId:string;points:QuotePoint[];probe:{buyPrice:number|null;sellPrice:number|null};deployments:Simulation[]};
/** Select by share-adjusted price, never raw token units or summed liquidity. */
export function bestAcrossDeployments(simulations:Simulation[],stock:string,issuerId:string,scope:DexScope='all',chain:ChainKey|'all'='all',registry:Issuer[]=DEPLOYMENTS):IssuerView{
 const records=simulations.flatMap(s=>{const d=registry.find(d=>d.id===s.issuerId);return d&&stockOf(d)===stock&&groupOf(d)===issuerId&&(chain==='all'||d.chain===chain)?[{s:simulationForVenue(s,scope),d}]:[];});
 const valid=records.filter(r=>r.s.status==='ok');
 const baseline=(side:'buy'|'sell')=>{const values=valid.map(({s})=>s.probe[side==='buy'?'buyPrice':'sellPrice']).filter((x):x is number=>x!==null&&Number.isFinite(x)&&x>0);return values.length?(side==='buy'?Math.min(...values):Math.max(...values)):null;};
 const probe={buyPrice:baseline('buy'),sellPrice:baseline('sell')};const points:QuotePoint[]=[];
 for(const side of ['buy','sell'] as const)for(const size of SIZES){const candidates=valid.flatMap(({s,d})=>s.points.filter(p=>p.side===side&&p.size===size&&p.status==='ok'&&p.price!==null&&Number.isFinite(p.price)&&p.price>0).map(p=>({...p,deploymentId:d.id,chain:d.chain,observedAt:p.observedAt??s.fetchedAt,quoteKind:p.quoteKind??s.quoteKind??'onchain' as const})));
 candidates.sort((a,b)=>side==='buy'?a.price!-b.price!:b.price!-a.price!);const p=candidates[0];if(p){const b=probe[side==='buy'?'buyPrice':'sellPrice'];points.push({...p,impactBps:b?(side==='buy'?p.price!/b-1:1-p.price!/b)*10000:null});}
 }
 return {issuerId,points,probe,deployments:records.map(r=>r.s)};
}
export function bestPoint(views:IssuerView[],size:number,side:'buy'|'sell'){
 return views.flatMap(v=>v.points.filter(p=>p.size===size&&p.side===side&&p.status==='ok').map(p=>({...p,issuerId:v.issuerId}))).sort((a,b)=>side==='buy'?a.price!-b.price!:b.price!-a.price!)[0];
}
/** Conservative sampled depth: largest independently quoted order, never a sum. */
export function sampledDepth(points:QuotePoint[],side:'buy'|'sell',impactPercent:number):number{
 return Math.max(0,...points.filter(p=>p.side===side&&p.status==='ok'&&p.impactBps!==null&&Number.isFinite(p.impactBps)&&Math.max(0,p.impactBps)/100<=impactPercent+1e-10).map(p=>p.size));
}
