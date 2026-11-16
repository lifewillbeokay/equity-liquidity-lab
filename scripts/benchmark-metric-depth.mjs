/** Read-only end-to-end AAPL/MSFT comparison. API snapshots are NOT block-pinned.
 * node --import tsx scripts/benchmark-metric-depth.mjs /absolute/result.json [profile-ids]
 */
import {writeFile} from 'node:fs/promises';
import {DEPLOYMENTS} from '../lib/registry.ts';
import {simulateIssuer,getReference,fetchTransport} from '../lib/simulator.ts';
import {fetchMetricDepth} from '../lib/metric-depth.ts';
const output=process.argv[2];if(!output)throw new Error('Evidence output required');
const ids=(process.argv[3]??'binance,robinhood,ondo-robinhood,robinhood-msft-robinhood').split(',');
const result={startedAt:new Date().toISOString(),environment:'Local Node.js / public RPCs, contract calls pinned across modes; Metric API has its own serverTs. No gas, swaps or keys.',profiles:[]};
let saves=Promise.resolve();const save=()=>{const json=JSON.stringify(result,null,2)+'\n';saves=saves.then(()=>writeFile(output,json));return saves;};
const refs=Object.fromEntries(await Promise.all(['AAPL','MSFT'].map(async s=>[s,await getReference(s)])));
await Promise.all(['bsc','robinhood'].map(async chain=>{for(const issuer of DEPLOYMENTS.filter(d=>ids.includes(d.id)&&d.chain===chain)){
 const profile={id:issuer.id,stock:issuer.stock??'AAPL',runs:{}},heads=new Map();result.profiles.push(profile);
 for(const mode of ['metricDepth','contracts']){
  let rpc=0,batches=0,api=0,apiMs=0;const transport=async(url,body)=>{const reqs=body.map(r=>r.method==='eth_getBlockByNumber'&&r.params[0]==='latest'&&heads.has(url)?{...r,params:[heads.get(url).number,false]}:r);rpc+=reqs.length;batches++;const replies=await fetchTransport(url,reqs);for(const r of replies)if(r.result?.number)heads.set(url,r.result);return replies;};
  const loader=async(chainId,pools)=>{api++;const t=performance.now();try{return await fetchMetricDepth(chainId,pools);}finally{apiMs+=performance.now()-t;}};
  const start=performance.now();const simulation=await simulateIssuer(issuer,refs[profile.stock],transport,{localPools:false,metricDepth:mode==='metricDepth',metricLoader:loader});
  profile.runs[mode]={ms:performance.now()-start,rpc,batches,api,apiMs,simulation};console.log(JSON.stringify({id:issuer.id,mode,ms:profile.runs[mode].ms,rpc,apiMs,points:simulation.points.length,status:simulation.status,metric:simulation.metricDepth&&{...simulation.metricDepth,state:undefined},error:simulation.error}));await save();
 }
 const a=profile.runs.metricDepth.simulation,b=profile.runs.contracts.simulation,comparisons=[];
 for(const p of a.points){const d=b.points.find(q=>q.side===p.side&&q.size===p.size);if(!d)continue;for(const c of p.candidateQuotes??[]){const old=d.candidateQuotes?.find(x=>x.routeId===c.routeId);if(!old||!c.metricSources?.length)continue;comparisons.push({side:p.side,size:p.size,route:c.routeId,estimate:c.outputRaw,contract:old.outputRaw,fullEstimate:c.fullInput,fullContract:old.fullInput,deltaBps:c.fullInput&&old.fullInput&&Number(old.outputRaw)>0?(Number(c.outputRaw)/Number(old.outputRaw)-1)*10000:null,observedAt:c.metricSources[0].observedAt});}}
 profile.comparison={sameContractBlock:a.blockHash===b.blockHash,apiBlockPinned:false,standardPoints:a.points.filter(p=>p.sampleKind==='base').length,estimateWinners:a.points.filter(p=>p.metricSources?.length).length,contractFullPoints:b.points.filter(p=>p.status==='ok').length,depthModeFullPoints:a.points.filter(p=>p.status==='ok').length,candidates:comparisons};await save();
}}));result.finishedAt=new Date().toISOString();await save();
