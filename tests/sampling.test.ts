import test from 'node:test';
import assert from 'node:assert/strict';
import {BASE_SIZES,ADAPTIVE_ROUNDS,MAX_ADAPTIVE_PER_SIDE,refinementRequests,type Sample} from '../lib/sampling';
import {bestAcrossDeployments,sampledDepth} from '../lib/view';
import {ISSUERS} from '../lib/registry';
import fixture from '../lib/data/snapshot.json';
import type {Simulation} from '../lib/simulator';
const point=(size:number,impactBps:number|null,status='ok',side:'buy'|'sell'='buy'):Sample=>({size,impactBps,status,side});
test('25 shared base sizes cover small orders and every $5k through the cap',()=>{
 assert.equal(BASE_SIZES.length,25);assert.equal(new Set(BASE_SIZES).size,25);
 assert.deepEqual(BASE_SIZES.slice(0,5),[100,250,500,1000,2500]);
 assert.deepEqual(BASE_SIZES.slice(5),Array.from({length:20},(_,i)=>(i+1)*5000));
});
test('refinement locates a full-fill boundary without inventing quotes',()=>{
 const quote=(size:number)=>point(size,size<=17300?20:null,size<=17300?'ok':'partial');
 const all=BASE_SIZES.map(quote);const initial=sampledDepth(all as any,'buy',1);assert.equal(initial,15000);
 for(let round=0;round<ADAPTIVE_ROUNDS;round++){const requests=refinementRequests([all],all);all.push(...requests.map(r=>quote(r.size)));}
 const depth=sampledDepth(all as any,'buy',1);assert.ok(depth>initial&&depth<=17300);assert.ok(17300-depth<=350);
 assert.ok(all.length-BASE_SIZES.length<=MAX_ADAPTIVE_PER_SIDE);assert.ok(all.some(p=>p.size===depth&&p.status==='ok'));
});
test('impact cliff and threshold crossing receive midpoint samples',()=>{
 const all=[point(10000,5),point(15000,7),point(20000,900)];
 const requests=refinementRequests([all],all);assert.ok(requests.some(r=>r.size===17500));
});
test('RPC errors and smooth flat curves do not create false cliffs',()=>{
 for(const all of [[point(10000,10),point(15000,null,'error')],[point(10000,null,'error'),point(15000,10)],[point(10000,1001),point(15000,5000)],[point(10000,5),point(15000,6)]])assert.deepEqual(refinementRequests([all],all),[]);
});
test('adaptive requests are unique, bounded, side-specific and preserve venue cliffs',()=>{
 const buys=[point(10000,1),point(15000,null,'partial')];const sells=[point(20000,1,'ok','sell'),point(25000,200,'ok','sell')];
 const attempted=[...buys,...sells,point(12500,2)];const requests=refinementRequests([buys,sells,buys],attempted);
 assert.ok(!requests.some(r=>r.size===12500));assert.deepEqual(requests,[{side:'sell',size:22500}]);
 const spent=[...buys,...Array.from({length:MAX_ADAPTIVE_PER_SIDE},(_,i)=>point(101+i,1))];assert.deepEqual(refinementRequests([buys],spent),[]);
});
test('cross-chain views retain actual adaptive sizes and never fabricate competing quotes',()=>{
 const raw=fixture.simulations[0] as unknown as Simulation;
 const adaptive={...raw.points[0],side:'buy' as const,size:17313,sampleKind:'adaptive' as const,status:'ok' as const,price:360};
 const a={...raw,issuerId:'a',points:[adaptive],probe:{buyPrice:359,sellPrice:358}};
 const b={...raw,issuerId:'b',points:[{...adaptive,size:15000,price:358,sampleKind:'base' as const}],probe:{buyPrice:357,sellPrice:356}};
 const registry=[{...ISSUERS[0],id:'a',groupId:'coinbase',chain:'base' as const},{...ISSUERS[0],id:'b',groupId:'coinbase',chain:'ethereum' as const}];
 const v=bestAcrossDeployments([a,b],'AAPL','coinbase','all','all',registry);
 assert.deepEqual(v.points.map(p=>p.size),[15000,17313]);assert.equal(v.points[1].deploymentId,'a');assert.equal(v.points[1].sampleKind,'adaptive');
 assert.equal(sampledDepth(v.points,'buy',1),17313);
});
test('EVM base and adaptive samples use one pinned block and reject incomplete fills',async()=>{
 const {simulateIssuer,tokenAbi,v3Abi}=await import('../lib/simulator');
 const {CHAINS,routesFor}=await import('../lib/registry');
 const {decodeFunctionData,encodeFunctionResult,zeroAddress}=await import('viem');
 const issuer=ISSUERS[0],route=routesFor(issuer).find(r=>r.version==='v3')!;assert.ok(route);
 const pinned='0x123',hash='0x'+'ab'.repeat(32),calls:string[]=[];
 const result=await simulateIssuer(issuer,{price:100,updatedAt:'2026-11-15T00:00:00Z',fetchedAt:'2026-11-15T00:00:00Z',source:'fixture',label:'fixture'},async(_url,body)=>(body as any[]).map(request=>{
  if(request.method==='eth_chainId')return {id:request.id,result:'0x'+CHAINS.base.id.toString(16)};
  if(request.method==='eth_getBlockByNumber')return {id:request.id,result:{number:pinned,hash,timestamp:'0x69000000'}};
  calls.push(request.params[1]);const {to,data}=request.params[0];
  try{
   const d=decodeFunctionData({abi:tokenAbi,data});let value:unknown;
   if(d.functionName==='decimals')value=to.toLowerCase()===issuer.token.toLowerCase()?issuer.decimals:issuer.settlementDecimals;
   else if(d.functionName==='multiplier')value=10n**18n;
   else if(d.functionName==='getPool')value=d.args?.[2]===route.fees[0]?route.poolIds[0]:zeroAddress;
   else if(d.functionName==='factory')value=to.toLowerCase()===(route.quoter??CHAINS.base.QuoterV2).toLowerCase()?CHAINS.base.UniswapV3Factory:zeroAddress;
   else throw new Error('exclude unrelated fixture routes');
   return {id:request.id,result:encodeFunctionResult({abi:tokenAbi,functionName:d.functionName,result:value as never})};
  }catch{}
  try{
   const d=decodeFunctionData({abi:v3Abi,data});if(d.functionName!=='quoteExactInputSingle')throw new Error('unsupported');
   const amount=d.args[0].amountIn;const complete=amount<=17300n*1000000n;
   return {id:request.id,result:encodeFunctionResult({abi:v3Abi,functionName:'quoteExactInputSingle',result:[amount,complete?2n**96n:4295128740n,1,100n]})};
  }catch{return {id:request.id,error:{code:-32000,message:'execution reverted'}};}
 }));
 assert.equal(result.status,'ok',result.error);assert.equal(result.blockHash,hash);assert.ok(calls.length>50);assert.ok(calls.every(b=>b===pinned));
 for(const side of ['buy','sell'] as const){
  assert.deepEqual(result.points.filter(p=>p.side===side&&p.sampleKind==='base').map(p=>p.size),BASE_SIZES);
  assert.ok(result.points.some(p=>p.side===side&&p.sampleKind==='adaptive'));
  const depth=sampledDepth(result.points,side,1);assert.ok(depth>15000&&depth<=17300);
  assert.ok(result.points.some(p=>p.side===side&&p.status==='partial'));
 }
});
test('public coverage is restricted to the requested five chains',async()=>{
 const {ACTIVE_CHAINS,DEPLOYMENTS,ACTIVE_DEXES}=await import('../lib/registry');
 assert.deepEqual(new Set(ACTIVE_CHAINS),new Set(['ethereum','robinhood','base','solana','bsc']));
 assert.ok(DEPLOYMENTS.every(d=>ACTIVE_CHAINS.includes(d.chain)));assert.equal(DEPLOYMENTS.length,107);
 assert.ok(!ACTIVE_DEXES.includes('jupiter'));assert.ok(!ACTIVE_DEXES.includes('stonfi'));assert.ok(!ACTIVE_DEXES.includes('fluxion'));assert.ok(!ACTIVE_DEXES.includes('nest'));
});

