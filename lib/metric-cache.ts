import {fetchMetricDepth,validDepth,METRIC_CACHE_MS,type MetricBatch,type MetricLoader} from './metric-depth';
type Store=Pick<R2Bucket,'get'|'put'>;
/** Short-lived shared snapshots; never rewrite the provider's serverTs on a cache hit. */
export async function cachedMetricDepth(objects:Store,chainId:number,pools:string[],loader:MetricLoader=fetchMetricDepth,now=Date.now()):Promise<MetricBatch>{
 const unique=[...new Set(pools.map(p=>p.toLowerCase()))];if(![1,56,4663].includes(chainId)||!unique.length||unique.length>100||unique.some(p=>!/^0x[0-9a-f]{40}$/.test(p)))throw new Error('Invalid Metric cache request');
 const key=(p:string)=>`metric-depth/v1/${chainId}/${p}.json`,results:MetricBatch['results']=[],missing:string[]=[];
 await Promise.all(unique.map(async p=>{try{const object=await objects.get(key(p)),cached=object?await object.json<{storedAt:number;result:MetricBatch['results'][number]}>():null;
  if(cached&&cached.storedAt<=now&&cached.storedAt+METRIC_CACHE_MS>now&&validDepth(cached.result.quote,p,now)){results.push(cached.result);return;}
 }catch{}missing.push(p);}));
 if(missing.length){const batch=await loader(chainId,missing);
  await Promise.all(missing.map(async p=>{const result=batch.results.find(r=>r.poolAddress.toLowerCase()===p)??{poolAddress:p,error:{status:502,error:'Pool omitted by provider'}};results.push(result);
   if(validDepth(result.quote,p,now))await objects.put(key(p),JSON.stringify({storedAt:now,result}),{httpMetadata:{contentType:'application/json'}}).catch(()=>{});
  }));
 }
 return {results:unique.map(p=>results.find(r=>r.poolAddress.toLowerCase()===p)!)};
}
