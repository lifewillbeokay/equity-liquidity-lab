import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {SharedCurveCache,curveKey,CURVE_TTL_MS,LEASE_MS,validateBrowserCapture,compactSimulation} from '../lib/shared-cache';
import {PoolReadCache} from '../lib/pool-read-cache';
import {DEPLOYMENTS,CHAINS} from '../lib/registry';
import type {Simulation,Reference,Transport} from '../lib/simulator';
import seed from '../lib/data/market-snapshot.json';
const issuer=DEPLOYMENTS.find(d=>d.id==='coinbase-msft-base')!;
const saved=(seed.markets.MSFT.simulations.find(s=>s.issuerId===issuer.id)!) as unknown as Simulation;
const reference=saved.reference;
function database(){const sql=new DatabaseSync(':memory:');sql.exec(readFileSync('drizzle/0000_fresh_ego.sql','utf8'));return {sql,db:{prepare(query:string){let params:any[]=[];const wrapper={bind(...args:any[]){params=args;return wrapper;},async first(){return sql.prepare(query).get(...params)??null;},async all(){return {results:sql.prepare(query).all(...params)};},async run(){return {meta:sql.prepare(query).run(...params)};}};return wrapper;}} as unknown as D1Database};}
function objects(){const values=new Map<string,string>();return {values,bucket:{async put(k:string,v:string){values.set(k,v);return {};},async get(k:string){const v=values.get(k);return v?{async json(){return JSON.parse(v);}}:null;},async delete(k:string){values.delete(k);}} as unknown as R2Bucket};}
function capture(now:number):Simulation{return {...structuredClone(saved),fetchedAt:new Date(now).toISOString()};}
test('independent server instances share one lease and durable full curves without changing capture times',async()=>{
 const {db}=database(),{bucket}=objects();let now=Date.now();const a=new SharedCurveCache(db,bucket,()=>now),b=new SharedCurveCache(db,bucket,()=>now),key=curveKey(issuer,reference);
 const owners=await Promise.all([a.acquire(issuer,reference),b.acquire(issuer,reference)]);assert.equal(owners.filter(Boolean).length,1);
 const original=capture(now);assert.ok(await a.commit(key,owners.find(Boolean)!,original,'server'));now+=20_000;
 const hit=await b.read((await b.row(key))!);assert.deepEqual(hit?.points,original.points);assert.equal(hit?.fetchedAt,original.fetchedAt);assert.equal(hit?.cache?.state,'hit');assert.equal(hit?.cache?.expiresAt,new Date(Date.parse(original.fetchedAt)+CURVE_TTL_MS).toISOString());assert.equal(await b.acquire(issuer,reference),null);
 const restarted=new SharedCurveCache(db,bucket,()=>now);assert.equal((await restarted.read((await restarted.row(key))!))?.blockHash,original.blockHash);
});
test('expired lease owners cannot replace or release a newer capture',async()=>{
 const {db}=database(),{bucket,values}=objects();let now=Date.now();const a=new SharedCurveCache(db,bucket,()=>now),b=new SharedCurveCache(db,bucket,()=>now),key=curveKey(issuer,reference);const old=await a.acquire(issuer,reference);now+=LEASE_MS+1;const fresh=await b.acquire(issuer,reference);assert.ok(fresh);await a.fail(key,old!,'late failure');assert.equal((await b.row(key))?.lease_owner,fresh);assert.ok(await b.commit(key,fresh!,capture(now),'browser'));assert.equal(await a.commit(key,old!,capture(now-10),'server'),false);assert.equal((await b.read((await b.row(key))!))?.cache?.origin,'browser');assert.equal(values.size,1);
});
test('reference price/time, token and route configuration isolate curve keys',()=>{
 const key=curveKey(issuer,reference);assert.notEqual(key,curveKey(issuer,{...reference,price:reference.price+1}));assert.notEqual(key,curveKey(issuer,{...reference,updatedAt:'2026-11-15T00:00:00Z'}));assert.notEqual(key,curveKey({...issuer,token:'0x0000000000000000000000000000000000000001'},reference));assert.equal(key,curveKey(issuer,{...reference,fetchedAt:'another fetch time'}));
});
test('failed refreshes preserve healthy objects and freshness; missing objects recover',async()=>{
 const {db}=database(),{bucket,values}=objects();let now=Date.now();const cache=new SharedCurveCache(db,bucket,()=>now),key=curveKey(issuer,reference),original=capture(now);await cache.commit(key,(await cache.acquire(issuer,reference))!,original,'server');now+=CURVE_TTL_MS+1;const owner=await cache.acquire(issuer,reference);await cache.fail(key,owner!,'RPC 429');const row=(await cache.row(key))!;assert.equal(row.captured_at,original.fetchedAt);assert.ok(row.expires_at<now);assert.equal((await cache.read(row,'stale'))?.fetchedAt,original.fetchedAt);assert.equal(row.last_error,'RPC 429');assert.equal(await cache.acquire(issuer,reference),null);values.clear();assert.equal(await cache.read(row),null);assert.equal((await cache.row(key))?.expires_at,0);
});
test('browser captures require matching full-input provenance and a complete ladder',()=>{
 const s=capture(Date.now()),row={reference:JSON.stringify(reference)} as any;assert.equal(validateBrowserCapture(issuer,row,s).transport,'browser');assert.throws(()=>validateBrowserCapture(issuer,row,{...s,issuerId:'other'}),/identity/);assert.throws(()=>validateBrowserCapture(issuer,row,{...s,points:s.points.slice(1)}),/ladder/);const p=structuredClone(s);p.points.find(p=>p.status==='ok')!.consumedInputRaw='1';assert.throws(()=>validateBrowserCapture(issuer,row,p),/full-input/);assert.ok(!compactSimulation(s).points.some(p=>p.candidateQuotes));assert.deepEqual(compactSimulation(s).points.map(p=>p.price),s.points.map(p=>p.price));
});
const hash='0x'+'1'.repeat(64),otherHash='0x'+'2'.repeat(64);
function rpc(options:{hash?:()=>string;error?:boolean}={}){let calls=0,reads=0;const transport:Transport=async(_url,body)=>{return (body as any[]).slice().reverse().map(r=>{calls++;if(r.method==='eth_getBlockByNumber')return {id:r.id,result:{number:'0x10',hash:options.hash?.()??hash}};reads++;return options.error?{id:r.id,error:{code:-32000,message:'rate limit'}}:{id:r.id,result:'0x'+String(r.params[0].data).slice(2).padStart(64,'0')};});};return {transport,get calls(){return calls;},get reads(){return reads;}};}
const head=[{jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:['latest',false]}];
const read=(id:number,data='0x01')=>({jsonrpc:'2.0',id,method:'eth_call',params:[{to:issuer.token,data,gas:'0x100'},'0x10']});
test('pinned pool reads are staged, batched, shared, and remapped to each request id',async()=>{
 const {db,sql}=database(),up=rpc();const first=new PoolReadCache(db,up.transport);await first.transport(CHAINS.base.rpc,head);const result=await first.transport(CHAINS.base.rpc,[read(7),read(9,'0x02')]) as any[];assert.equal(result[0].id,7);assert.equal(sql.prepare('SELECT count(*) n FROM pool_reads').get()!.n,0);await first.commit();assert.equal(sql.prepare('SELECT count(*) n FROM pool_reads').get()!.n,2);
 const next=new PoolReadCache(db,up.transport);const before=up.reads;await next.transport(CHAINS.base.rpc,head);const hit=await next.transport(CHAINS.base.rpc,[read(33,'0x02'),read(22)]) as any[];assert.equal(up.reads,before);assert.equal(next.hits,2);assert.equal(hit[0].id,33);assert.equal(hit[0].result,result[1].result);await next.transport(CHAINS.base.rpc,[{...read(44),params:[{...read(44).params[0] as object,gas:'0x200'},'0x10']}]);assert.equal(up.reads,before+1);
});
test('canonicality checks bypass the cache and reorgs publish no staged pool state',async()=>{
 const {db,sql}=database();let current=hash;const up=rpc({hash:()=>current}),cache=new PoolReadCache(db,up.transport);await cache.transport(CHAINS.base.rpc,head);await cache.transport(CHAINS.base.rpc,[read(1)]);current=otherHash;await assert.rejects(cache.commit(),/snapshot changed/);assert.equal(sql.prepare('SELECT count(*) n FROM pool_reads').get()!.n,0);
 await assert.rejects(cache.transport(CHAINS.base.rpc,[{...head[0],params:['0x10',false]}]),/Snapshot block changed/);
});
test('transient RPC failures are never stored as pool state',async()=>{
 const {db,sql}=database(),up=rpc({error:true}),cache=new PoolReadCache(db,up.transport);await cache.transport(CHAINS.base.rpc,head);await cache.transport(CHAINS.base.rpc,[read(1)]);await cache.commit();assert.equal(sql.prepare('SELECT count(*) n FROM pool_reads').get()!.n,0);
});