test('excluded Jupiter cannot trigger provider requests or return cached quotes',async()=>{
 const {DEPLOYMENTS,routesFor}=await import('../lib/registry');const {simulateIssuer}=await import('../lib/simulator');
 const issuer=DEPLOYMENTS.find(d=>d.chain==='solana')!;assert.equal(routesFor(issuer).length,0);
 const result=await simulateIssuer(issuer,(fixture.simulations[0] as unknown as Simulation).reference,async()=>{throw new Error('No network call expected');});
 assert.equal(result.status,'unavailable');assert.deepEqual(result.points,[]);assert.deepEqual(result.routes,[]);assert.match(result.coverageNote!,/Jupiter is excluded/);
});

test('previously captured Jupiter points cannot re-enter cross-chain rankings',async()=>{
 const {DEPLOYMENTS}=await import('../lib/registry');const {simulationForVenue}=await import('../lib/view');const d=DEPLOYMENTS.find(d=>d.chain==='solana')!;
 const old={...fixture.simulations[0],issuerId:d.id,points:[{...fixture.simulations[0].points[0],venue:'jupiter',price:1}],routes:[{...fixture.simulations[0].routes[0],venue:'jupiter'}]} as unknown as Simulation;
 assert.deepEqual(simulationForVenue(old,'all').points,[]);assert.deepEqual(bestAcrossDeployments([old],'AAPL','xstocks').points,[]);
});

