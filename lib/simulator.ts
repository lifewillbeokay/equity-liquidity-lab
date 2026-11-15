import {encodeFunctionData,decodeFunctionResult,parseAbi,parseUnits,formatUnits,encodePacked,type Address,type Hex} from 'viem';
import {CHAINS,SIZES,routesFor,type Issuer,type Route,type ChainKey} from './registry';
export const tokenAbi=parseAbi([
 'function decimals() view returns(uint8)','function symbol() view returns(string)',
 'function multiplier() view returns(uint256)','function uiMultiplier() view returns(uint256)',
 'function toUIAmount(uint256) view returns(uint256)','function fromUIAmount(uint256) view returns(uint256)',
 'function convertToAssets(uint256) view returns(uint256)','function convertToShares(uint256) view returns(uint256)',
 'function asset() view returns(address)','function sharesMultiplier() view returns(uint256)',
 'function getPool(address,address,uint24) view returns(address)','function factory() view returns(address)',
 'function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)',
 'function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)',
 'function getSValue(address) view returns(uint128,bool)',
]);
export const v3Abi=parseAbi([
 'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
 'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
 'function quoteExactInput(bytes path,uint256 amountIn) returns(uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
 'function quoteExactOutput(bytes path,uint256 amountOut) returns(uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
]);
export const v4Abi=parseAbi([
 'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)',
 'function quoteExactOutputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountIn,uint256 gasEstimate)',
]);
export type Reference={price:number;updatedAt:string;fetchedAt:string;source:string;label:string};
export type RpcRequest={method:string;params:unknown[]};
export type RpcReply={result?:Hex|Record<string,unknown>;error?:{code:number;message:string;data?:unknown}};
export type Transport=(url:string,body:unknown)=>Promise<unknown>;
const fetchTransport:Transport=async(url,body)=>{
 for(let attempt=0;attempt<4;attempt++){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if((r.status===429||r.status>=500)&&attempt<3){await new Promise(resolve=>setTimeout(resolve,1000*2**attempt));continue;}
  if(!r.ok)throw new Error(`RPC HTTP ${r.status}`);return r.json();
 }
 throw new Error('RPC retry exhausted');
};
export async function rpcBatch(chain:ChainKey,requests:RpcRequest[],transport:Transport=fetchTransport):Promise<RpcReply[]>{
 const result:RpcReply[]=[];
 const batchSize=chain==='robinhood'?8:25;
 for(let offset=0;offset<requests.length;offset+=batchSize){
  const chunk=requests.slice(offset,offset+batchSize);const body=chunk.map((r,j)=>({jsonrpc:'2.0',id:offset+j+1,...r}));
  if(offset&&chain==='robinhood')await new Promise(resolve=>setTimeout(resolve,300));
  const data=await transport(CHAINS[chain].rpc,body) as (RpcReply&{id:number})[];
  if(!Array.isArray(data)){const one=data as unknown as RpcReply;throw new Error(one.error?.message||'Invalid RPC batch response');}
  const mapped=new Map(data.map(r=>[r.id,r]));result.push(...body.map(r=>mapped.get(r.id)||{error:{code:-1,message:'Missing RPC response'}}));
 }
 return result;
}
export function ethCall(to:Address,data:Hex,block:Hex):RpcRequest{return {method:'eth_call',params:[{to,data,gas:'0x1c9c380'},block]};}
export async function tokenCall(chain:ChainKey,to:Address,fn:string,args:unknown[],block:Hex,transport?:Transport){
 const data=encodeFunctionData({abi:tokenAbi,functionName:fn as never,args:args as never});
 const [r]=await rpcBatch(chain,[ethCall(to,data,block)],transport);if(r.error)throw new Error(r.error.message);
 return decodeFunctionResult({abi:tokenAbi,functionName:fn as never,data:r.result as Hex});
}
export function encodeRouteQuote(issuer:Issuer,route:Route,side:'buy'|'sell',amount:bigint,exactOutput=false){
 const tokens=side==='buy'?route.tokens:[...route.tokens].reverse(), fees=side==='buy'?route.fees:[...route.fees].reverse();
 const config=CHAINS[issuer.chain];
 if(route.version==='v3'){
  let fn:typeof v3Abi[number]['name'],args:unknown[];
  if(tokens.length===2){fn=exactOutput?'quoteExactOutputSingle':'quoteExactInputSingle';args=[[tokens[0],tokens[1],amount,fees[0],0n]];}
  else{fn=exactOutput?'quoteExactOutput':'quoteExactInput';const pathTokens=exactOutput?[...tokens].reverse():tokens,pathFees=exactOutput?[...fees].reverse():fees;const types:string[]=[],values:unknown[]=[];pathTokens.forEach((t,j)=>{types.push('address');values.push(t);if(j<pathFees.length){types.push('uint24');values.push(pathFees[j]);}});args=[encodePacked(types as never,values as never),amount];}
  return {to:config.QuoterV2.toLowerCase() as Address,abi:v3Abi,fn,data:encodeFunctionData({abi:v3Abi,functionName:fn,args:args as never})};
 }
 const fn=exactOutput?'quoteExactOutputSingle':'quoteExactInputSingle';const key=route.key!;
 return {to:config.V4Quoter.toLowerCase() as Address,abi:v4Abi,fn,data:encodeFunctionData({abi:v4Abi,functionName:fn,args:[{poolKey:key,zeroForOne:tokens[0].toLowerCase()===key.currency0.toLowerCase(),exactAmount:amount,hookData:'0x'}]})};
}
export function parseQuote(r:RpcReply,encoded:ReturnType<typeof encodeRouteQuote>){
 if(r.error)throw new Error(r.error.message);if(!r.result||typeof r.result!=='string')throw new Error('Empty quote response');
 const out=decodeFunctionResult({abi:encoded.abi,functionName:encoded.fn as never,data:r.result as Hex}) as readonly unknown[];
 const prices=encoded.abi===v3Abi?(Array.isArray(out[1])?out[1]:[out[1]]) as bigint[]:[];
 // V3 may return a partial fill at a price boundary. V4's canonical BaseV4Quoter
 // explicitly reverts unless the specified input delta is fully consumed.
 const complete=prices.every(p=>p>4295128740n&&p<1461446703485210103287273052203988822378723970341n);
 return {amount:out[0] as bigint,gas:out.at(-1) as bigint,complete};
}
export type QuotePoint={size:number;side:'buy'|'sell';status:'ok'|'partial'|'unavailable'|'error';inputRaw:string;outputRaw:string|null;input:number;output:number|null;shares:number|null;price:number|null;referenceBps:number|null;impactBps:number|null;routeId:string|null;routeLabel:string|null;gasUnits:string|null;reason?:string;consumedInputRaw?:string;candidateQuotes?:unknown[]};
export type Simulation={issuerId:string;status:'ok'|'error'|'unavailable';blockNumber:number|null;blockHash:string|null;blockTimestamp:string|null;fetchedAt:string;normalization:{sharesPerToken:number;method:string;source:string;asOf:string;sourceChain:ChainKey;sourceBlock:number;sourceBlockHash:string;factorRaw:string}|null;routes:Route[];points:QuotePoint[];probe:{buyPrice:number|null;sellPrice:number|null};error?:string;rpc:string;reference:Reference};
export type Snapshot={version:1;capturedAt:string;reference:Reference;simulations:Simulation[];coverageVersion:string};
export async function getReference():Promise<Reference>{
 let url='https://api.coinbase.com/v1/tokenized-stocks';
 for(let page=0;page<6;page++){
  const r=await fetch(url,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error('Reference source unavailable');const d=await r.json() as {tokens?:{symbol:string;nav_price:number;multiplier:number;nav_price_updated_at:string}[];next_page_token?:string};
  const list=d.tokens||[];
  const a=list.find((x:{symbol:string})=>x.symbol==='AAPLc');
  if(a&&Number(a.nav_price)>0&&Number(a.multiplier)>0)return {price:Number(a.nav_price)/Number(a.multiplier),updatedAt:a.nav_price_updated_at,fetchedAt:new Date().toISOString(),source:'https://api.coinbase.com/v1/tokenized-stocks',label:'Coinbase / Chainlink share reference'};
  const next=d.next_page_token; if(!next)break;url='https://api.coinbase.com/v1/tokenized-stocks?page_token='+encodeURIComponent(next);
 }
 throw new Error('Apple reference not found');
}
// All calls in a sweep are pinned to one block. Each size is independent.
export async function simulateIssuer(issuer:Issuer,reference:Reference,transport?:Transport):Promise<Simulation>{
 const base:Simulation={issuerId:issuer.id,status:'error',blockNumber:null,blockHash:null,blockTimestamp:null,fetchedAt:new Date().toISOString(),normalization:null,routes:routesFor(issuer),points:[],probe:{buyPrice:null,sellPrice:null},rpc:CHAINS[issuer.chain].rpc,reference};
 try{
  const [head,chainId]=await rpcBatch(issuer.chain,[{method:'eth_getBlockByNumber',params:['latest',false]},{method:'eth_chainId',params:[]}],transport);
  if(head.error||chainId.error)throw new Error(head.error?.message||chainId.error?.message);if(Number(BigInt(chainId.result as Hex))!==CHAINS[issuer.chain].id)throw new Error('Unexpected chain ID');
  const b=head.result as {number:Hex;hash:Hex;timestamp:Hex};const block=b.number;
  base.blockNumber=Number(BigInt(block));base.blockHash=b.hash;base.blockTimestamp=new Date(Number(BigInt(b.timestamp))*1000).toISOString();
  const decimals=Number(await tokenCall(issuer.chain,issuer.token,'decimals',[],block,transport));const quoteDecimals=Number(await tokenCall(issuer.chain,issuer.settlement,'decimals',[],block,transport));
  if(decimals!==issuer.decimals||quoteDecimals!==issuer.settlementDecimals)throw new Error('Token decimals changed or registry mismatch');
  const unit=10n**BigInt(issuer.decimals);
  let factor=1n*10n**18n,method='',normSource='onchain',normTime=base.blockTimestamp,normChain=issuer.chain,normBlock=base.blockNumber,normHash=base.blockHash;
  if(issuer.normalization==='wrapper'){
   const asset=await tokenCall(issuer.chain,issuer.token,'asset',[],block,transport);if(String(asset).toLowerCase()!=='0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a')throw new Error('Wrapper underlying changed');
   factor=await tokenCall(issuer.chain,issuer.token,'convertToAssets',[unit],block,transport) as bigint;method='ERC-4626 convertToAssets → adjusted AAPLx';
  }else if(issuer.normalization==='bep677'){
   factor=await tokenCall(issuer.chain,issuer.token,'uiMultiplier',[],block,transport) as bigint;method='BEP-677 uiMultiplier (1e18)';
  }else if(issuer.normalization==='b20'){
   factor=await tokenCall(issuer.chain,issuer.token,'multiplier',[],block,transport) as bigint;method='B20 multiplier';
  }else if(issuer.normalization==='ondo'){
   const [oh]=await rpcBatch('bsc',[{method:'eth_getBlockByNumber',params:['latest',false]}],transport);
   const ob=oh.result as {number:Hex;hash:Hex;timestamp:Hex};if(!ob?.number)throw new Error('Ondo normalization source unavailable');
   const ratio=await tokenCall('bsc','0xf4fd8a1b412633e10527454137a29db7aa35f15e','getSValue',['0x390a684ef9cade28a7ad0dfa61ab1eb3842618c4'],ob.number,transport) as readonly [bigint,boolean];
   if(ratio[1])throw new Error('Ondo shares oracle is paused');factor=ratio[0];method='Issuer-wide shares ratio · Ondo BNB oracle';normSource='https://bscscan.com/address/0xf4fd8a1b412633e10527454137a29db7aa35f15e#readContract';normTime=new Date(Number(BigInt(ob.timestamp))*1000).toISOString();normChain='bsc';normBlock=Number(BigInt(ob.number));normHash=ob.hash;
   const [oc]=await rpcBatch('bsc',[{method:'eth_getBlockByNumber',params:[ob.number,false]}],transport);if((oc.result as {hash?:string})?.hash!==ob.hash)throw new Error('Normalization snapshot block changed');
  }else{
   factor=await tokenCall(issuer.chain,issuer.token,'uiMultiplier',[],block,transport) as bigint;method='Robinhood uiMultiplier (1e18)';
  }
  if(factor<=0n)throw new Error('Invalid share conversion');
  const factorNumber=Number(formatUnits(factor,18));base.normalization={sharesPerToken:factorNumber,method,source:normSource,asOf:normTime!,sourceChain:normChain,sourceBlock:normBlock!,sourceBlockHash:normHash!,factorRaw:factor.toString()};
  if(!base.routes.length){base.status='unavailable';return base;}
  // Confirm all registered pools against canonical Uniswap deployments at this block.
  const verified:Route[]=[];
  for(const route of base.routes){
   if(route.version==='v3'){
    const pool=await tokenCall(issuer.chain,CHAINS[issuer.chain].UniswapV3Factory.toLowerCase() as Address,'getPool',[route.tokens[0],route.tokens[1],route.fees[0]],block,transport);
    if(String(pool).toLowerCase()!==route.poolIds[0].toLowerCase())continue;
   }else{const state=await tokenCall(issuer.chain,CHAINS[issuer.chain].StateView.toLowerCase() as Address,'getSlot0',[route.id],block,transport) as readonly bigint[];if(state[0]===0n)continue;}
   verified.push(route);
  }
  base.routes=verified;if(!verified.length){base.status='unavailable';return base;}
  const sizes=[10,...SIZES];const spec:{size:number;side:'buy'|'sell';input:bigint}[]=[];
  for(const side of ['buy','sell'] as const)for(const size of sizes){
   const shares=parseUnits((size/reference.price).toFixed(12),18);let input:bigint;
   if(side==='buy')input=parseUnits(String(size),issuer.settlementDecimals);
   else if(issuer.normalization==='wrapper')input=await tokenCall(issuer.chain,issuer.token,'convertToShares',[shares],block,transport) as bigint;
   else input=shares*unit/factor;
   spec.push({size,side,input});
  }
  const jobs=spec.flatMap(s=>verified.map(route=>({s,route,encoded:encodeRouteQuote(issuer,route,s.side,s.input)})));
  const raw=await rpcBatch(issuer.chain,jobs.map(j=>ethCall(j.encoded.to,j.encoded.data,block)),transport);
  const outs=raw.map((r,j)=>{try{return parseQuote(r,jobs[j].encoded);}catch{return null;}});
  const points:QuotePoint[]=[];
  for(const s of spec){
   const candidates=jobs.map((j,k)=>({j,k,out:outs[k]})).filter(x=>x.j.s===s);
   const good=candidates.filter(x=>x.out&&x.out.amount>0n&&x.out.complete);
   good.sort((a,b)=>a.out!.amount>b.out!.amount?-1:1);const best=good[0];
   const point:QuotePoint={size:s.size,side:s.side,status:'unavailable',inputRaw:s.input.toString(),outputRaw:null,input:Number(formatUnits(s.input,s.side==='buy'?issuer.settlementDecimals:issuer.decimals)),output:null,shares:null,price:null,referenceBps:null,impactBps:null,routeId:null,routeLabel:null,gasUnits:null,candidateQuotes:candidates.map(x=>({routeId:x.j.route.id,outputRaw:x.out?.amount.toString()??null,fullInput:x.out?.complete??null,error:raw[x.k].error?.message}))};
   if(best){
    const output=best.out!.amount;point.status='ok';point.outputRaw=output.toString();point.output=Number(formatUnits(output,s.side==='buy'?issuer.decimals:issuer.settlementDecimals));
    const tokenAmount=s.side==='buy'?output:s.input;
    const shareAmount=issuer.normalization==='wrapper'?await tokenCall(issuer.chain,issuer.token,'convertToAssets',[tokenAmount],block,transport) as bigint:tokenAmount*factor/unit;
    point.shares=Number(formatUnits(shareAmount,18));point.price=(s.side==='buy'?point.input:point.output)/point.shares;
    point.referenceBps=(point.price/reference.price-1)*10000;point.routeId=best.j.route.id;point.routeLabel=best.j.route.label;point.gasUnits=best.out!.gas.toString();point.consumedInputRaw=s.input.toString();
   }else{
    const partial=candidates.find(x=>x.out&&x.out.amount>0n&&!x.out.complete);
    const error=candidates.every(x=>raw[x.k].error&&!/revert|liquidity|insufficient|execution/i.test(raw[x.k].error!.message));
    point.status=partial?'partial':error?'error':'unavailable';point.reason=partial?'Pool cannot consume the full requested input':error?'RPC quote request failed':'No complete quote at this size';

   }
   points.push(point);
  }
  for(const side of ['buy','sell'] as const){const probe=points.find(p=>p.side===side&&p.size===10&&p.status==='ok');base.probe[side==='buy'?'buyPrice':'sellPrice']=probe?.price??null;for(const p of points.filter(p=>p.side===side&&p.price!==null)){if(probe?.price)p.impactBps=(side==='buy'?p.price!/probe.price-1:1-p.price!/probe.price)*10000;}}
  base.points=points.filter(p=>p.size!==10);
  const [check]=await rpcBatch(issuer.chain,[{method:'eth_getBlockByNumber',params:[block,false]}],transport);
  if((check.result as {hash?:string})?.hash!==b.hash)throw new Error('Snapshot block changed during collection');
  base.status=base.points.some(p=>p.status==='ok')?'ok':base.points.every(p=>p.status==='error')?'error':'unavailable';if(base.status==='error')base.error='RPC quote requests failed';base.fetchedAt=new Date().toISOString();return base;
 }catch(e){base.status='error';base.error=(e as Error).message.slice(0,180);base.points=[];return base;}
}