test('browser captures reject fabricated raw amounts, notionals, venue and impact',()=>{
 const row={reference:JSON.stringify(reference)} as any;
 for(const change of [(p:any)=>{p.inputRaw='1';p.consumedInputRaw='1';},(p:any)=>{p.outputRaw='1';},(p:any)=>{p.impactBps=12345;},(p:any)=>{p.venue='pancake';}]){const s=capture(Date.now());change(s.points.find(p=>p.status==='ok'));assert.throws(()=>validateBrowserCapture(issuer,row,s));}
});
test('pruning does not clear a failed cold capture cooldown',async()=>{
 const {db}=database(),{bucket}=objects();const now=Date.now(),cache=new SharedCurveCache(db,bucket,()=>now),key=curveKey(issuer,reference);const owner=await cache.acquire(issuer,reference);await cache.fail(key,owner!,'RPC 429');await cache.prune();assert.equal(await cache.acquire(issuer,reference),null);assert.equal((await cache.row(key))?.last_error,'RPC 429');
});
test('pool commit canonical checks use the official Robinhood fallback on structured errors',async()=>{
 const {db,sql}=database();let official=0;const upstream:Transport=async(url,body)=>(body as any[]).map(r=>{if(url===CHAINS.robinhood.rpc&&r.params[0]!=='latest')return {id:r.id,error:{code:-32000,message:'archive unavailable'}};if(url==='https://rpc.mainnet.chain.robinhood.com')official++;return {id:r.id,result:r.method==='eth_getBlockByNumber'?{number:'0x10',hash}:'0x01'};});
 const cache=new PoolReadCache(db,upstream);await cache.transport(CHAINS.robinhood.rpc,head);await cache.transport('https://rpc.mainnet.chain.robinhood.com',[read(1)]);await cache.commit();assert.equal(sql.prepare('SELECT count(*) n FROM pool_reads').get()!.n,1);assert.equal(official,2);
});

