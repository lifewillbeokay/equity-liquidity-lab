import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionResult,decodeFunctionData,zeroAddress} from 'viem';
import {fillDepth,fillBin,validDepth,ceilSqrt,type MetricDepth} from '../lib/metric-depth';
import {cachedMetricDepth} from '../lib/metric-cache';
import {MetricDepthEngine} from '../lib/metric-engine';
import {quoteRouteJobs,tokenAbi,simulateIssuer,metricPoolAbi,metricFactoryAbi,metricAbi} from '../lib/simulator';
import {ISSUERS,routesFor,type Route} from '../lib/registry';
const pool='0x755f5baa43f692550aa46be662240eeb99ae7502',Q=1n<<64n;
const quote=(extra:Partial<MetricDepth>={}):MetricDepth=>({poolAddress:pool,priceProviderStatus:'healthy',bidAdj:String(Q),askAdj:String(Q),serverTs:Math.floor(Date.now()/1000),depth:{bids:[{price:String(Q),cumulativeVolume:'1000',cumulativeInputVolume:'1000'}],asks:[{price:String(Q),cumulativeVolume:'1000',cumulativeInputVolume:'1000'}]},...extra});
test('Metric official curved bid example agrees to the raw unit',()=>{
 const q=quote({depth:{asks:[],bids:[{price:'49937913286041055521250',cumulativeVolume:'7430706558',cumulativeInputVolume:'2744786401520641763'},{price:'49932918995283375647711',cumulativeVolume:'21731301391',cumulativeInputVolume:'8027598362225637937'}]}});
 assert.equal(fillDepth(q,true,5000000000000000000n,18,6)?.amount,13535754492n);
 assert.equal(fillDepth(q,true,2744786401520641763n,18,6)?.amount,7430706558n);
 assert.equal(fillDepth(q,true,8027598362225637938n,18,6)?.complete,false);
});
test('integer square root is rounded up with large values',()=>{for(const x of [0n,1n,2n,3n,100n,(1n<<520n)+981n]){const y=ceilSqrt(x);assert.ok(y*y>=x);if(y>0n)assert.ok((y-1n)*(y-1n)<x);}});
test('ask curvature stays between proportional lower bound and true quadratic fill',()=>{
 for(let r=1n;r<900n;r++){const out=fillBin(r,900n,100n,10n*Q,true,0,0);assert.ok(out>=100n*r/900n);assert.ok(out<=100n);const required=out*(800n*100n+100n*out);assert.ok(required<=r*100n*100n);}
 assert.equal(fillBin(20n,100n,100n,2n*Q,true,0,0),20n,'zero low-price endpoint falls back');
 assert.equal(fillBin(20n,100n,100n,Q,false,0,0),20n,'flat bin');
});
test('freshness, side health, integer bounds, malformed depth and partial inputs are guarded',()=>{
 const q=quote();assert.equal(validDepth(q,pool),true);assert.equal(fillDepth(q,true,1001n,0,0)?.complete,false);assert.equal(fillDepth(q,false,1000n,0,0)?.amount,1000n);
 for(const bad of [quote({priceProviderStatus:'feed_down'}),quote({serverTs:q.serverTs-61}),quote({serverTs:q.serverTs+10}),quote({bidAdj:'1e20'}),quote({depth:{asks:[],bids:[{price:'1',cumulativeVolume:'0',cumulativeInputVolume:'1'}]}})])assert.equal(validDepth(bad,pool),false);
 assert.equal(fillDepth(quote({askAdj:((1n<<128n)-1n).toString()}),false,1n,0,0),null);assert.equal(fillDepth(quote({bidAdj:'0'}),true,1n,0,0),null);
 const repeated=quote();repeated.depth!.bids.push(repeated.depth!.bids[0]);assert.equal(validDepth(repeated,pool),true);assert.equal(fillDepth(repeated,true,1001n,0,0)?.consumedInput,1000n);
 const decreasing=quote();decreasing.depth!.bids.push({price:'1',cumulativeVolume:'1',cumulativeInputVolume:'1'});assert.equal(validDepth(decreasing,pool),false);
});
test('central depth cache batches misses and preserves original provider timestamps',async()=>{
 const objects=new Map<string,string>(),store={async get(k:string){const v=objects.get(k);return v?{async json(){return JSON.parse(v);}}:null;},async put(k:string,v:string){objects.set(k,v);}} as unknown as R2Bucket;
 let calls=0;const q=quote(),now=q.serverTs*1000,loader=async()=>{calls++;return {results:[{poolAddress:pool,quote:q}]};};
 const a=await cachedMetricDepth(store,56,[pool],loader,now);const b=await cachedMetricDepth(store,56,[pool,pool],loader,now+14000);assert.equal(calls,1);assert.deepEqual(b,a);
 await cachedMetricDepth(store,56,[pool],loader,now+15001);assert.equal(calls,2);
});
test('Metric leaf estimates propagate through composites without exact-local parity checks; partials fall back',async()=>{
 const issuer=ISSUERS.find(i=>i.id==='binance')!,route=routesFor(issuer).find(r=>r.version==='metric'&&r.poolIds[0].toLowerCase()===pool)!,q=quote();
 const engine=new MetricDepthEngine(issuer,'0x123',async(_url,body)=>(body as any[]).map(r=>({id:r.id,result:encodeFunctionResult({abi:tokenAbi,functionName:'decimals',result:18})})),async()=>({results:[{poolAddress:pool,quote:q}]}));
 await engine.prepare([route]);assert.equal(engine.quote(route,'buy',1001n),null);assert.equal(engine.quote(route,'sell',10n)?.method,'metric-depth');
 const composite:Route={...route,id:'test-composite',version:'composite',hops:[route,route]};
 let rpc=0;const result=await quoteRouteJobs(issuer,[{s:{side:'buy',input:100n},route:composite}],'0x123',async()=>{rpc++;return [];},undefined,engine);
 assert.equal(rpc,0);assert.equal(result.outs[0]?.complete,true);assert.equal(result.outs[0]?.metricSources?.length,2);assert.equal(result.outs[0]?.consumedInput,100n);
 const partial=await quoteRouteJobs(issuer,[{s:{side:'sell',input:1001n},route:composite}],'0x123',async(_u,body)=>(body as any[]).map(r=>({id:r.id,error:{code:-1,message:'execution reverted'}})),undefined,engine);assert.equal(partial.outs[0],null);
});
test('Metric prices normalize non-unit shares once and discard the entire API capture after a multiplier change',async()=>{
 const issuer=ISSUERS.find(i=>i.id==='binance')!,route=routesFor(issuer).find(r=>r.version==='metric'&&r.poolIds[0].toLowerCase()===pool)!,unit=10n**18n;
 for(const changed of [false,true]){let heads=0;const q=quote({bidAdj:String(100n*Q),askAdj:String(100n*Q),depth:{bids:[{price:String(100n*Q),cumulativeVolume:String(100000000n*unit),cumulativeInputVolume:String(1000000n*unit)}],asks:[{price:String(100n*Q),cumulativeVolume:String(1000000n*unit),cumulativeInputVolume:String(100000000n*unit)}]}});
 const result=await simulateIssuer(issuer,{price:50,updatedAt:new Date().toISOString(),fetchedAt:new Date().toISOString(),source:'fixture',label:'fixture'},async(_url,body)=>(body as any[]).map(r=>{
  if(r.method==='eth_chainId')return {id:r.id,result:'0x38'};
  if(r.method==='eth_getBlockByNumber'){const number=r.params[0]==='latest'?(heads++?'0x124':'0x123'):r.params[0];return {id:r.id,result:{number,hash:'0x'+'ab'.repeat(32),timestamp:'0x69000000'}};}
  const {to,data}=r.params[0],block=r.params[1];
  for(const abi of [tokenAbi,metricFactoryAbi,metricPoolAbi,metricAbi])try{const d=decodeFunctionData({abi,data});let value:unknown;
   if(d.functionName==='decimals')value=18;
   else if(d.functionName==='uiMultiplier')value=(changed&&block==='0x124'?3n:2n)*unit;
   else if(d.functionName==='isPool')value=String(d.args?.[0]).toLowerCase()===pool;
   else if(d.functionName==='getImmutables'&&to.toLowerCase()===pool){const components=metricPoolAbi[0].outputs[0].components;value=Object.fromEntries(components.map(c=>[c.name,c.type==='address'?zeroAddress:0n]));Object.assign(value as object,{factory:route.factory,token0:issuer.token,token1:issuer.settlement});}
   else if(d.functionName==='quoteLiveExactInSingle'){const a=d.args as readonly unknown[];value=[a[3],a[2]?BigInt(String(a[3]))*100n:BigInt(String(a[3]))/100n];}
   else throw new Error('Unrelated fixture route');
   return {id:r.id,result:encodeFunctionResult({abi,functionName:d.functionName as never,result:value as never})};
  }catch{}
  return {id:r.id,error:{code:-1,message:'execution reverted'}};
 }),{localPools:false,metricLoader:async()=>({results:[{poolAddress:pool,quote:q}]})});
 assert.equal(result.status,'ok',result.error);
 if(changed){assert.equal(result.metricDepth?.estimates,0);assert.ok(result.metricDepth?.fallbacks.normalization);assert.ok(result.points.every(p=>!p.metricSources?.length));}
 else{assert.ok(result.metricDepth!.estimates>0);assert.equal(result.normalization!.sharesPerToken,2);for(const p of result.points)assert.equal(p.price,50);}
 }
});
