import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,encodeFunctionResult,encodeAbiParameters,keccak256,parseUnits} from 'viem';
import {ISSUERS,routesFor,DEXES} from '../lib/registry';
import {parseQuote,encodeRouteQuote,v3Abi,slipstreamAbi,classicAbi,v2Abi,aeroAbi,metricAbi,tokenAbi,verifyRoutes,rpcBatch,simulateIssuer,type Simulation} from '../lib/simulator';
import snapshot from '../lib/data/snapshot.json';
import {simulationForVenue} from '../lib/view';

test('V3 exact-input exhaustion is rejected in either swap direction; interior prices remain valid',()=>{
 const issuer=ISSUERS[1],route=routesFor(issuer)[0];
 const encoded=encodeRouteQuote(issuer,route,'buy',100000000n);
 for(const price of [4295128740n,1461446703485210103287273052203988822378723970341n]){
  const result=encodeFunctionResult({abi:v3Abi,functionName:'quoteExactInputSingle',result:[1000n,price,3,80000n]});
  assert.equal(parseQuote({result},encoded).complete,false);
 }
 const result=encodeFunctionResult({abi:v3Abi,functionName:'quoteExactInputSingle',result:[1000n,2n**96n,3,80000n]});
 assert.equal(parseQuote({result},encoded).complete,true);
});
test('Every V4 PoolKey hashes to the discovered and verified pool ID',()=>{
 for(const issuer of ISSUERS)for(const r of routesFor(issuer).filter(r=>r.version==='v4')){
  const k=r.key!;const hash=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[k.currency0,k.currency1,k.fee,k.tickSpacing,k.hooks]));
  assert.equal(hash.toLowerCase(),r.id.toLowerCase());
 }
});
test('Buy and sell calldata reverse assets without changing raw amount or fee',()=>{
 const i=ISSUERS[1],r=routesFor(i)[0],amount=1234567890123456789n;
 for(const side of ['buy','sell'] as const){const e=encodeRouteQuote(i,r,side,amount);const d=decodeFunctionData({abi:v3Abi,data:e.data});const p=d.args![0] as {tokenIn:string;tokenOut:string;amountIn:bigint;fee:number};
 assert.equal(p.tokenIn.toLowerCase(),side==='buy'?i.settlement:i.token);assert.equal(p.tokenOut.toLowerCase(),side==='buy'?i.token:i.settlement);assert.equal(p.amountIn,amount);assert.equal(p.fee,r.fees[0]);}
});
test('RPC batch responses are matched by ID, not response position',async()=>{
 const replies=await rpcBatch('base',[{method:'eth_chainId',params:[]},{method:'eth_blockNumber',params:[]}],async()=>[{id:2,result:'0x222'},{id:1,result:'0x111'}]);
 assert.equal(replies[0].result,'0x111');assert.equal(replies[1].result,'0x222');
});
test('An unexpected chain cannot produce a ranked quote or stale point',async()=>{
 const s=await simulateIssuer(ISSUERS[0],snapshot.reference,async()=>[{id:1,result:{number:'0x123',timestamp:'0x123',hash:'0x123'}},{id:2,result:'0x1'}]);
 assert.equal(s.status,'error');assert.match(s.error!,/chain ID/);assert.deepEqual(s.points,[]);
});
test('Captured real quotes reconcile share prices, notional units, and extreme-impact flags',()=>{
 assert.equal(snapshot.simulations.length,5);
 let failed=0,extreme=0;
 for(const s of snapshot.simulations){const i=ISSUERS.find(i=>i.id===s.issuerId)!;assert.equal(s.status,'ok');assert.match(s.blockHash!,/^0x[0-9a-f]{64}$/);assert.equal(s.points.length,12);assert.ok(s.normalization!.sourceBlockHash);
  for(const p of s.points){if(p.status!=='ok'){failed++;assert.equal(p.price,null);continue;}
   assert.ok(p.shares!>0);const price=(p.side==='buy'?p.input:p.output!)/p.shares!;assert.ok(Math.abs(price-p.price!)<1e-7);
   if(p.side==='buy')assert.equal(p.inputRaw,parseUnits(String(p.size),i.settlementDecimals).toString());
   else assert.ok(Math.abs(p.shares!-p.size/snapshot.reference.price)<1e-7);
   assert.equal(p.consumedInputRaw,p.inputRaw);assert.ok(p.outputRaw);if(p.impactBps!>1000)extreme++;
  }
 }
 assert.ok(snapshot.simulations.some(s=>s.points.some(p=>(p.candidateQuotes as {fullInput:boolean|null}[]).some(c=>c.fullInput===false))),'Fixture must retain rejected partial candidates');assert.ok(extreme>0,'Fixture must retain economically poor quotes');
});

