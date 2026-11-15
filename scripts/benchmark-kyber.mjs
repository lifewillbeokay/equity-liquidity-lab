/** Read-only, cold quote benchmark. Run with node --import tsx.
 * No API keys, wallets, route/build requests, or transaction submission.
 * Usage: node --import tsx scripts/benchmark-kyber.mjs /absolute/result.json
 */
import {writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseUnits, formatUnits} from 'viem';
import {deploymentsForStock} from '../lib/market.ts';
import {routesFor, SIZES} from '../lib/registry.ts';
import {simulateIssuer, getReference, fetchTransport} from '../lib/simulator.ts';
import {validateKyberEvidence} from './kyber-quote-evidence.mjs';

const output=resolve(process.argv[2]??'work/kyber-benchmark.json');
await mkdir(dirname(output),{recursive:true});
const result={startedAt:new Date().toISOString(),directSourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),environment:'local Node.js; public internet; no application cache',
 policy:{stocks:['AAPL','MSFT'],chains:['ethereum','base','bsc','robinhood'],kyberRps:1000/350,concurrency:3,
 excludeRFQSources:true,gasInclude:false,standardSizes:SIZES,comparison:'Exact same raw inputs, 25 standard sizes per side, $10 probes, and direct-engine adaptive sizes. Direct quotes are block-pinned; Kyber quotes are latest-state provider estimates.'},markets:[]};
let writes=Promise.resolve();
const save=()=>{const json=JSON.stringify(result,null,2)+'\n';writes=writes.then(()=>writeFile(output,json));return writes;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let nextStart=0;
let permits=Promise.resolve();
async function waitForSlot(){
 let release;const previous=permits;permits=new Promise(r=>{release=r;});await previous;
 try{while(Date.now()<nextStart)await sleep(nextStart-Date.now());nextStart=Date.now()+350;}finally{release();}
}
async function requestKyber(issuer,side,size,inputRaw){
 const url=new URL(`https://aggregator-api.kyberswap.com/${issuer.chain}/api/v1/routes`);
 const tokenIn=side==='buy'?issuer.settlement:issuer.token,tokenOut=side==='buy'?issuer.token:issuer.settlement;
 url.search=new URLSearchParams({tokenIn,tokenOut,amountIn:inputRaw,gasInclude:'false',excludeRFQSources:'true'});
 const attempts=[];
 for(let attempt=0;attempt<3;attempt++){
  await waitForSlot();
  const start=performance.now(),requestedAt=new Date().toISOString();
  try{
   const response=await fetch(url,{headers:{'x-client-id':'equity-liquidity-lab'},signal:AbortSignal.timeout(20000)});
   const body=await response.json(),ms=performance.now()-start;
   attempts.push({requestedAt,ms,http:response.status,code:body.code,retryAfter:response.headers.get('retry-after')});
   if((response.status===429||response.status>=500)&&attempt<2){nextStart=Math.max(nextStart,Date.now()+Math.max(Number(response.headers.get('retry-after'))*1000||0,1000*2**attempt));continue;}
   const r=body.data?.routeSummary;
   let error;
   if(!response.ok||body.code!==0||!r)error=body.message??`HTTP ${response.status}`;
   else error=validateKyberEvidence(r,tokenIn,tokenOut,inputRaw);
   return {size,side,inputRaw,status:error?(response.status===429||response.status>=500?'error':'unavailable'):'ok',reason:error,observedAt:new Date().toISOString(),attempts,response:body};
  }catch(e){attempts.push({requestedAt,ms:performance.now()-start,error:e.message});if(attempt===2)return {size,side,inputRaw,status:'error',reason:e.message,attempts};}
 }
}
async function mapLimit(items,limit,fn){let cursor=0;const values=new Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(cursor<items.length){const k=cursor++;values[k]=await fn(items[k],k);}}));return values;}
const stats=values=>{const a=[...values].sort((x,y)=>x-y);return {count:a.length,medianMs:a[Math.floor(a.length*.5)]??null,p95Ms:a[Math.min(a.length-1,Math.floor(a.length*.95))]??null};};

