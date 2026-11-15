/** Follow-up connectivity check, one buy/sell at $10k per benchmark profile.
 * Run after the main benchmark to avoid competing for its public rate budget.
 * node scripts/kyber-rate-control.mjs benchmark.json control.json
 */
import {readFile,writeFile} from 'node:fs/promises';
import {validateKyberEvidence} from './kyber-quote-evidence.mjs';
const [input,output,intervalArgument]=process.argv.slice(2);
if(!input||!output)throw new Error('Expected input and output JSON paths');
const run=JSON.parse(await readFile(input,'utf8'));
if(!run.finishedAt)throw new Error('Wait for the benchmark to finish before running the control');
const intervalMs=Number(intervalArgument??1100);if(!Number.isSafeInteger(intervalMs)||intervalMs<350)throw new Error('Interval must be at least 350 ms');
const result={startedAt:new Date().toISOString(),intervalMs,attemptsPerRequest:1,quotes:[]};
let next=0;
for(const m of run.markets)for(const profile of m.profiles)for(const side of ['buy','sell']){
 const i=profile.issuer,p=profile.direct.simulation.points.find(p=>p.side===side&&p.size===10000);if(!p)continue;
 while(Date.now()<next)await new Promise(r=>setTimeout(r,next-Date.now()));next=Date.now()+intervalMs;
 const tokenIn=side==='buy'?i.settlement:i.token,tokenOut=side==='buy'?i.token:i.settlement;
 const url=new URL(`https://aggregator-api.kyberswap.com/${i.chain}/api/v1/routes`);
 url.search=new URLSearchParams({tokenIn,tokenOut,amountIn:p.inputRaw,gasInclude:'false',excludeRFQSources:'true'});
 const start=performance.now(),requestedAt=new Date().toISOString();
 try{
  const response=await fetch(url,{headers:{'x-client-id':'equity-liquidity-lab'},signal:AbortSignal.timeout(20000)}),body=await response.json();
  const reason=body.code===0?validateKyberEvidence(body.data?.routeSummary,tokenIn,tokenOut,p.inputRaw):body.message;
  result.quotes.push({stock:m.stock,issuerId:i.id,chain:i.chain,size:10000,side,requestedAt,ms:performance.now()-start,http:response.status,retryAfter:response.headers.get('retry-after'),ok:response.ok&&!reason,reason,response:body});
 }catch(e){result.quotes.push({stock:m.stock,issuerId:i.id,chain:i.chain,size:10000,side,requestedAt,ms:performance.now()-start,ok:false,reason:e.message});}
}
result.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({quotes:result.quotes.length,ok:result.quotes.filter(q=>q.ok).length,http:result.quotes.reduce((a,q)=>(a[q.http??'error']=(a[q.http??'error']??0)+1,a),{}),elapsedMs:Date.parse(result.finishedAt)-Date.parse(result.startedAt)}));
