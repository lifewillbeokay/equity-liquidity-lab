/** Metric's documented conservative depth estimator. Never an executable quote.
 * https://docs.metric.xyz/integrate/integrate-metric-liquidity/estimate-a-fill-from-depth
 */
export const METRIC_API='https://api.metric.xyz';
export const METRIC_MAX_AGE_MS=60_000;
export const METRIC_CACHE_MS=15_000;
const Q64=1n<<64n,MAX128=(1n<<128n)-1n;
export type DepthLevel={price:string;cumulativeVolume:string;cumulativeInputVolume:string};
export type MetricDepth={poolAddress:string;priceProviderStatus:string;bidAdj:string;askAdj:string;serverTs:number;depth:{bids:DepthLevel[];asks:DepthLevel[]}|null};
export type MetricBatch={results:{poolAddress:string;quote?:MetricDepth;error?:{status:number;error:string}}[]};
export type MetricLoader=(chainId:number,pools:string[])=>Promise<MetricBatch>;
const uint=(v:unknown)=>typeof v==='string'&&/^\d{1,78}$/.test(v)&&BigInt(v)<(1n<<256n);
const addr=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v);
export function validDepth(value:unknown,pool:string,now=Date.now()):value is MetricDepth{
 if(!value||typeof value!=='object')return false;const q=value as MetricDepth;
 if(!addr(q.poolAddress)||q.poolAddress.toLowerCase()!==pool.toLowerCase()||q.priceProviderStatus!=='healthy'||!Number.isSafeInteger(q.serverTs)||q.serverTs*1000<now-METRIC_MAX_AGE_MS||q.serverTs*1000>now+5000||!uint(q.bidAdj)||!uint(q.askAdj)||!q.depth)return false;
 for(const side of ['bids','asks'] as const){const levels=q.depth[side];if(!Array.isArray(levels)||levels.length>512)return false;let input=0n,output=0n;
  for(const l of levels){if(!uint(l.price)||BigInt(l.price)>MAX128||!uint(l.cumulativeVolume)||!uint(l.cumulativeInputVolume))return false;
   const i=BigInt(l.cumulativeInputVolume),o=BigInt(l.cumulativeVolume);if(i<input||o<output||(i===input)!==(o===output))return false;
   if(i>input&&(BigInt(l.price)<=0n||BigInt(l.price)===MAX128))return false;input=i;output=o;
  }
 }
 return true;
}
const ceilDiv=(a:bigint,b:bigint)=>(a+b-1n)/b;
export function ceilSqrt(n:bigint){if(n<0n)throw new Error('Negative square root');if(n<2n)return n;let x=1n<<BigInt(Math.ceil(n.toString(2).length/2));for(;;){const y=(x+n/x)/2n;if(y>=x)return x*x===n?x:x+1n;x=y;}}
export function fillBin(r:bigint,I:bigint,O:bigint,p:bigint,asks:boolean,dec0:number,dec1:number){
 const proportional=O*r/I,closeIn=asks?O*p*10n**BigInt(dec1)/(Q64*10n**BigInt(dec0)):O*Q64*10n**BigInt(dec0)/(p*10n**BigInt(dec1)),E=closeIn-I;
 if(E<=0n||E>=I)return proportional;
 const low=asks?p*(I-E)/(I+E):p;if(low<=0n)return proportional;
 let out:bigint;
 if(asks){const s=Q64*(I-E);out=(2n*Q64*r*O)/(s+ceilSqrt(s*s+(1n<<130n)*E*r));}
 else{const guess=O*r/(I-E),g=guess>O?O:guess;const needed=ceilDiv(g*(I-E)*((I+E)*O-E*g),O*((I+E)*O-2n*E*g));out=needed<=r?g:g*r/needed;}
 const margin=ceilDiv(2n*out,low)+1n;out=out>margin?out-margin:0n;return out<proportional?proportional:out>O?O:out;
}
export function fillDepth(q:MetricDepth,zeroForOne:boolean,input:bigint,dec0:number,dec1:number){
 if(input<=0n||input>MAX128||![dec0,dec1].every(d=>Number.isInteger(d)&&d>=0&&d<=36))return null;
 const asks=!zeroForOne,price=BigInt(asks?q.askAdj:q.bidAdj);if(q.priceProviderStatus!=='healthy'||!q.depth||price<=0n||price>=MAX128)return null;
 let remaining=input,amount=0n,prevIn=0n,prevOut=0n;
 for(const l of q.depth[asks?'asks':'bids']){const cumIn=BigInt(l.cumulativeInputVolume),cumOut=BigInt(l.cumulativeVolume),I=cumIn-prevIn,O=cumOut-prevOut;prevIn=cumIn;prevOut=cumOut;if(I===0n&&O===0n)continue;if(I<=0n||O<=0n)return null;
  if(remaining<I)return {amount:amount+fillBin(remaining,I,O,BigInt(l.price),asks,dec0,dec1),complete:true,consumedInput:input};
  amount+=O;remaining-=I;if(remaining===0n)return {amount,complete:true,consumedInput:input};
 }
 return {amount,complete:false,consumedInput:input-remaining};
}
export async function fetchMetricDepth(chainId:number,pools:string[]):Promise<MetricBatch>{
 if(![1,56,4663].includes(chainId)||!pools.length||pools.length>100||!pools.every(addr))throw new Error('Invalid Metric batch');
 const response=await fetch(`${METRIC_API}/public/v1/evm/${chainId}/bid_ask/batch`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pools,depth:true}),signal:AbortSignal.timeout(22000)});
 if(!response.ok){await response.body?.cancel();throw new Error(`Metric depth HTTP ${response.status}`);}
 // Bound streamed input before allocating/parsing a large provider response.
 const reader=response.body!.getReader(),decoder=new TextDecoder();let text='',bytes=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4*1024*1024)throw new Error('Metric response too large');text+=decoder.decode(value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel();}
 const batch=JSON.parse(text) as MetricBatch;if(!Array.isArray(batch.results)||batch.results.length>100)throw new Error('Invalid Metric response');
 const requested=new Set(pools.map(p=>p.toLowerCase())),seen=new Set<string>();
 for(const r of batch.results){if(!addr(r.poolAddress)||!requested.has(r.poolAddress.toLowerCase())||seen.has(r.poolAddress.toLowerCase()))throw new Error('Unexpected Metric pool');seen.add(r.poolAddress.toLowerCase());}
 return batch;
}
export const defaultMetricLoader:MetricLoader=async(chainId,pools)=>{
 if(typeof window==='undefined')return fetchMetricDepth(chainId,pools);
 const response=await fetch('/api/metric-depth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chainId,pools}),signal:AbortSignal.timeout(25000)});
 if(!response.ok)throw new Error(`Shared Metric depth HTTP ${response.status}`);return response.json();
};