for(const stock of result.policy.stocks){
 const reference=await getReference(stock),issuers=deploymentsForStock(stock).filter(i=>i.chain!=='solana'),routed=issuers.filter(i=>routesFor(i).length);
 const market={stock,reference,profiles:[],discovery:[]};result.markets.push(market);await save();
 console.log(JSON.stringify({phase:'direct-start',stock,profiles:routed.length}));
 const started=performance.now();
 // Match dashboard scheduling: chains parallel, profiles serial within each chain.
 await Promise.all([...new Set(routed.map(i=>i.chain))].map(async chain=>{
  for(const issuer of routed.filter(i=>i.chain===chain)){
   const t=performance.now(),rpc=[];
   const simulation=await simulateIssuer(issuer,reference,async(url,body)=>{const at=performance.now();try{return await fetchTransport(url,body);}finally{rpc.push({ms:performance.now()-at,calls:Array.isArray(body)?body.length:1});}});
   const profile={issuer, direct:{ms:performance.now()-t,rpc,simulation},kyber:null};market.profiles.push(profile);
   console.log(JSON.stringify({phase:'direct-done',stock,id:issuer.id,ms:profile.direct.ms,status:simulation.status,points:simulation.points.length,error:simulation.error}));await save();
  }
 }));
 market.directSweepMs=performance.now()-started;await save();
 const jobs=[];
 for(const profile of market.profiles){
  const {issuer,direct}=profile,s=direct.simulation;if(!s.normalization||!s.points.length)continue;
  const factor=BigInt(s.normalization.factorRaw),unit=10n**BigInt(issuer.decimals);
  const probes=['buy','sell'].map(side=>({size:10,side,inputRaw:(side==='buy'?parseUnits('10',issuer.settlementDecimals):parseUnits((10/reference.price).toFixed(12),18)*unit/factor).toString()}));
  profile.kyber={points:[],startedAt:null,finishedAt:null};
  for(const point of [...probes,...s.points])jobs.push({profile,point});
 }
 const kyberStart=performance.now();console.log(JSON.stringify({phase:'kyber-start',stock,requests:jobs.length}));
 await mapLimit(jobs,3,async({profile,point},index)=>{
  profile.kyber.startedAt??=new Date().toISOString();
  const q=await requestKyber(profile.issuer,point.side,point.size,point.inputRaw);
  if(q.status==='ok'){
   const raw=BigInt(q.response.data.routeSummary.amountOut),i=profile.issuer;
   const tokenRaw=point.side==='buy'?raw:BigInt(point.inputRaw),shares=Number(formatUnits(tokenRaw*BigInt(profile.direct.simulation.normalization.factorRaw)/(10n**BigInt(i.decimals)),18));
   q.outputRaw=raw.toString();q.shares=shares;q.price=(point.side==='buy'?point.size:Number(formatUnits(raw,i.settlementDecimals)))/shares;
   q.directStatus=point.status;q.directOutputRaw=point.outputRaw??null;
   q.outputDifferenceBps=point.outputRaw?Number(raw-BigInt(point.outputRaw))/Number(BigInt(point.outputRaw))*10000:null;
  }
  profile.kyber.points.push(q);profile.kyber.finishedAt=new Date().toISOString();
  if((index+1)%50===0){console.log(JSON.stringify({phase:'kyber-progress',stock,completed:index+1,total:jobs.length}));await save();}
 });
 market.kyberSweepMs=performance.now()-kyberStart;
 market.kyberLatency=stats(market.profiles.flatMap(p=>p.kyber?.points.flatMap(q=>q.attempts.map(a=>a.ms))??[]));await save();
 // Small buy-side discovery pass on every EVM deployment absent from the direct inventory.
 market.discovery=await mapLimit(issuers.filter(i=>!routesFor(i).length).flatMap(issuer=>[100,1000,10000].map(size=>({issuer,size}))),3,async({issuer,size})=>({issuerId:issuer.id,chain:issuer.chain,...await requestKyber(issuer,'buy',size,parseUnits(String(size),issuer.settlementDecimals).toString())}));
 await save();console.log(JSON.stringify({phase:'market-done',stock,directMs:market.directSweepMs,kyberMs:market.kyberSweepMs,latency:market.kyberLatency,discoveryOK:market.discovery.filter(x=>x.status==='ok').length}));
}
result.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({output,finishedAt:result.finishedAt}));
