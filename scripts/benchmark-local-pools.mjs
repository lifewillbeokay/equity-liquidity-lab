/** Same-block, read-only differential benchmark. No swaps, keys or paid providers.
 * node --import tsx scripts/benchmark-local-pools.mjs /absolute/result.json [profile-id]
 */
import {writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {DEPLOYMENTS,routesFor} from '../lib/registry.ts';
import {simulateIssuer,getReference,fetchTransport} from '../lib/simulator.ts';
import {poolStateAbi,stateMulticallAbi} from '../lib/local-pools.ts';
import {toFunctionSelector} from 'viem';
const output=resolve(process.argv[2]??'work/local-pools.json');await mkdir(dirname(output),{recursive:true});
const result={startedAt:new Date().toISOString(),environment:'Local Node.js; public RPCs; same pinned blocks; 4 chains in parallel, profiles sequential per chain',modes:['direct','localCold','localWarm'],markets:[]};
const selectors=new Set([...poolStateAbi,...stateMulticallAbi].map(a=>toFunctionSelector(a)));
let writes=Promise.resolve();const save=()=>{const json=JSON.stringify(result,null,2)+'\n';writes=writes.then(()=>writeFile(output,json));return writes;};
for(const stock of ['MSFT','AAPL']){
 const profiles=DEPLOYMENTS.filter(i=>(i.stock??'AAPL')===stock&&routesFor(i).length&&(!process.argv[3]||process.argv[3].split(',').includes(i.id)));if(!profiles.length)continue;
 const reference=await getReference(stock),market={stock,reference,profiles:[]};result.markets.push(market);
 await Promise.all([...new Set(profiles.map(i=>i.chain))].map(async chain=>{
  for(const issuer of profiles.filter(i=>i.chain===chain)){
   const heads=new Map(),stateCache=new Map(),profile={id:issuer.id,chain,runs:{}};market.profiles.push(profile);
   for(const mode of result.modes){
    let calls=0,batches=0,hits=0;const evidence=[];
    const transport=async(url,body)=>{
     const requests=body.map(req=>({...req,params:req.method==='eth_getBlockByNumber'&&req.params[0]==='latest'&&heads.has(url)?[heads.get(url).number,false]:req.params}));
     const key=req=>url+':'+JSON.stringify({method:req.method,params:req.params});
     const cacheable=req=>req.method==='eth_call'&&selectors.has(req.params[0]?.data?.slice(0,10));
     const missing=requests.filter(req=>!(mode==='localWarm'&&cacheable(req)&&stateCache.has(key(req))));
     const answers=missing.length?await fetchTransport(url,missing):[];calls+=missing.length;batches+=Number(!!missing.length);
     const byId=new Map(answers.map(r=>[r.id,r]));
     return requests.map(req=>{
      let r=byId.get(req.id);if(!r){r={...stateCache.get(key(req)),id:req.id};hits++;}
      if(req.method==='eth_getBlockByNumber'&&r.result?.number)heads.set(url,r.result);
      if(mode==='localCold'&&cacheable(req)&&typeof r.result==='string'){stateCache.set(key(req),r);evidence.push({url,request:{method:req.method,params:req.params},reply:r});}
      return r;
     });
    };
    const start=performance.now(),simulation=await simulateIssuer(issuer,reference,transport,{localPools:mode!=='direct'});
    profile.runs[mode]={ms:performance.now()-start,calls,batches,hits,simulation,...(mode==='localCold'?{stateEvidence:evidence}:{})};
    console.log(JSON.stringify({stock,id:issuer.id,mode,ms:profile.runs[mode].ms,calls,hits,status:simulation.status,points:simulation.points.length,local:simulation.localPools?.localQuotes,error:simulation.error}));await save();
   }
   const direct=profile.runs.direct.simulation,local=profile.runs.localCold.simulation;
   const points=s=>[...s.points,...Object.entries(s.venues??{}).flatMap(([venue,v])=>v.points.map(p=>({...p,scope:venue})))];
   const map=new Map(points(direct).map(p=>[[p.scope??'all',p.side,p.size].join(':'),p]));
   profile.comparison={compared:0,candidatesCompared:0,candidateMismatches:[],mismatches:[],sameBlock:direct.blockHash===local.blockHash};
   for(const p of points(local)){const key=[p.scope??'all',p.side,p.size].join(':'),d=map.get(key);if(!d){profile.comparison.mismatches.push({key,reason:'different adaptive sample'});continue;}profile.comparison.compared++;if(p.outputRaw!==d.outputRaw||p.status!==d.status||p.routeId!==d.routeId)profile.comparison.mismatches.push({key,direct:{output:d.outputRaw,status:d.status,route:d.routeId},local:{output:p.outputRaw,status:p.status,route:p.routeId}});}
   for(const p of local.points){const d=direct.points.find(q=>q.side===p.side&&q.size===p.size);for(const c of p.candidateQuotes??[]){const old=d?.candidateQuotes?.find(x=>x.routeId===c.routeId);if(!old)continue;profile.comparison.candidatesCompared++;if((old.fullInput===true)!==(c.fullInput===true)||(c.fullInput===true&&old.outputRaw!==c.outputRaw))profile.comparison.candidateMismatches.push({side:p.side,size:p.size,route:c.routeId,direct:old,local:c});}}
   console.log(JSON.stringify({stock,id:issuer.id,comparison:profile.comparison}));await save();
  }
 }));
}
result.finishedAt=new Date().toISOString();await save();
