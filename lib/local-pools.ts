import {encodeFunctionData,decodeFunctionResult,parseAbi,type Address,type Hex} from 'viem';
import {CHAINS,type Issuer,type Route} from './registry';
import {ethCall,rpcBatch,type Transport,type ParsedRouteQuote} from './simulator';
import {MissingWord,MissingTick,swapV3,sqrtAtTick,MIN_TICK,MAX_TICK,type V3State} from './v3-math';

export const LOCAL_ENGINE_VERSION='local-pools-v1';
export const stateMulticallAbi=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns((bool success,bytes returnData)[])']);
export const STATE_MULTICALL='0xca11bde05977b3631167028862be2a173976ca11' as Address;
export class LocalParityError extends Error{}
export const poolStateAbi=parseAbi([
 'function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)',
 // Only decode the shared prefix; Pancake and Slipstream have different trailing fields.
 'function slot0() view returns(uint160,int24)','function liquidity() view returns(uint128)',
 'function tickSpacing() view returns(int24)','function fee() view returns(uint24)',
 'function tickBitmap(int16) view returns(uint256)','function ticks(int24) view returns(uint128,int128)',
 'function getReserves() view returns(uint112,uint112,uint32)',
 'function balanceOf(address) view returns(uint256)',
]);
type Pool={id:Address;kind:'v3'|'v2';factory:string;token0:string;token1:string;balances?:bigint[];state?:V3State;reserves?:readonly [bigint,bigint,number];failed?:string};
export type LocalPoolStats={version:string;pools:number;stateReads:number;localQuotes:number;reusedQuotes:number;validationQuotes:number;fallbacks:Record<string,string>};
type StateCall={pool:Pool;fn:string;args?:(number|Address)[];to?:Address;field?:string};
type Job={route:Route;side:'buy'|'sell';amount:bigint};
const PANCAKE_V3='0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';
const PANCAKE_V2='0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const SLIPSTREAM='0xf8f2eb4940cfe7d13603dddd87f123820fc061ef';
/** Explicit protocol/factory allowlist, after the existing canonical route verification. */
export function locallySupported(issuer:Issuer,r:Route){
 const factory=(r.factory??CHAINS[issuer.chain].UniswapV3Factory).toLowerCase();
 if(r.version==='v3')return (r.venue==='uniswap'&&factory===CHAINS[issuer.chain].UniswapV3Factory.toLowerCase())||(r.venue==='pancakeswap'&&factory===PANCAKE_V3);
 if(r.version==='v2')return issuer.chain==='bsc'&&r.venue==='pancakeswap'&&factory===PANCAKE_V2;
 return r.version==='slipstream'&&issuer.chain==='base'&&r.venue==='aerodrome'&&factory===SLIPSTREAM;
}
/** One immutable block snapshot per capture. eth_calls flow through PoolReadCache on
 * the server, so bitmap/tick/reserve reads are shared centrally by block hash too. */
