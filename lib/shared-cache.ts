import {formatUnits,parseUnits} from 'viem';
import {createHash} from 'node:crypto';
import {routesFor,SIZES,type Issuer} from './registry';
import {SAMPLING_VERSION,MAX_ADAPTIVE_PER_SIDE} from './sampling';
import type {Reference,Simulation} from './simulator';

export const CURVE_TTL_MS=120_000;
export const LEASE_MS=600_000;
export const CACHE_VERSION='shared-curves-local-pools-v2';
export type CacheInfo={state:'hit'|'updated'|'stale';key:string;storedAt:string;expiresAt:string;origin:'server'|'browser';poolReadHits?:number;poolReadMisses?:number};
export type CachedSimulation=Simulation&{cache?:CacheInfo};
export type CurveRow={key:string;issuer:string;stock:string;object_key:string|null;captured_at:string|null;expires_at:number;stored_at:number;origin:'server'|'browser'|null;lease_owner:string|null;lease_until:number;retry_at:number;last_error:string|null;reference:string};
export type ObjectStore=Pick<R2Bucket,'get'|'put'|'delete'>;
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function curveKey(issuer:Issuer,reference:Reference){return digest({version:CACHE_VERSION,sampling:SAMPLING_VERSION,issuer,routes:routesFor(issuer),reference:{price:reference.price,updatedAt:reference.updatedAt}});}
export function reusable(s:Simulation){return s.status!=='error'&&!s.points.some(p=>p.status==='error')&&!s.verificationErrors?.length;}
export function compactSimulation(s:CachedSimulation):CachedSimulation{
 const point=(p:Simulation['points'][number])=>{const {candidateQuotes,...rest}=p;return rest;};
 return {...s,points:s.points.map(point),venues:s.venues?Object.fromEntries(Object.entries(s.venues).map(([k,v])=>[k,{...v,points:v!.points.map(point)}])):undefined};
}
export class SharedCurveCache{
 constructor(readonly db:D1Database,readonly objects:ObjectStore,readonly now:()=>number=Date.now){}
 async row(key:string){return this.db.prepare('SELECT * FROM curve_cache WHERE key=?').bind(key).first<CurveRow>();}
 async read(row:CurveRow,state:CacheInfo['state']='hit'):Promise<CachedSimulation|null>{
  if(!row.object_key)return null;const object=await this.objects.get(row.object_key);if(!object){const latest=await this.row(row.key);if(latest?.object_key&&latest.object_key!==row.object_key)return this.read(latest,state);await this.db.prepare('UPDATE curve_cache SET object_key=NULL,expires_at=0 WHERE key=? AND object_key=?').bind(row.key,row.object_key).run();return null;}
  const value=await object.json<Simulation>();
  return {...value,cache:{state,key:row.key,storedAt:new Date(row.stored_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),origin:row.origin??'server'}};
 }
 async acquire(issuer:Issuer,reference:Reference,key=curveKey(issuer,reference)){
  const now=this.now(),owner=crypto.randomUUID();
  await this.db.prepare('INSERT INTO curve_cache(key,issuer,stock,reference) VALUES(?,?,?,?) ON CONFLICT(key) DO NOTHING').bind(key,issuer.id,issuer.stock??'AAPL',JSON.stringify(reference)).run();
  const won=await this.db.prepare('UPDATE curve_cache SET lease_owner=?,lease_until=? WHERE key=? AND lease_until<=? AND retry_at<=? AND expires_at<=? RETURNING key').bind(owner,now+LEASE_MS,key,now,now,now).first();
  return won?owner:null;
 }
 async renew(key:string,owner:string){return !!await this.db.prepare('UPDATE curve_cache SET lease_until=? WHERE key=? AND lease_owner=? AND lease_until>? RETURNING key').bind(this.now()+LEASE_MS,key,owner,this.now()).first();}
 async commit(key:string,owner:string,value:Simulation,origin:'server'|'browser'){
  if(!reusable(value))throw new Error('Only complete error-free captures can be shared');
  const row=await this.row(key),now=this.now();if(!row||row.lease_owner!==owner||row.lease_until<=now)return false;
  const objectKey=`curves/${key}/${crypto.randomUUID()}.json`;const {cache:ignored,...clean}=value as CachedSimulation;
  await this.objects.put(objectKey,JSON.stringify(clean),{httpMetadata:{contentType:'application/json'}});
  const captured=Date.parse(value.fetchedAt),ttl=value.status==='ok'?CURVE_TTL_MS:30_000;const expires=Number.isFinite(captured)?Math.min(now+ttl,captured+ttl):now;
  const won=await this.db.prepare('UPDATE curve_cache SET object_key=?,captured_at=?,expires_at=?,stored_at=?,origin=?,lease_owner=NULL,lease_until=0,retry_at=0,last_error=NULL WHERE key=? AND lease_owner=? AND lease_until>? RETURNING key').bind(objectKey,value.fetchedAt,expires,now,origin,key,owner,now).first();
  if(!won){await this.objects.delete(objectKey);return false;}
  // The old pointer is replaced atomically. A racing reader can re-read the row.
  if(row.object_key&&row.object_key!==objectKey)await this.objects.delete(row.object_key).catch(()=>{});
  return true;
 }
 async fail(key:string,owner:string,message:string){
  const now=this.now();await this.db.prepare('UPDATE curve_cache SET lease_owner=NULL,lease_until=0,retry_at=?,last_error=? WHERE key=? AND lease_owner=?').bind(now+30_000,message.slice(0,180),key,owner).run();
 }
 async prune(){
  const now=this.now();const old=await this.db.prepare('SELECT key,object_key FROM curve_cache WHERE stored_at<? AND lease_until<? AND retry_at<=? LIMIT 20').bind(now-3_600_000,now,now).all<{key:string;object_key:string|null}>();
  for(const row of old.results){const gone=await this.db.prepare('DELETE FROM curve_cache WHERE key=? AND stored_at<? AND lease_until<? AND retry_at<=? RETURNING key').bind(row.key,now-3_600_000,now,now).first();if(gone&&row.object_key)await this.objects.delete(row.object_key).catch(()=>{});}
  await this.db.prepare('DELETE FROM pool_reads WHERE key IN (SELECT key FROM pool_reads WHERE expires_at<? LIMIT 5000)').bind(now).run();
 }
}

