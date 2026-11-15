import {ADAPTIVE_ROUNDS,newSampling,refinementRequests,type SampleRequest} from './sampling';
import {parseUnits,formatUnits} from 'viem';
import {CHAINS,SIZES,routesFor,type Issuer} from './registry';
import type {Reference,Simulation,QuotePoint} from './simulator';
let jupiterNextAt=0,solanaNextAt=0;let solanaIdentityVerified=false;
async function json(url:string,init:RequestInit={},isJupiter=false):Promise<any>{
 for(let attempt=0;attempt<4;attempt++){
  if(isJupiter){const now=Date.now(),at=Math.max(now,jupiterNextAt);jupiterNextAt=at+2200;await new Promise(r=>setTimeout(r,Math.max(0,at-now)));}
  const r=await fetch(url,{...init,signal:AbortSignal.timeout(20000)});
  if((r.status===429||r.status>=500)&&attempt<3){const wait=Number(r.headers.get('retry-after'));await new Promise(resolve=>setTimeout(resolve,Math.min(15000,wait>0?wait*1000:2200*2**attempt)));continue;}
  if(!r.ok){const detail=(await r.text()).slice(0,200);throw new Error(`Quote source HTTP ${r.status}: ${detail}`);}return r.json();
 }
 throw new Error('Quote source retry exhausted');
}
async function solanaRpc(method:string,params:unknown[]){
 let error:unknown;for(const url of [CHAINS.solana.rpc,'https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com']){try{const now=Date.now(),at=Math.max(now,solanaNextAt);solanaNextAt=at+350;await new Promise(r=>setTimeout(r,Math.max(0,at-now)));const d=await json(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});if(d.error)throw new Error(d.error.message);return d.result;}catch(e){error=e;}}
 throw error;
}
export function activeSolanaMultiplier(info:any,unixTime:number):number{
 if(info.extensions?.some((e:any)=>e.extension==='pausableConfig'&&e.state.paused))throw new Error('Mint is paused');
 if(info.extensions?.some((e:any)=>e.extension==='transferHook'&&e.state.programId))throw new Error('Unsupported active transfer hook');
 if(info.extensions?.some((e:any)=>e.extension==='transferFeeConfig'))throw new Error('Transfer-fee mint requires a separate adapter');
 const e=info.extensions?.find((e:any)=>e.extension==='scaledUiAmountConfig')?.state;if(!e)throw new Error('Scaled UI normalization missing');
 const value=Number(unixTime>=Number(e.newMultiplierEffectiveTimestamp)?e.newMultiplier:e.multiplier);if(!Number.isFinite(value)||value<=0)throw new Error('Invalid multiplier');return value;
}
async function normalization(i:Issuer){
 const at=new Date().toISOString();
 if(i.chain==='solana'){
  if(!solanaIdentityVerified){const genesis=await solanaRpc('getGenesisHash',[]);if(genesis!=='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')throw new Error('Unexpected Solana network');solanaIdentityVerified=true;}
  const d=await solanaRpc('getAccountInfo',[i.token,{encoding:'jsonParsed',commitment:'confirmed'}]);const info=d.value?.data?.parsed?.info;
  if(d.value?.owner!=='TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'||info?.decimals!==i.decimals||!info?.isInitialized)throw new Error('Mint identity or decimals mismatch');
  const time=await solanaRpc('getBlockTime',[d.context.slot]);if(!Number.isFinite(time))throw new Error('Mint snapshot time unavailable');const multiplier=activeSolanaMultiplier(info,time);const factor=parseUnits(String(multiplier),18);
  return {factor,meta:{sharesPerToken:Number(formatUnits(factor,18)),method:'Token-2022 active scaled UI multiplier',source:`https://solscan.io/token/${i.token}`,asOf:new Date(time*1000).toISOString(),sourceChain:i.chain,sourceBlock:d.context.slot,sourceBlockHash:'',factorRaw:factor.toString()}};
 }
 const source=`https://tonapi.io/v2/blockchain/accounts/${i.token}/methods/get_display_multiplier`;const d=await json(source);
 if(!d.success||d.exit_code!==0)throw new Error('TON share multiplier unavailable');const numerator=BigInt(d.decoded.numerator),denominator=BigInt(d.decoded.denominator);if(numerator<=0n||denominator<=0n)throw new Error('Invalid TON multiplier');const factor=numerator*10n**18n/denominator;
 return {factor,meta:{sharesPerToken:Number(formatUnits(factor,18)),method:'TON get_display_multiplier numerator / denominator',source,asOf:at,sourceChain:i.chain,sourceBlock:0,sourceBlockHash:'',factorRaw:factor.toString()}};
}
export function validateJupiterQuote(d:any,tokenIn:string,tokenOut:string,input:bigint){
 if(d.inputMint!==tokenIn||d.outputMint!==tokenOut||d.swapMode!=='ExactIn'||String(d.inAmount)!==String(input)||!d.routePlan?.length||!Number.isFinite(d.contextSlot)||BigInt(d.outAmount??0)<=0n)throw new Error('Provider quote failed identity/full-input validation');
 return BigInt(d.outAmount);
}
export async function simulateProvider(i:Issuer,reference:Reference):Promise<Simulation>{
 const started=new Date().toISOString(),venue=i.chain==='solana'?'jupiter':'stonfi';
 const result:Simulation={issuerId:i.id,status:'error',quoteKind:'provider',quoteStartedAt:started,blockNumber:null,blockHash:null,blockTimestamp:null,fetchedAt:started,normalization:null,routes:routesFor(i),points:[],probe:{buyPrice:null,sellPrice:null},rpc:CHAINS[i.chain].rpc,reference};
 try{
  const norm=await normalization(i);result.normalization=norm.meta;const factor=norm.factor,unit=10n**BigInt(i.decimals);const all:QuotePoint[]=[];
  result.sampling=newSampling();
  const quoteSamples=async(requests:SampleRequest[])=>{for(const {side,size} of requests){
   const shares=parseUnits((size/reference.price).toFixed(12),18);const input=side==='buy'?parseUnits(String(size),i.settlementDecimals):shares*unit/factor;
   const tokenIn=side==='buy'?i.settlement:i.token,tokenOut=side==='buy'?i.token:i.settlement;
   const point:QuotePoint={sampleKind:SIZES.includes(size)||size===10?'base':'adaptive',deploymentId:i.id,chain:i.chain,venue,quoteKind:'provider',size,side,status:'unavailable',inputRaw:String(input),outputRaw:null,input:Number(formatUnits(input,side==='buy'?i.settlementDecimals:i.decimals)),output:null,shares:null,price:null,referenceBps:null,impactBps:null,routeId:null,routeLabel:null,gasUnits:null,candidateQuotes:[]};
   try{
    let output:bigint;
    if(i.chain==='solana'){
     const url='https://api.jup.ag/swap/v1/quote?'+new URLSearchParams({inputMint:tokenIn,outputMint:tokenOut,amount:String(input),swapMode:'ExactIn',slippageBps:'50'});const d=await json(url,{},true);if(d.error)throw new Error(d.error);output=validateJupiterQuote(d,tokenIn,tokenOut,input);
     point.contextSlot=d.contextSlot;point.routePlan=d.routePlan;point.routeId=d.routePlan[0].swapInfo.ammKey;point.routeLabel='Jupiter · '+Array.from(new Set(d.routePlan.map((r:any)=>r.swapInfo.label))).join(' + ');
    }else{
     const url='https://api.ston.fi/v1/swap/simulate?'+new URLSearchParams({offer_address:tokenIn,ask_address:tokenOut,units:String(input),slippage_tolerance:'0.005'});const d=await json(url,{method:'POST'});
     if(d.offer_address!==tokenIn||d.ask_address!==tokenOut||String(d.offer_units)!==String(input)||!d.pool_address||!d.router_address||BigInt(d.ask_units??0)<=0n)throw new Error('STON quote failed route/full-input validation');output=BigInt(d.ask_units);point.routeId=d.pool_address;point.routeLabel='STON.fi · USDT direct';point.routePlan=d;
    }
    point.status='ok';point.outputRaw=String(output);point.output=Number(formatUnits(output,side==='buy'?i.decimals:i.settlementDecimals));point.shares=Number(formatUnits((side==='buy'?output:input)*factor/unit,18));point.price=(side==='buy'?point.input:point.output)/point.shares;point.referenceBps=(point.price/reference.price-1)*10000;point.consumedInputRaw=String(input);
   }catch(e){point.status=/could not find pool|no liquidity|COULD_NOT_FIND_ANY_ROUTE|TOKEN_NOT_TRADABLE|NO_ROUTES_FOUND|insufficient liquidity/i.test((e as Error).message)?'unavailable':'error';point.reason=(e as Error).message.slice(0,150);}
   point.observedAt=new Date().toISOString();all.push(point);
  }};
  const impacts=()=>{for(const side of ['buy','sell'] as const){const probe=all.find(p=>p.side===side&&p.size===10&&p.status==='ok');result.probe[side==='buy'?'buyPrice':'sellPrice']=probe?.price??null;for(const p of all.filter(p=>p.side===side&&p.price!==null))if(probe?.price)p.impactBps=(side==='buy'?p.price!/probe.price-1:1-p.price!/probe.price)*10000;}};
  await quoteSamples((['buy','sell'] as const).flatMap(side=>[10,...SIZES].map(size=>({side,size}))));impacts();
  for(let round=0;round<ADAPTIVE_ROUNDS;round++){
   const requests=refinementRequests([all],all);if(!requests.length)break;
   await quoteSamples(requests);result.sampling.rounds++;for(const r of requests)result.sampling.adaptiveSizes[r.side].push(r.size);impacts();
  }
  const after=await normalization(i);if(after.factor!==factor)throw new Error('Share multiplier changed during quote collection; refresh required');
  result.points=all.filter(p=>p.size!==10).sort((a,b)=>a.side.localeCompare(b.side)||a.size-b.size);result.venues={[venue]:{points:result.points,probe:result.probe}};result.status=result.points.some(p=>p.status==='ok')?'ok':result.points.some(p=>p.status==='error')?'error':'unavailable';if(result.status==='error')result.error=result.points.find(p=>p.reason)?.reason;
  result.fetchedAt=new Date().toISOString();return result;
 }catch(e){return {...result,status:'error',points:[],venues:{},error:(e as Error).message.slice(0,180),fetchedAt:new Date().toISOString()};}
}
