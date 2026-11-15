import {readFile,writeFile} from 'node:fs/promises';
import {validateKyberEvidence} from './kyber-quote-evidence.mjs';
import {SIZES} from '../lib/registry.ts';

const [input,output,controlPath,strictControlPath]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: node --import tsx scripts/summarize-kyber-benchmark.mjs input.json summary.json');
const run=JSON.parse(await readFile(input,'utf8'));
const countBy=xs=>xs.reduce((a,x)=>(a[x]=(a[x]??0)+1,a),{});
const quantiles=xs=>{const a=[...xs].sort((a,b)=>a-b);return {n:a.length,min:a[0]??null,median:a[Math.floor(a.length*.5)]??null,p95:a[Math.min(a.length-1,Math.floor(a.length*.95))]??null,max:a.at(-1)??null};};
const pacing=attempts=>{
 const a=[...attempts].sort((a,b)=>Date.parse(a.requestedAt)-Date.parse(b.requestedAt));let j=0,max=0;const bursts=[],gaps=[];
 for(let k=0;k<a.length;k++){const at=Date.parse(a[k].requestedAt);while(Date.parse(a[j].requestedAt)<=at-1000)j++;max=Math.max(max,k-j+1);if(k-j+1>3)bursts.push(a[k].requestedAt);if(k)gaps.push(at-Date.parse(a[k-1].requestedAt));}
 return {minimumStartGapMs:gaps.length?Math.min(...gaps):null,maxStartsInRollingSecond:max,windowsOverThreeStarts:bursts,first429:a.find(x=>x.http===429)?.requestedAt??null};
};
const classify=(q,i)=>{
 const r=q.response?.data?.routeSummary,last=q.attempts.at(-1);
 if(!r||q.response.code!==0)return {status:last?.http===429?'rate_limited':last?.http>=500||!last?.http?'error':'no_route',reason:q.response?.message??q.reason};
 let reason;try{reason=validateKyberEvidence(r,q.side==='buy'?i.settlement:i.token,q.side==='buy'?i.token:i.settlement,q.inputRaw);}catch(e){reason=e.message;}
 return {status:reason?'invalid_evidence':'ok',reason};
};
const summary={startedAt:run.startedAt,finishedAt:run.finishedAt,directSourceCommit:run.directSourceCommit??null,environment:run.environment,policy:run.policy,validation:'Flow graph conservation; selected-edge remaining input; exact token/input/output identity. API estimates only, not wallet execution.',markets:[]};
for(const market of run.markets){
 const profiles=market.profiles.map(p=>{
  const qs=p.kyber?.points??[],dp=p.direct.simulation.points;
  const comparisons=qs.map(q=>{
   const validation=classify(q,p.issuer),d=dp.find(x=>x.size===q.size&&x.side===q.side),out=q.response?.data?.routeSummary?.amountOut;
   return {size:q.size,side:q.side,standard:SIZES.includes(q.size),...validation,directStatus:d?.status??'probe',directImpactBps:d?.impactBps??null,outputDifferenceBps:validation.status==='ok'&&d?.status==='ok'&&d.outputRaw?Number(BigInt(out)-BigInt(d.outputRaw))/Number(BigInt(d.outputRaw))*10000:null};
  });
  const standard=comparisons.filter(x=>x.standard),paired=standard.filter(x=>x.directStatus==='ok'),attempts=qs.flatMap(x=>x.attempts);
  return {id:p.issuer.id,issuer:p.issuer.name,chain:p.issuer.chain,token:p.issuer.token,settlement:p.issuer.settlement,
   direct:{elapsedMs:p.direct.ms,status:p.direct.simulation.status,blockNumber:p.direct.simulation.blockNumber,fetchedAt:p.direct.simulation.fetchedAt,standardQuotes:dp.filter(q=>SIZES.includes(q.size)&&q.status==='ok').length,totalSamples:dp.length+2},
   kyber:{elapsedMs:p.kyber?Date.parse(p.kyber.finishedAt)-Date.parse(p.kyber.startedAt):null,requests:qs.length,attempts:attempts.length,httpCounts:countBy(attempts.map(a=>a.http??'network_error')),standardCounts:countBy(standard.map(q=>q.status)),allCounts:countBy(comparisons.map(q=>q.status)),matchedDirectStandard:paired.filter(q=>q.status==='ok').length,directStandardDenominator:paired.length,latencyMs:quantiles(attempts.map(a=>a.ms)),successfulLatencyMs:quantiles(attempts.filter(a=>a.http===200).map(a=>a.ms)),outputDifferenceBps:quantiles(paired.flatMap(q=>q.outputDifferenceBps===null?[]:[q.outputDifferenceBps])),within1PercentBand:paired.filter(q=>q.directImpactBps!==null&&Math.abs(q.directImpactBps)<=100),comparisons}};
 });
 const attempts=market.profiles.flatMap(p=>p.kyber?.points.flatMap(q=>q.attempts)??[]);
 summary.markets.push({stock:market.stock,directSweepMs:market.directSweepMs,kyberSweepMs:market.kyberSweepMs,kyberToDirectRatio:market.kyberSweepMs/market.directSweepMs,standardExpected:profiles.length*50,directStandardQuotes:profiles.reduce((n,p)=>n+p.direct.standardQuotes,0),kyberStandardQuotes:profiles.reduce((n,p)=>n+(p.kyber.standardCounts.ok??0),0),kyberMatchedDirectStandard:profiles.reduce((n,p)=>n+p.kyber.matchedDirectStandard,0),requestCount:profiles.reduce((n,p)=>n+p.kyber.requests,0),attemptCount:attempts.length,httpCounts:countBy(attempts.map(a=>a.http??'network_error')),observedPacing:pacing(attempts),successfulLatencyMs:quantiles(attempts.filter(a=>a.http===200).map(a=>a.ms)),profiles,discovery:(market.discovery??[]).map(q=>({issuerId:q.issuerId,chain:q.chain,size:q.size,http:q.attempts.at(-1)?.http,apiCode:q.response?.code,apiSuccess:q.response?.code===0&&!!q.response?.data?.routeSummary,reason:q.response?.message??q.reason}))});
}
for(const [path,key] of [[controlPath,'rateControl'],[strictControlPath,'strictRateControl']])if(path){const control=JSON.parse(await readFile(path,'utf8'));summary[key]={startedAt:control.startedAt,finishedAt:control.finishedAt,intervalMs:control.intervalMs,requests:control.quotes.length,validQuotes:control.quotes.filter(q=>q.ok).length,httpCounts:countBy(control.quotes.map(q=>q.http??'network_error')),observedPacing:pacing(control.quotes),quotes:control.quotes.map(({response,...q})=>q)};}
await writeFile(output,JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary.markets.map(({profiles,discovery,...m})=>({...m,discoveryRequests:discovery.length,discoveryAPISuccess:discovery.filter(x=>x.apiSuccess).length})),null,2));