test('Slipstream uses signed tick spacing in its own ABI and rejects boundary partial fills',()=>{
 const issuer=ISSUERS[0],r=routesFor(issuer,'aerodrome').find(r=>r.version==='slipstream'&&r.tickSpacing===10)!;
 const encoded=encodeRouteQuote(issuer,r,'buy',100000000n);const decoded=decodeFunctionData({abi:slipstreamAbi,data:encoded.data});
 const args=decoded.args![0];assert.equal(args.tickSpacing,10);assert.equal('fee' in args,false);assert.equal(encoded.to,r.quoter);
 for(const sqrt of [4295128740n,1461446703485210103287273052203988822378723970341n]){
 const result=encodeFunctionResult({abi:slipstreamAbi,functionName:'quoteExactInputSingle',result:[28032367n,sqrt,1,100000n]});assert.equal(parseQuote({result},encoded).complete,false);
 }
});
test('Aerodrome classic reverses the route and decodes the final router amount',()=>{
 const issuer=ISSUERS[0],r=routesFor(issuer,'aerodrome').find(r=>r.version==='classic')!;
 const encoded=encodeRouteQuote(issuer,r,'sell',123456789n);const decoded=decodeFunctionData({abi:classicAbi,data:encoded.data});
 assert.equal(decoded.args[0],123456789n);assert.equal(decoded.args[1][0].from.toLowerCase(),issuer.token);assert.equal(decoded.args[1][0].to.toLowerCase(),issuer.settlement);assert.equal(decoded.args[1][0].stable,false);assert.equal(decoded.args[1][0].factory.toLowerCase(),r.factory);
 const result=encodeFunctionResult({abi:classicAbi,functionName:'getAmountsOut',result:[123456789n,987654n]});assert.deepEqual(parseQuote({result},encoded),{amount:987654n,gas:null,complete:true});
});
test('DEX filtering preserves the block, excludes other venues and recalculates the impact baseline',()=>{
 const s=snapshot.simulations.find(s=>s.issuerId==='coinbase')! as Simulation;
 for(const venue of ['uniswap','aerodrome'] as const){const view=simulationForVenue(s,venue);assert.equal(view.blockHash,s.blockHash);assert.ok(view.routes.every(r=>r.venue===venue));assert.equal(view.points.length,12);
  for(const p of view.points){if(p.status!=='ok')continue;assert.equal(p.venue,venue);const probe=p.side==='buy'?view.probe.buyPrice!:view.probe.sellPrice!;const bps=(p.side==='buy'?p.price!/probe-1:1-p.price!/probe)*10000;assert.ok(Math.abs(p.impactBps!-bps)<1e-8);
   const combined=s.points.find(q=>q.size===p.size&&q.side===p.side)!;assert.equal(combined.status,'ok');assert.ok(BigInt(combined.outputRaw!)>=BigInt(p.outputRaw!));
  }
 }
 for(const i of ISSUERS.filter(i=>!routesFor(i,'aerodrome').length)){const empty=simulationForVenue(snapshot.simulations.find(s=>s.issuerId===i.id)! as Simulation,'aerodrome');assert.equal(empty.status,'unavailable');assert.equal(empty.routes.length,0);assert.ok(empty.points.every(p=>p.status==='unavailable'));}
 const failed=simulationForVenue({...s,status:'error',points:[],error:'RPC unavailable'},'aerodrome');assert.equal(failed.status,'error');assert.deepEqual(failed.points,[]);
});