export class LocalPoolEngine{
 readonly stats:LocalPoolStats={version:LOCAL_ENGINE_VERSION,pools:0,stateReads:0,localQuotes:0,reusedQuotes:0,validationQuotes:0,fallbacks:{}};
 readonly checkedRanges=new Map<string,{min:bigint;max:bigint}>();
 private pools=new Map<string,Pool>();
 private replies=new Map<string,ParsedRouteQuote|null>();
 private initialized=false;
 constructor(readonly issuer:Issuer,readonly block:Hex,readonly transport?:Transport){}
 private async read(calls:StateCall[]):Promise<{value?:unknown;error?:string}[]>{
  this.stats.stateReads+=calls.length;
  const requests=calls.map(c=>ethCall(c.to??c.pool.id,encodeFunctionData({abi:poolStateAbi,functionName:c.fn as never,args:(c.args??[]) as never}),this.block));
  let replies:Awaited<ReturnType<typeof rpcBatch>>=[];
  // Official Multicall3 deployments; read-only getters only, never swap quoters
  // (their msg.sender / callbacks can matter). Bounded chunks stay below RPC gas limits.
  if(['ethereum','base','bsc'].includes(this.issuer.chain)&&calls.length>1){
   for(let start=0;start<calls.length;start+=128){const chunk=requests.slice(start,start+128);
    try{const [r]=await rpcBatch(this.issuer.chain,[ethCall(STATE_MULTICALL,encodeFunctionData({abi:stateMulticallAbi,functionName:'aggregate3',args:[chunk.map(q=>{const c=q.params[0] as {to:Address;data:Hex};return {target:c.to,allowFailure:true,callData:c.data};})]}),this.block)],this.transport);
     if(r.error)throw new Error(r.error.message);const values=decodeFunctionResult({abi:stateMulticallAbi,functionName:'aggregate3',data:r.result as Hex});if(values.length!==chunk.length)throw new Error('Incomplete state batch');
     replies.push(...values.map(v=>v.success?{result:v.returnData}:{error:{code:-1,message:'Pool state getter reverted'}}));
    }catch{replies.push(...await rpcBatch(this.issuer.chain,chunk,this.transport));}
   }
  }else replies=await rpcBatch(this.issuer.chain,requests,this.transport);
  return replies.map((r,k)=>{try{if(r.error)throw new Error(r.error.message);return {value:decodeFunctionResult({abi:poolStateAbi,functionName:calls[k].fn as never,data:r.result as Hex})};}catch(e){return {error:(e as Error).message.slice(0,160)};}});
 }
 private fail(pool:Pool,reason:string){pool.failed=reason;this.stats.fallbacks[pool.id]=reason;}
 async prepare(routes:Route[]){
  if(this.initialized)return;this.initialized=true;
  for(const r of routes.flatMap(r=>r.hops??[r]).filter(r=>locallySupported(this.issuer,r))){
   if(r.tokens.length!==r.poolIds.length+1||new Set(r.poolIds.map(p=>p.toLowerCase())).size!==r.poolIds.length)continue;
   r.poolIds.forEach((id,k)=>{const key=id.toLowerCase();if(!this.pools.has(key)){const tokens=[r.tokens[k].toLowerCase(),r.tokens[k+1].toLowerCase()].sort();this.pools.set(key,{id:key as Address,kind:r.version==='v2'?'v2':'v3',factory:(r.factory??CHAINS[this.issuer.chain].UniswapV3Factory).toLowerCase(),token0:tokens[0],token1:tokens[1]});}});
  }
  const calls:StateCall[]=[...this.pools.values()].flatMap(pool=>[...(pool.kind==='v2'?['factory','token0','token1','getReserves']:['factory','token0','token1','slot0','liquidity','tickSpacing','fee']).map(fn=>({pool,fn})),...(['token0','token1'] as const).map((token,k)=>({pool,fn:'balanceOf',to:pool[token] as Address,args:[pool.id],field:'balance'+k}))]);
  let result:Awaited<ReturnType<LocalPoolEngine['read']>>;
  try{result=await this.read(calls);}catch(e){for(const pool of this.pools.values())this.fail(pool,'Pool state unavailable: '+(e as Error).message);return;}
  const values=new Map<Pool,Record<string,any>>();
  calls.forEach((c,k)=>{if(result[k].error)this.fail(c.pool,result[k].error!);else{const v=values.get(c.pool)??{};v[c.field??c.fn]=result[k].value;values.set(c.pool,v);}});
  for(const [pool,v]of values){if(pool.failed)continue;try{
   for(const key of ['factory','token0','token1'] as const)if(String(v[key]).toLowerCase()!==pool[key])throw new Error('Pool '+key+' mismatch');
   pool.balances=[v.balance0,v.balance1];
   if(pool.kind==='v2'){if(v.getReserves[0]===0n||v.getReserves[1]===0n)throw new Error('Empty reserves');pool.reserves=v.getReserves;}
   else{
    const [sqrt,tick]=v.slot0,spacing=Number(v.tickSpacing),fee=Number(v.fee),liquidity=v.liquidity;
    if(!Number.isInteger(spacing)||spacing<=0||spacing>32767||fee<0||fee>=1000000||tick<MIN_TICK||tick>=MAX_TICK||sqrt<sqrtAtTick(tick)||sqrt>sqrtAtTick(tick+1))throw new Error('Invalid pool state');
    // A zero-liquidity start can require a very long bitmap scan before finding
    // another range. The contract remains authoritative for those rare paths.
    if(liquidity===0n)throw new Error('No active range; using contract quoter');
    pool.state={sqrt,tick,spacing,fee,liquidity,words:new Map(),ticks:new Map()};
   }
   this.stats.pools++;
  }catch(e){this.fail(pool,(e as Error).message);}}
 }
 private quote(job:Job):ParsedRouteQuote|null{
  const {route:r,side}=job;if(!locallySupported(this.issuer,r))return null;
  if(r.tokens.length!==r.poolIds.length+1||new Set(r.poolIds.map(p=>p.toLowerCase())).size!==r.poolIds.length)return null;
  const ids=side==='buy'?r.poolIds:[...r.poolIds].reverse(),tokens=side==='buy'?r.tokens:[...r.tokens].reverse();let amount=job.amount;
  for(let k=0;k<ids.length;k++){
   const pool=this.pools.get(ids[k].toLowerCase());if(!pool||pool.failed)return null;
   const tokenIn=tokens[k].toLowerCase(),tokenOut=tokens[k+1].toLowerCase(),zero=tokenIn===pool.token0;
   if(tokenIn!==(zero?pool.token0:pool.token1)||tokenOut!==(zero?pool.token1:pool.token0))return null;
   if(pool.kind==='v2'){
    if(amount<=0n)return null;const [a,b]=pool.reserves!,reserveIn=zero?a:b,reserveOut=zero?b:a,withFee=amount*9975n;
    amount=withFee*reserveOut/(reserveIn*10000n+withFee);if(amount===0n)return null;
   }else{
    const s=pool.state!;
    if(r.version==='v3'&&s.fee!==(side==='buy'?r.fees[k]:r.fees[r.fees.length-1-k]))return null;
    if(r.version==='slipstream'&&s.spacing!==r.tickSpacing)return null;
    try{const out=swapV3(s,amount,zero);if(!out.amount)return null;
     if(!out.complete)return null; // Contract quoter owns exhausted/reverting-path status.
     amount=out.amount;
    }catch(e){if(e instanceof MissingWord||e instanceof MissingTick)throw {pool,need:e};throw e;}
   }
   if(amount>pool.balances![zero?1:0])return null;
  }
  return {amount,complete:true,consumedInput:job.amount,gas:null,method:'local-pool'};
 }
 async quoteMany(jobs:Job[]):Promise<(ParsedRouteQuote|null)[]>{
  const pending=new Map<string,Job>();const key=(j:Job)=>j.route.id+':'+j.side+':'+j.amount;
  for(const j of jobs)if(this.replies.has(key(j)))this.stats.reusedQuotes++;else pending.set(key(j),j);
  for(let round=0;pending.size;round++){
   const needs=new Map<string,{pool:Pool;fn:string;args:number[]}>();
   for(const [k,j]of pending){try{const result=this.quote(j);this.replies.set(k,result);if(result)this.stats.localQuotes++;pending.delete(k);}catch(e){
    const request=e as {pool?:Pool;need?:MissingWord|MissingTick};
    if(request.pool&&request.need){const {pool,need}=request,s=pool.state!;
     const aggregate=['ethereum','base','bsc'].includes(this.issuer.chain),wordLimit=aggregate?16:4;
     if(round>=24||(need instanceof MissingWord&&s.words.size>=wordLimit)||s.ticks.size>=1024){this.stats.fallbacks[pool.id]='Local tick-state budget reached; using contract quoter outside loaded range';this.replies.set(k,null);pending.delete(k);continue;}
     const fn=need instanceof MissingWord?'tickBitmap':'ticks',n=need instanceof MissingWord?need.word:need.tick;
     for(const offset of need instanceof MissingWord&&aggregate?[-1,0,1]:[0]){const value=n+offset;if(fn==='tickBitmap'&&(s.words.has(value)||value<Math.floor(MIN_TICK/s.spacing/256)||value>Math.floor(MAX_TICK/s.spacing/256)))continue;needs.set(pool.id+':'+fn+':'+value,{pool,fn,args:[value]});}
    }else{this.stats.fallbacks[j.route.id]=(e as Error).message??'Local calculation unavailable';this.replies.set(k,null);pending.delete(k);}
   }}
   if(!needs.size)continue;
   const calls=[...needs.values()];let replies:Awaited<ReturnType<LocalPoolEngine['read']>>;
   try{replies=await this.read(calls);}catch(e){for(const c of calls)this.fail(c.pool,(e as Error).message);continue;}
   const ticks:{pool:Pool;fn:string;args:number[]}[]=[];
   calls.forEach((c,k)=>{const r=replies[k],s=c.pool.state!;if(r.error){this.fail(c.pool,r.error);return;}
    if(c.fn==='ticks'){const [gross,net]=r.value as readonly [bigint,bigint];if(!gross){this.fail(c.pool,'Initialized tick has zero liquidity');return;}s.ticks.set(c.args[0],net);}
    else{const word=r.value as bigint;s.words.set(c.args[0],word);const initialized:number[]=[];for(let bit=0;bit<256;bit++)if(word&(1n<<BigInt(bit)))initialized.push((c.args[0]*256+bit)*s.spacing);
     // Multicall fetches dense words in one RPC request instead of one round trip
     // per crossed tick. Bound total state, and fall back beyond that range.
     if(s.ticks.size+initialized.length<=1024&&(initialized.length<=16||['ethereum','base','bsc'].includes(this.issuer.chain)))for(const tick of initialized)if(!s.ticks.has(tick))ticks.push({pool:c.pool,fn:'ticks',args:[tick]});}
   });
   // Fetch initialized ticks together rather than one HTTP round trip per crossing.
   if(ticks.length){try{const values=await this.read(ticks);ticks.forEach((c,k)=>{if(values[k].error){this.fail(c.pool,values[k].error!);return;}const [gross,net]=values[k].value as readonly [bigint,bigint];if(gross===0n)this.fail(c.pool,'Initialized tick has zero liquidity');else c.pool.state!.ticks.set(c.args[0],net);});}catch(e){for(const c of ticks)this.fail(c.pool,(e as Error).message);}}
  }
  return jobs.map(j=>this.replies.get(key(j))??null);
 }
 /** Compact, reproducible provenance. Raw state reads remain in the shared RPC cache. */
 evidence(){return [...this.pools.values()].filter(p=>p.state||p.reserves).map(p=>({pool:p.id,kind:p.kind,fee:p.state?.fee??2500,tickSpacing:p.state?.spacing,bitmapWords:p.state?[...p.state.words.keys()].sort((a,b)=>a-b):[],initializedTicks:p.state?.ticks.size??0,fallback:p.failed}));}
}
