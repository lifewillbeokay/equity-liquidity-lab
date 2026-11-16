import {cachedMetricDepth} from '../metric-cache';
import {env} from 'cloudflare:workers';
import {SharedCurveCache,curveKey,reusable,compactSimulation,validateBrowserCapture,type CachedSimulation,type CurveRow} from '../shared-cache';
import {PoolReadCache} from '../pool-read-cache';
import {getReference,simulateIssuer,type Reference,type Simulation} from '../simulator';
import {routesFor,SIZES,type Issuer} from '../registry';
import {SAMPLING_VERSION,MAX_ADAPTIVE_PER_SIDE} from '../sampling';

export function centralCache(){if(!env.DB||!env.BUCKET)throw new Error('Shared cache storage is unavailable');return new SharedCurveCache(env.DB,env.BUCKET);}
export async function sharedReference(stock:string):Promise<Reference>{
 const cache=centralCache(),now=Date.now();const row=await cache.db.prepare('SELECT value,expires_at FROM market_references WHERE stock=?').bind(stock).first<{value:string;expires_at:number}>();
 if(row&&row.expires_at>now)return JSON.parse(row.value);
 const value=await getReference(stock);await cache.db.prepare('INSERT INTO market_references(stock,value,expires_at) VALUES(?,?,?) ON CONFLICT(stock) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at').bind(stock,JSON.stringify(value),now+60_000).run();return value;
}
export async function sharedSimulation(issuer:Issuer,reference:Reference){
 const cache=centralCache(),key=curveKey(issuer,reference);let row=await cache.row(key);
 if(row?.object_key&&row.expires_at>Date.now()){const value=await cache.read(row);if(value)return {status:200,value};}
 if(row&&row.retry_at>Date.now()){const stale=await cache.read(row,'stale');if(stale)return {status:200,value:{...stale,refreshError:row.last_error??'Source is cooling down',lastRefreshAttempt:new Date(row.retry_at-30_000).toISOString()}};return {status:503,value:{error:row.last_error??'Source is cooling down',retryAfterMs:row.retry_at-Date.now()}};}
 const owner=await cache.acquire(issuer,reference,key);
 if(!owner){row=await cache.row(key);if(row?.object_key&&row.expires_at>Date.now()){const value=await cache.read(row);if(value)return {status:200,value};}return {status:202,value:{state:'pending',retryAfterMs:1500}};}
 const reads=new PoolReadCache(cache.db);
 let value:Simulation;
 try{
  value=await simulateIssuer(issuer,reference,reads.transport,{metricLoader:(chainId,pools)=>cachedMetricDepth(cache.objects,chainId,pools),localWorkLimit:{stateReads:64,steps:{remaining:200}}});
  if(reusable(value)){
   await reads.commit();if(!await cache.commit(key,owner,value,'server'))return {status:202,value:{state:'pending',retryAfterMs:1000}};
   row=await cache.row(key);const ready=await cache.read(row!,'updated');if(!ready)throw new Error('Stored curve unavailable');ready.cache!.poolReadHits=reads.hits;ready.cache!.poolReadMisses=reads.misses;
   await cache.prune().catch(()=>{});return {status:200,value:ready};
  }
 }catch(e){value={issuerId:issuer.id,status:'error',error:(e as Error).message,blockNumber:null,blockHash:null,blockTimestamp:null,fetchedAt:new Date().toISOString(),normalization:null,routes:[],points:[],probe:{buyPrice:null,sellPrice:null},rpc:'',reference};}
 // Keep the same distributed lease while this request's browser fallback runs.
 await cache.renew(key,owner);return {status:200,value:{...value,cacheTicket:{key,owner},serverQuoteError:value.error??'Some routes failed during collection'}};
}
export async function finishBrowserCapture(issuer:Issuer,key:string,owner:string,s?:Simulation,error?:string){
 const cache=centralCache(),row=await cache.row(key);if(!row||row.issuer!==issuer.id||row.lease_owner!==owner||row.lease_until<=Date.now())return {status:409,value:{error:'Refresh lease expired or superseded'}};
 if(s){try{const valid=validateBrowserCapture(issuer,row,s);if(await cache.commit(key,owner,valid,'browser')){await cache.prune().catch(()=>{});return {status:200,value:compactSimulation((await cache.read((await cache.row(key))!,'updated'))!)};}}catch(e){error=(e as Error).message;}}
 await cache.fail(key,owner,error??'Browser refresh failed');const current=await cache.row(key),stale=current?await cache.read(current,'stale'):null;
 return stale?{status:200,value:{...stale,refreshError:error??'Refresh failed',lastRefreshAttempt:new Date().toISOString()}}:{status:502,value:{error:error??'Refresh failed'}};
}