test('duplicate same-owner submissions keep the winning immutable object',async()=>{
 const {db}=database(),{bucket,values}=objects();const now=Date.now(),cache=new SharedCurveCache(db,bucket,()=>now),key=curveKey(issuer,reference);const owner=await cache.acquire(issuer,reference);const commits=await Promise.all([cache.commit(key,owner!,capture(now),'browser'),cache.commit(key,owner!,capture(now),'browser')]);assert.equal(commits.filter(Boolean).length,1);assert.equal(values.size,1);assert.equal((await cache.read((await cache.row(key))!))?.fetchedAt,new Date(now).toISOString());
});
test('Metric snapshots expire the whole capture even when only a probe or venue used them',async()=>{
 const {db}=database(),{bucket}=objects();const now=Date.now(),cache=new SharedCurveCache(db,bucket,()=>now),key=curveKey(issuer,reference),s=capture(now),serverTs=Math.floor((now-90_000)/1000);
 s.metricDepth={pools:1,estimates:1,fallbacks:{},state:[{poolAddress:'0x'+'1'.repeat(40),priceProviderStatus:'healthy',bidAdj:'1',askAdj:'2',serverTs,depth:{bids:[],asks:[]}}]};
 await cache.commit(key,(await cache.acquire(issuer,reference))!,s,'server');assert.equal((await cache.row(key))!.expires_at,serverTs*1000+CURVE_TTL_MS);
 const compact=compactSimulation(s);assert.equal(compact.metricDepth?.state,undefined);assert.equal(compact.metricDepth?.estimates,1);
});
test('browser captures cannot attach Metric provenance to unrelated routes or invent API times',()=>{
 const row={reference:JSON.stringify(reference)} as any,s=capture(Date.now()),p=s.points.find(p=>p.status==='ok')!;p.quoteMethod='metric-depth';p.quoteKind='provider';p.observedAt=s.fetchedAt;p.metricSources=[{source:'metric-depth',pool:'0x'+'1'.repeat(40),observedAt:s.fetchedAt}];assert.throws(()=>validateBrowserCapture(issuer,row,s),/Metric/);
});
