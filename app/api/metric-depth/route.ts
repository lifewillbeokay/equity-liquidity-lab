import {env} from 'cloudflare:workers';
import {DEPLOYMENTS,CHAINS,routesFor} from '@/lib/registry';
import {cachedMetricDepth} from '@/lib/metric-cache';
export async function POST(request:Request){
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Origin mismatch'},{status:403});
 try{
  if(Number(request.headers.get('content-length'))>8192)return Response.json({error:'Request too large'},{status:413});
  const text=await request.text();if(text.length>8192)return Response.json({error:'Request too large'},{status:413});const {chainId,pools}=JSON.parse(text);
  const allowed=new Set(DEPLOYMENTS.filter(d=>CHAINS[d.chain].id===chainId).flatMap(d=>routesFor(d).flatMap(r=>r.hops??[r])).filter(r=>r.version==='metric').map(r=>r.poolIds[0].toLowerCase()));
  if(!Array.isArray(pools)||!pools.length||pools.length>100||pools.some(p=>typeof p!=='string'||!allowed.has(p.toLowerCase())))return Response.json({error:'Unknown Metric pool'},{status:400});
  if(!env.BUCKET)throw new Error('Shared storage unavailable');const result=await cachedMetricDepth(env.BUCKET,chainId,pools);return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:(e as Error).message},{status:503,headers:{'Cache-Control':'no-store'}});}
}