test('Metric uses consumed input, never output alone, to decide full fills',()=>{
 const i=ISSUERS.find(i=>i.id==='binance')!,r=routesFor(i,'metric')[0];const requested=10000000000000000000000n;
 for(const side of ['buy','sell'] as const){const encoded=encodeRouteQuote(i,r,side,requested);const decoded=decodeFunctionData({abi:metricAbi,data:encoded.data});assert.equal(decoded.args[2],side==='sell');assert.equal(decoded.args[1],r.router);assert.equal(decoded.args[3],requested);
  for(const consumed of [requested-1n,requested]){const result=encodeFunctionResult({abi:metricAbi,functionName:'quoteLiveExactInSingle',result:[consumed,500n]});const quote=parseQuote({result},encoded);assert.equal(quote.complete,consumed===requested);assert.equal(quote.amount,500n);assert.equal(quote.consumedInput,consumed);}
 }
});
test('Aero and V3 two-hop quotes reject either exhausted hop and reverse the whole sell path',()=>{
 for(const [issuer,version,abi] of [[ISSUERS[0],'aero',aeroAbi],[ISSUERS[3],'v3',v3Abi]] as const){
 const route=routesFor(issuer).find(r=>r.version===version&&r.poolIds.length===2)!;const encoded=encodeRouteQuote(issuer,route,'sell',100n);
 if(version==='aero'){const d=decodeFunctionData({abi:aeroAbi,data:encoded.data});assert.equal(d.functionName,'quoteExactInput');assert.deepEqual(d.args![0],route.poolIds.slice().reverse());assert.equal(String(d.args![1]).toLowerCase(),issuer.token);}
 for(const prices of [[4295128740n,2n**96n],[2n**96n,1461446703485210103287273052203988822378723970341n],[2n**96n,2n**96n]]){
 const result=encodeFunctionResult({abi,functionName:'quoteExactInput',result:(version==='aero'?[100n,prices,[1,2]]:[100n,prices,[1,2],70000n]) as never});assert.equal(parseQuote({result},encoded).complete,prices.every(p=>p===2n**96n));
 }
 }
});
test('Pancake V2 quotes use reversed sell path and final stablecoin output',()=>{
 const i=ISSUERS[3],route=routesFor(i).find(r=>r.version==='v2')!;const encoded=encodeRouteQuote(i,route,'sell',123n);const d=decodeFunctionData({abi:v2Abi,data:encoded.data});assert.equal(d.args[0],123n);assert.deepEqual(d.args[1].map(t=>t.toLowerCase()),route.tokens.slice().reverse().map(t=>t.toLowerCase()));const result=encodeFunctionResult({abi:v2Abi,functionName:'getAmountsOut',result:[123n,456n,789n]});assert.equal(parseQuote({result},encoded).amount,789n);
});
test('A multihop route is excluded when its second pool fails canonical factory verification',async()=>{
 const i=ISSUERS[3],route=routesFor(i,'pancakeswap').find(r=>r.version==='v3'&&r.poolIds.length===2)!;
 const checked=await verifyRoutes(i,[route],'0x123',async(_url,body)=>(body as {id:number;params:{data:`0x${string}`}[]}[]).map(req=>{
 const call=decodeFunctionData({abi:tokenAbi,data:req.params[0].data});const first=call.functionName==='getPool'&&String(call.args?.[0]).toLowerCase()===route.tokens[0].toLowerCase();const value=call.functionName==='factory'?route.factory!:first?route.poolIds[0]:'0x0000000000000000000000000000000000000000';return {id:req.id,result:encodeFunctionResult({abi:tokenAbi,functionName:call.functionName,result:value as never})};}));
 assert.equal(checked.routes.length,0);assert.match(checked.errors[0].reason,/mismatch/);
});
test('Every venue uses one snapshot; combined ranking never loses output to a full single-venue quote',()=>{
 for(const sim of snapshot.simulations){const s=sim as Simulation;for(const venue of DEXES){const view=simulationForVenue(s,venue);assert.equal(view.blockHash,s.blockHash);for(const p of view.points){if(p.status!=='ok')continue;assert.equal(p.venue,venue);const best=s.points.find(q=>q.side===p.side&&q.size===p.size)!;assert.equal(best.status,'ok');assert.ok(BigInt(best.outputRaw!)>=BigInt(p.outputRaw!));}}}
});
