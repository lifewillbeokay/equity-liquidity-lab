import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,encodeFunctionResult,type Hex} from 'viem';
import {Q96,MIN_SQRT,MAX_SQRT,MIN_TICK,MAX_TICK,sqrtAtTick,nextTick,swapV3,MissingWord,LocalWorkLimit,type V3State} from '../lib/v3-math';
import {LocalPoolEngine,LocalParityError,locallySupported,poolStateAbi,stateMulticallAbi} from '../lib/local-pools';
import {quoteRouteJobs,v3Abi} from '../lib/simulator';
import {ISSUERS,DEPLOYMENTS,routesFor} from '../lib/registry';
import fixtures from './fixtures/local-pools.json';
const state=(extra:Partial<V3State>={}):V3State=>({sqrt:Q96,tick:0,liquidity:1000000n,spacing:60,fee:3000,words:new Map([[0,0n],[-1,0n]]),ticks:new Map(),...extra});
test('tick constants and reciprocal prices retain exact Q96 rounding',()=>{
 assert.equal(sqrtAtTick(MIN_TICK),MIN_SQRT);assert.equal(sqrtAtTick(MAX_TICK),MAX_SQRT);assert.equal(sqrtAtTick(0),Q96);
 assert.equal(sqrtAtTick(1),79232123823359799118286999568n);assert.equal(sqrtAtTick(-1),79224201403219477170569942574n);
 assert.throws(()=>sqrtAtTick(1.5));
});
test('negative ticks floor into the preceding word; empty words retain their step boundary',()=>{
 const s=state({words:new Map([[-1,1n<<255n],[0,0n]])});
 assert.deepEqual(nextTick(s,-1,true),{tick:-60,initialized:true});
 assert.deepEqual(nextTick(s,-1,false),{tick:15300,initialized:false});
 assert.deepEqual(nextTick(s,-61,true),{tick:-15360,initialized:false});
 assert.throws(()=>nextTick(s,-20000,true),MissingWord);
});
test('known single-range swaps agree with constant-liquidity invariant and charge the exact input fee',()=>{
 for(const zero of [true,false]){const out=swapV3(state(),1000n,zero);assert.equal(out.amount,996n);assert.equal(out.consumedInput,1000n);assert.equal(out.complete,true);}
 const pool=state(),first=swapV3(pool,1000n,true);swapV3(pool,2000n,true);assert.deepEqual(swapV3(pool,1000n,true),first);assert.equal(pool.sqrt,Q96);assert.equal(pool.liquidity,1000000n);
});
test('crossing an initialized negative tick applies signed liquidity; unknown farther state is never zero-filled',()=>{
 const s=state({words:new Map([[-1,1n<<255n],[0,0n]]),ticks:new Map([[-60,500000n]])});
 const out=swapV3(s,10000n,true);assert.equal(out.complete,true);assert.ok(out.amount<swapV3(state(),10000n,true).amount);
 assert.throws(()=>swapV3(state({words:new Map()}),1n,true),MissingWord);
});
test('exhausted pools report consumed input and never masquerade as full fills',()=>{
 const spacing=200,words=new Map<number,bigint>();for(let w=-18;w<=17;w++)words.set(w,0n);
 const compressed=-1,word=-1,bit=255;words.set(word,1n<<BigInt(bit));
 const s=state({spacing,words,ticks:new Map([[compressed*spacing,1000000n]])});
 const out=swapV3(s,1000000n,true);assert.equal(out.complete,false);assert.ok(out.consumedInput<1000000n);assert.equal(out.sqrt,MIN_SQRT+1n);assert.ok(out.amount>0n);
});
test('unsupported hooks, forks and new Aero stay on their original contract quoter',()=>{
 for(const i of DEPLOYMENTS)for(const r of routesFor(i).flatMap(r=>r.hops??[r]))if(['v4','aero','metric','algebra','classic'].includes(r.version)||['up','ramses','communityv3','sushiswap'].includes(r.venue))assert.equal(locallySupported(i,r),false);
});
test('one pool snapshot prices independent sizes and refinement with no additional state reads',async()=>{
 const issuer=ISSUERS.find(i=>i.id==='ondo')!,route=routesFor(issuer)[0],tokens=route.tokens.slice().sort(),seen:Hex[]=[];
 const engine=new LocalPoolEngine(issuer,'0x123',async(_url,body)=>(body as any[]).map(r=>{
  seen.push(r.params[1]);const d=decodeFunctionData({abi:poolStateAbi,data:r.params[0].data});
  const values:Record<string,unknown>={factory:route.factory??'0x1F98431c8aD98523631AE4a59f267346ea31F984',token0:tokens[0],token1:tokens[1],slot0:[Q96,0],liquidity:10n**30n,tickSpacing:200,fee:route.fees[0],tickBitmap:0n,balanceOf:10n**35n};
  return {id:r.id,result:encodeFunctionResult({abi:poolStateAbi,functionName:d.functionName,result:values[d.functionName] as never})};
 }));
 await engine.prepare([route]);const jobs=[100n,250n,500n,1000n].flatMap(amount=>(['buy','sell'] as const).map(side=>({route,side,amount})));
 const outputs=await engine.quoteMany(jobs);assert.ok(outputs.every(o=>o?.complete));const reads=engine.stats.stateReads;
 const refined=await engine.quoteMany([{route,side:'buy',amount:375n}]);assert.equal(refined[0]?.complete,true);assert.equal(engine.stats.stateReads,reads);
 assert.deepEqual(await engine.quoteMany(jobs),outputs);assert.ok(seen.every(b=>b==='0x123'));
});
test('pool-state RPC failures return fallback, never fabricated empty liquidity',async()=>{
 const issuer=ISSUERS[1],route=routesFor(issuer)[0];const engine=new LocalPoolEngine(issuer,'0x123',async(_url,body)=>(body as any[]).map(r=>({id:r.id,error:{code:-1,message:'Unavailable state'}})));
 await engine.prepare([route]);assert.deepEqual(await engine.quoteMany([{route,side:'buy',amount:100n}]),[null]);assert.ok(Object.keys(engine.stats.fallbacks).length);
});
test('server work limits propagate for a leased browser handoff before costly work or any partial capture',async()=>{
 assert.throws(()=>swapV3(state(),1000n,true,{remaining:0}),LocalWorkLimit);
 const issuer=ISSUERS[1],route=routesFor(issuer)[0];let rpc=0;
 const engine=new LocalPoolEngine(issuer,'0x123',async()=>{rpc++;return [];},{stateReads:0,steps:{remaining:0}});
 await assert.rejects(engine.prepare([route]),LocalWorkLimit);assert.equal(rpc,0);
});
test('local results require authoritative same-block endpoint checks; a revert or mismatch aborts the tentative capture',async()=>{
 const issuer=ISSUERS[1],route=routesFor(issuer)[0],jobs=[100n,250n,500n].map(input=>({route,s:{side:'buy' as const,input}}));
 for(const failure of ['revert','mismatch','none']){
  const engine={checkedRanges:new Map(),stats:{validationQuotes:0},async quoteMany(js:{amount:bigint}[]){return js.map(j=>({amount:j.amount,gas:null,complete:true,method:'local-pool'}));}} as unknown as LocalPoolEngine;
  let calls=0;const transport=async(_url:string,body:unknown)=>(body as any[]).map(r=>{calls++;assert.equal(r.params[1],'0x123');const d=decodeFunctionData({abi:v3Abi,data:r.params[0].data}),p=d.args![0] as {amountIn:bigint};return failure==='revert'?{id:r.id,error:{code:-1,message:'Paused output token'}}:{id:r.id,result:encodeFunctionResult({abi:v3Abi,functionName:'quoteExactInputSingle',result:[p.amountIn+(failure==='mismatch'?1n:0n),Q96,0,100n]})};});
  if(failure==='none'){const result=await quoteRouteJobs(issuer,jobs,'0x123',transport,engine);assert.ok(result.outs.every(o=>o?.complete));assert.equal(calls,2);await quoteRouteJobs(issuer,[{route,s:{side:'buy',input:375n}}],'0x123',transport,engine);assert.equal(calls,2,'refinement inside checked range reuses liveness checks');}
  else await assert.rejects(quoteRouteJobs(issuer,jobs,'0x123',transport,engine),LocalParityError);
 }
});
test('captured AAPL/MSFT pool state reproduces real contract outputs exactly, including adaptive and multihop candidates',async()=>{
 let matched=0;
 for(const fixture of fixtures){const issuer=DEPLOYMENTS.find(i=>i.id===fixture.issuerId)!,block=('0x'+fixture.blockNumber.toString(16)) as Hex,missing:string[]=[];
  const values=new Map(fixture.reads.map(r=>[r.to.toLowerCase()+r.data,r.result]));
  const lookup=(to:string,data:string)=>{const key=to.toLowerCase()+data,value=values.get(key);if(value)return value as Hex;missing.push(key);throw new Error('Uncaptured state');};
  const engine=new LocalPoolEngine(issuer,block,async(_url,body)=>(body as any[]).map(r=>{assert.equal(r.params[1],block);const {to,data}=r.params[0];let result:Hex;
   if(data.startsWith('0x82ad56cb')){const calls=decodeFunctionData({abi:stateMulticallAbi,data}).args[0];result=encodeFunctionResult({abi:stateMulticallAbi,functionName:'aggregate3',result:calls.map(c=>({success:true,returnData:lookup(c.target,c.callData)}))});}
   else result=lookup(to,data);return {id:r.id,result};
  }));
  const routes=fixture.routes as unknown as ReturnType<typeof routesFor>;await engine.prepare(routes);
  const jobs=fixture.expected.map(e=>({route:routes.find(r=>r.id===e.routeId)!,side:e.side as 'buy'|'sell',amount:BigInt(e.inputRaw)}));
  const outputs=await engine.quoteMany(jobs);let count=0;
  outputs.forEach((o,k)=>{if(!o)return;const expected=fixture.expected[k];assert.equal(expected.fullInput,true);assert.equal(o.complete,true);assert.equal(o.amount.toString(),expected.outputRaw);count++;});
  assert.ok(count>=25,fixture.issuerId+' must exercise local math');assert.deepEqual(missing,[]);matched+=count;
 }
 assert.ok(matched>=150);
});
