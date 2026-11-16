import {decodeFunctionResult,encodeFunctionData,type Address,type Hex} from 'viem';
import {CHAINS,type Issuer,type Route} from './registry';
import {rpcBatch,ethCall,tokenAbi,type Transport,type ParsedRouteQuote} from './simulator';
import {defaultMetricLoader,validDepth,fillDepth,type MetricDepth,type MetricLoader} from './metric-depth';
export type MetricEvidence={pool:string;observedAt:string;source:'metric-depth'};
export class MetricDepthEngine{
 readonly snapshots=new Map<string,MetricDepth>();readonly decimals=new Map<string,number>();
 readonly stats={pools:0,estimates:0,fallbacks:{} as Record<string,string>};
 constructor(readonly issuer:Issuer,readonly block:Hex,readonly transport?:Transport,readonly loader:MetricLoader=defaultMetricLoader){}
 async prepare(routes:Route[]){
  const leaves=[...new Map(routes.flatMap(r=>r.hops??[r]).filter(r=>r.version==='metric').map(r=>[r.poolIds[0].toLowerCase(),r])).values()];
  if(!leaves.length)return;const pools=leaves.map(r=>r.poolIds[0]);
  try{
   const batch=await this.loader(CHAINS[this.issuer.chain].id,pools);
   for(const pool of pools){const result=batch.results.find(r=>r.poolAddress.toLowerCase()===pool.toLowerCase());const reason=(result?.quote?.priceProviderStatus==='healthy'?'Stale or invalid depth':result?.quote?.priceProviderStatus)??result?.error?.error??'Missing, stale or invalid depth';if(validDepth(result?.quote,pool))this.snapshots.set(pool.toLowerCase(),result!.quote!);else this.stats.fallbacks[pool]=reason;}
   const tokens=[...new Set(leaves.filter(r=>this.snapshots.has(r.poolIds[0].toLowerCase())).flatMap(r=>r.tokens.map(t=>t.toLowerCase())))];
   const replies=await rpcBatch(this.issuer.chain,tokens.map(t=>ethCall(t as Address,encodeFunctionData({abi:tokenAbi,functionName:'decimals'}),this.block)),this.transport);
   tokens.forEach((t,k)=>{try{if(replies[k].error)return;const d=Number(decodeFunctionResult({abi:tokenAbi,functionName:'decimals',data:replies[k].result as Hex}));if(d>=0&&d<=36)this.decimals.set(t,d);}catch{}});
   for(const [pool,q]of this.snapshots)if(!validDepth(q,pool)){this.snapshots.delete(pool);this.stats.fallbacks[pool]='Depth expired during preparation';}
   this.stats.pools=this.snapshots.size;
  }catch(e){this.snapshots.clear();this.stats.fallbacks.batch=(e as Error).message;}
 }
 quote(route:Route,side:'buy'|'sell',input:bigint):ParsedRouteQuote|null{
  if(route.version!=='metric'||!route.token0)return null;const pool=route.poolIds[0].toLowerCase(),q=this.snapshots.get(pool);if(!q)return null;
  const token0=route.token0.toLowerCase(),token1=route.tokens.find(t=>t.toLowerCase()!==token0)?.toLowerCase(),dec0=this.decimals.get(token0),dec1=token1?this.decimals.get(token1):undefined;
  if(dec0===undefined||dec1===undefined)return null;
  const zeroForOne=(side==='buy'?route.tokens[0]:route.tokens.at(-1)!).toLowerCase()===token0;
  const out=fillDepth(q,zeroForOne,input,dec0,dec1);
  // Outside the published depth (or a closed side), retain the original contract path.
  if(!out?.complete||out.amount<=0n)return null;
  this.stats.estimates++;return {...out,gas:null,method:'metric-depth',metricSources:[{pool,source:'metric-depth',observedAt:new Date(q.serverTs*1000).toISOString()}]};
 }
 evidence(){return [...this.snapshots.values()];}
}
