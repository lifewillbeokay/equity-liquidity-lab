import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionResult,decodeFunctionData} from 'viem';
import {ISSUERS,DEPLOYMENTS,routesFor,type Issuer,type Route} from '../lib/registry';
import {bestAcrossDeployments} from '../lib/view';
import {activeSolanaMultiplier,validateJupiterQuote} from '../lib/provider-simulator';
import {quoteRouteJobs,v3Abi,type Simulation} from '../lib/simulator';
import snapshot from '../lib/data/snapshot.json';
const fixture=snapshot.simulations[0] as Simulation;
function sim(id:string,buy:number,sell:number):Simulation{return {...fixture,issuerId:id,probe:{buyPrice:buy-1,sellPrice:sell+1},points:fixture.points.map(p=>({...p,status:'ok',price:p.side==='buy'?buy:sell,outputRaw:id==='a'?'9999999999999999999999999':'1'}))};}
const registry:Issuer[]=[{...ISSUERS[0],id:'a',groupId:'xstocks',stock:'AAPL',chain:'base',decimals:18},{...ISSUERS[0],id:'b',groupId:'xstocks',stock:'AAPL',chain:'solana',decimals:8},{...ISSUERS[0],id:'other',groupId:'xstocks',stock:'NVDA'}];
test('Issuer comparison selects normalized buy minimum and sell maximum across chains, never raw output units',()=>{
 const view=bestAcrossDeployments([sim('a',360,355),sim('b',358,357),sim('other',1,999)],'AAPL','xstocks','all','all',registry);
 assert.ok(view.points.every(p=>p.deploymentId==='b'));assert.equal(view.points.length,12);assert.equal(view.probe.buyPrice,357);assert.equal(view.probe.sellPrice,358);
 assert.ok(view.points.filter(p=>p.side==='buy').every(p=>Math.abs(p.impactBps!-(358/357-1)*10000)<1e-8));
 const chain=bestAcrossDeployments([sim('a',360,355),sim('b',358,357)],'AAPL','xstocks','all','base',registry);assert.ok(chain.points.every(p=>p.deploymentId==='a'));
});
test('Partial fills and errored deployments cannot win or erase healthy issuer quotes',()=>{
 const bad={...sim('b',1,999),status:'error' as const};let view=bestAcrossDeployments([sim('a',360,355),bad],'AAPL','xstocks','all','all',registry);assert.ok(view.points.every(p=>p.deploymentId==='a'));
 const partial={...sim('b',1,999),points:sim('b',1,999).points.map(p=>({...p,status:'partial' as const}))};view=bestAcrossDeployments([sim('a',360,355),partial],'AAPL','xstocks','all','all',registry);assert.ok(view.points.every(p=>p.deploymentId==='a'));
});
test('Solana active multiplier respects effective time and rejects unsupported transfer behavior',()=>{
 const info={extensions:[{extension:'scaledUiAmountConfig',state:{multiplier:1,newMultiplier:1.02,newMultiplierEffectiveTimestamp:100}}]};assert.equal(activeSolanaMultiplier(info,99),1);assert.equal(activeSolanaMultiplier(info,100),1.02);assert.throws(()=>activeSolanaMultiplier({...info,extensions:[...info.extensions,{extension:'pausableConfig',state:{paused:true}}]},101),/paused/);
});
test('Provider full-input estimates require token identity, exact raw input and a context slot',()=>{
 const q={inputMint:'in',outputMint:'out',inAmount:'100',outAmount:'200',swapMode:'ExactIn',contextSlot:12,routePlan:[{swapInfo:{}}]};assert.equal(validateJupiterQuote(q,'in','out',100n),200n);for(const bad of [{...q,inAmount:'99'},{...q,inputMint:'wrong'},{...q,contextSlot:undefined},{...q,routePlan:[]}])assert.throws(()=>validateJupiterQuote(bad,'in','out',100n));
});
test('Composite routes propagate raw outputs, reverse sell legs, and never continue after a partial hop',async()=>{
 const tokens=['0x0000000000000000000000000000000000000001','0x0000000000000000000000000000000000000002','0x0000000000000000000000000000000000000003'] as const;
 const leaf=(n:number):Route=>({id:String(n),venue:'uniswap',version:'v3',tokens:[tokens[n],tokens[n+1]],fees:[500],poolIds:[tokens[n]],label:'test'});
 const route:Route={id:'test',venue:'multi',version:'composite',tokens:[...tokens],fees:[],poolIds:[tokens[0],tokens[1]],hops:[leaf(0),leaf(1)],label:'test'};
 for(const side of ['buy','sell'] as const){const calls:any[]=[];const result=await quoteRouteJobs(ISSUERS[0],[{s:{side,input:100n},route}],'0x123',async(_url,body)=>(body as any[]).map(r=>{const d=decodeFunctionData({abi:v3Abi,data:r.params[0].data});calls.push(d.args![0]);return {id:r.id,result:encodeFunctionResult({abi:v3Abi,functionName:'quoteExactInputSingle',result:[calls.length===1?80n:60n,2n**96n,1,100n]})};}));assert.equal(calls[1].amountIn,80n);assert.equal(calls[0].tokenIn.toLowerCase(),side==='buy'?tokens[0]:tokens[2]);assert.equal(result.outs[0]?.amount,60n);assert.equal(result.outs[0]?.consumedInput,100n);}
 let calls=0;const partial=await quoteRouteJobs(ISSUERS[0],[{s:{side:'buy',input:100n},route}],'0x123',async(_url,body)=>(body as any[]).map(r=>{calls++;return {id:r.id,result:encodeFunctionResult({abi:v3Abi,functionName:'quoteExactInputSingle',result:[50n,4295128740n,1,100n]})};}));assert.equal(calls,1);assert.equal(partial.outs[0]?.complete,false);assert.equal(partial.outs[0]?.amount,0n);
});
test('Every registered route starts at its deployment settlement and ends at its token without repeated pools',()=>{
 for(const d of DEPLOYMENTS)for(const r of routesFor(d)){assert.equal(r.tokens[0].toLowerCase(),d.settlement.toLowerCase(),d.id+' '+r.id);assert.equal(r.tokens.at(-1)!.toLowerCase(),d.token.toLowerCase(),d.id+' '+r.id);assert.equal(new Set(r.poolIds.map(p=>p.toLowerCase())).size,r.poolIds.length);if(r.hops)for(let k=1;k<r.hops.length;k++)assert.equal(r.hops[k-1].tokens.at(-1)!.toLowerCase(),r.hops[k].tokens[0].toLowerCase());}
});

