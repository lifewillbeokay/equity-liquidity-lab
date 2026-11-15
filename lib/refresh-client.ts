import type {Issuer} from './registry';
import type {Reference,Simulation} from './simulator';
/** Only the owner of a distributed refresh lease runs the browser fallback. */
export async function refreshSimulation(issuer:Issuer,reference:Reference,onWaiting?:()=>void):Promise<Simulation>{
 const url='/api/simulate?'+new URLSearchParams({issuer:issuer.id,reference:String(reference.price),referenceTime:reference.updatedAt,compact:'1'});
 let ticket:{key:string;owner:string}|undefined;let result:Simulation|undefined;let serverError='';
 const deadline=Date.now()+600_000;
 for(;;){
  let response:Response;try{response=await fetch(url,{signal:AbortSignal.timeout(360_000)});}catch(e){serverError=(e as Error).message;break;}
  if(response.status===202){if(Date.now()>=deadline)throw new Error('A shared refresh is still running; try again shortly.');onWaiting?.();await new Promise(r=>setTimeout(r,1500));continue;}
  if(!response.ok){const error=await response.json().catch(()=>({})) as {error?:string;retryAfterMs?:number};if(error.retryAfterMs)throw new Error(error.error??'Source temporarily unavailable');serverError=error.error??'Quote service HTTP '+response.status;break;}
  const data=await response.json() as Simulation&{cacheTicket?:{key:string;owner:string};serverQuoteError?:string};
  ticket=data.cacheTicket;const {cacheTicket,serverQuoteError,...clean}=data;result=clean;
  if(result.status!=='error'&&!serverQuoteError){result.transport=result.cache?.origin??'server';return result;}
  serverError=serverQuoteError??result.error??'Server quote failed';break;
 }
 let fallback:Simulation;
 try{const {simulateIssuer}=await import('./simulator');fallback=await simulateIssuer(issuer,reference);fallback.transport='browser';}
 catch(e){throw new Error((e as Error).message||serverError);}
 if(ticket){
  try{const response=await fetch('/api/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({issuer:issuer.id,...ticket,...(fallback.status!=='error'?{simulation:fallback}:{error:fallback.error??'No usable browser capture'})}),signal:AbortSignal.timeout(45_000)});if(response.ok)return await response.json() as Simulation;if(fallback.status==='ok')fallback.refreshError='Quote collected, but the shared cache could not save it.';}catch{if(fallback.status==='ok')fallback.refreshError='Quote collected, but the shared cache could not save it.';}
 }
 return fallback;
}