test('Robinhood rate-limit fallback preserves the requested block and calldata',async()=>{
 const {rpcBatch}=await import('../lib/simulator');const calls:{url:string;body:unknown}[]=[];
 const result=await rpcBatch('robinhood',[{method:'eth_call',params:[{to:ISSUERS[4].token,data:'0x313ce567'},'0x123']}],async(url,body)=>{calls.push({url,body});if(calls.length===1)throw new Error('RPC HTTP 429: Too Many Requests');return [{id:1,result:'0x12'}];});
 assert.equal(calls.length,2);assert.equal(calls[1].url,'https://rpc.mainnet.chain.robinhood.com');assert.deepEqual(calls[1].body,calls[0].body);assert.equal(result[0].result,'0x12');
});
test('expected liquidity reverts allow rate recovery; real RPC throttles do not',async()=>{
 const {rpcThrottled}=await import('../lib/simulator');
 assert.equal(rpcThrottled([{id:1,error:{code:-32000,message:'execution reverted'}},{id:2,result:'0x1234'}]),false);
 assert.equal(rpcThrottled({error:{code:429,message:'Too Many Requests'}}),true);
 assert.equal(rpcThrottled([{id:1,error:{code:-32005,message:'Your IP has exceeded its request rate limit.'}}]),true);
});

test('opaque browser network failures still reach the official Robinhood RPC',async()=>{
 const {rpcBatch}=await import('../lib/simulator');const urls:string[]=[];const result=await rpcBatch('robinhood',[{method:'eth_call',params:[{to:ISSUERS[4].token,data:'0x313ce567'},'0x123']}],async(url)=>{urls.push(url);if(urls.length===1)throw new TypeError('Failed to fetch');return [{id:1,result:'0x12'}];});assert.equal(urls[1],'https://rpc.mainnet.chain.robinhood.com');assert.equal(result[0].result,'0x12');
});
test('failed refreshes preserve usable captures, original times and explicit failure provenance',async()=>{
 const {retainPreviousQuote}=await import('../lib/view');const old=fixture.simulations[0] as unknown as Simulation;const failure={...old,status:'error' as const,points:[],error:'Failed to fetch',fetchedAt:'2026-11-15T05:00:00Z'};const kept=retainPreviousQuote(failure,old);assert.deepEqual(kept.points,old.points);assert.equal(kept.fetchedAt,old.fetchedAt);assert.equal(kept.refreshError,'Failed to fetch');assert.equal(kept.lastRefreshAttempt,failure.fetchedAt);assert.equal(retainPreviousQuote(failure).status,'error');assert.equal(retainPreviousQuote(old,failure),old);
});