test('Nest Algebra rejects partial consumed input and accepts the deployed six-value response',async()=>{
 const {algebraAbi,parseQuote,encodeRouteQuote}=await import('../lib/simulator');const i=(await import('../lib/data/multi-asset-registry.json')).default.deployments.find(d=>d.stock==='NVDA'&&d.chain==='hyperevm'&&d.normalization==='wrapper')! as unknown as Issuer,route=routesFor(i).find(r=>r.venue==='nest')!;assert.ok(route);const encoded=encodeRouteQuote(i,route,'buy',100n);
 for(const consumed of [99n,100n]){const result=encodeFunctionResult({abi:algebraAbi,functionName:'quoteExactInputSingle',result:[200n,consumed,2n**96n,1,1000n,3000]});const q=parseQuote({result},encoded);assert.equal(q.complete,consumed===100n);assert.equal(q.amount,200n);assert.equal(q.gas,1000n);}
});
test('All registered V4 keys including composite leaves hash to their canonical pool IDs',async()=>{
 const {encodeAbiParameters,keccak256}=await import('viem');for(const d of DEPLOYMENTS)for(const route of routesFor(d))for(const r of route.hops??[route]){if(r.version!=='v4')continue;const k=r.key!;const hash=keccak256(encodeAbiParameters([{type:'address'},{type:'address'},{type:'uint24'},{type:'int24'},{type:'address'}],[k.currency0,k.currency1,k.fee,k.tickSpacing,k.hooks]));assert.equal(hash.toLowerCase(),r.poolIds[0].toLowerCase(),d.id+' '+r.id);}
});
test('Robinhood archive fallback replays the identical block and calldata on the official RPC',async()=>{
 const {rpcBatch}=await import('../lib/simulator');const calls:{url:string;body:unknown}[]=[];const result=await rpcBatch('robinhood',[{method:'eth_call',params:[{to:ISSUERS[4].token,data:'0x313ce567'},'0x123']}],async(url,body)=>{calls.push({url,body});return calls.length===1?[{id:1,error:{code:-32602,message:'Archive requests require a personal token'}}]:[{id:1,result:'0x12'}];});assert.equal(calls.length,2);assert.equal(calls[1].url,'https://rpc.mainnet.chain.robinhood.com');assert.deepEqual(calls[1].body,calls[0].body);assert.equal(result[0].result,'0x12');
});
test('Step-chart depth is the largest tested full order within impact, not summed or interpolated depth',async()=>{
 const {sampledDepth}=await import('../lib/view');const p=fixture.points[0];const points=[{...p,size:100,side:'buy' as const,status:'ok' as const,impactBps:10},{...p,size:1000,side:'buy' as const,status:'ok' as const,impactBps:50},{...p,size:5000,side:'buy' as const,status:'partial' as const,impactBps:40},{...p,size:10000,side:'buy' as const,status:'ok' as const,impactBps:200},{...p,size:50000,side:'sell' as const,status:'ok' as const,impactBps:20}];assert.equal(sampledDepth(points,'buy',.09),0);assert.equal(sampledDepth(points,'buy',.1),100);assert.equal(sampledDepth(points,'buy',1),1000);assert.equal(sampledDepth(points,'buy',2),10000);assert.equal(sampledDepth(points,'sell',.2),50000);
});