/** Validate an owner-private browser capture before publishing it as browser-origin data. */
export function validateBrowserCapture(issuer:Issuer,row:CurveRow,s:Simulation){
 const reference=JSON.parse(row.reference) as Reference;
 if(s.issuerId!==issuer.id||s.reference.price!==reference.price||s.reference.updatedAt!==reference.updatedAt)throw new Error('Capture identity/reference mismatch');
 if(!reusable(s))throw new Error('Capture contains errors');
 const captured=Date.parse(s.fetchedAt),now=Date.now();if(!Number.isFinite(captured)||captured<now-600_000||captured>now+30_000)throw new Error('Capture timestamp is outside its lease');
 if(!/^0x[0-9a-f]{64}$/i.test(s.blockHash??'')||!Number.isSafeInteger(s.blockNumber)||!s.normalization||!Number.isFinite(s.normalization.sharesPerToken)||s.normalization.sharesPerToken<=0)throw new Error('Capture lacks block or normalization provenance');
 if(s.sampling?.version!==SAMPLING_VERSION)throw new Error('Sampling version mismatch');
 const close=(a:number|null|undefined,b:number,label:string)=>{if(typeof a!=='number'||!Number.isFinite(a)||Math.abs(a-b)>Math.max(1e-8,Math.abs(b)*1e-9))throw new Error(label+' does not reconcile');};
 const validRoutes=new Set(routesFor(issuer).map(r=>r.id));if(s.routes.some(r=>!validRoutes.has(r.id)))throw new Error('Unknown route');
 for(const side of ['buy','sell'] as const){const ps=s.points.filter(p=>p.side===side);if(JSON.stringify(ps.filter(p=>p.sampleKind==='base').map(p=>p.size))!==JSON.stringify(SIZES))throw new Error('Incomplete base ladder');if(ps.length>SIZES.length+MAX_ADAPTIVE_PER_SIDE||new Set(ps.map(p=>p.size)).size!==ps.length)throw new Error('Invalid adaptive ladder');}
 for(const [venue,view] of [['all',s],...Object.entries(s.venues??{})] as [string,{points:Simulation['points'];probe:Simulation['probe']}][]){
 if(venue!=='all'&&!routesFor(issuer).some(r=>r.venue===venue))throw new Error('Unknown venue');
 for(const p of view.points){
  if(!Number.isFinite(p.size)||p.size<100||p.size>100000)throw new Error('Invalid size');
  if(p.status==='ok'){
   if(!validRoutes.has(p.routeId??'')||p.deploymentId!==issuer.id||p.chain!==issuer.chain||p.inputRaw!==p.consumedInputRaw||!/^\d+$/.test(p.outputRaw??'')||BigInt(p.outputRaw!)<=0n)throw new Error('Invalid full-input quote provenance');
   if(!p.shares||!p.price||!Number.isFinite(p.price)||!Number.isFinite(p.shares)||p.shares<=0||p.price<=0)throw new Error('Invalid share units');
   if(!/^\d+$/.test(p.inputRaw)||BigInt(p.inputRaw)<=0n)throw new Error('Invalid raw input');
   close(p.input,Number(formatUnits(BigInt(p.inputRaw),p.side==='buy'?issuer.settlementDecimals:issuer.decimals)),'Raw input');
   close(p.output,Number(formatUnits(BigInt(p.outputRaw!),p.side==='buy'?issuer.decimals:issuer.settlementDecimals)),'Raw output');
   if(p.side==='buy'&&p.inputRaw!==parseUnits(String(p.size),issuer.settlementDecimals).toString())throw new Error('Buy notional does not reconcile');
   if(p.side==='sell')close(p.shares,p.size/reference.price,'Sell notional');
   if(issuer.normalization!=='wrapper')close(p.shares,(p.side==='buy'?p.output!:p.input)*s.normalization.sharesPerToken,'Share normalization');
   const route=routesFor(issuer).find(r=>r.id===p.routeId);if(p.venue!==route?.venue||(venue!=='all'&&p.venue!==venue))throw new Error('Quote venue does not reconcile');
   close(p.referenceBps,(p.price/reference.price-1)*10000,'Reference deviation');
   const probe=view.probe[p.side==='buy'?'buyPrice':'sellPrice'];if(probe)close(p.impactBps,(p.side==='buy'?p.price/probe-1:1-p.price/probe)*10000,'Impact');else if(p.impactBps!==null)throw new Error('Impact lacks a probe');
   const calculated=(p.side==='buy'?p.input:p.output!)/p.shares;if(!Number.isFinite(calculated)||Math.abs(calculated-p.price)>Math.max(1e-8,p.price*1e-10))throw new Error('Quote price does not reconcile');
  }
 }
 }
 return {...s,transport:'browser' as const,reference};
}
