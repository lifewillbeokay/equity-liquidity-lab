import {centralCache} from '@/lib/server/cache-service';
import {compactSimulation,curveKey,type CurveRow} from '@/lib/shared-cache';
import {STOCKS,deploymentsForStock,type MarketSnapshot} from '@/lib/market';
import {CHAINS,routesFor} from '@/lib/registry';
import type {Reference,Simulation} from '@/lib/simulator';
export async function GET(){
 try{const cache=centralCache();const rows=await cache.db.prepare('SELECT * FROM curve_cache WHERE object_key IS NOT NULL ORDER BY captured_at DESC').all<CurveRow>();const markets:MarketSnapshot['markets']={};
 for(const stock of STOCKS){const ds=deploymentsForStock(stock.id),eligible=rows.results.filter(r=>r.stock===stock.id&&ds.some(d=>d.id===r.issuer&&curveKey(d,JSON.parse(r.reference))===r.key));const recent=eligible[0];if(!recent)continue;const reference=JSON.parse(recent.reference) as Reference;
  const matches=ds.map(d=>eligible.find(r=>r.key===curveKey(d,reference)));
  const simulations:Simulation[]=[];
  for(let i=0;i<ds.length;i++){const d=ds[i],row=matches[i];if(row){const s=await cache.read(row,row.expires_at>Date.now()?'hit':'stale');if(!s)continue;simulations.push(compactSimulation(s));}else if(!routesFor(d).length)simulations.push({issuerId:d.id,status:'unavailable',coverageNote:d.coverageNote??'No supported route in the current inventory.',fetchedAt:recent.captured_at!,blockNumber:null,blockHash:null,blockTimestamp:null,normalization:null,routes:[],points:[],probe:{buyPrice:null,sellPrice:null},rpc:CHAINS[d.chain].rpc,reference});}
  if(simulations.some(s=>s.cache))markets[stock.id]={version:1,capturedAt:simulations.filter(s=>s.points.length).map(s=>s.fetchedAt).sort().at(-1)??recent.captured_at!,reference,simulations,coverageVersion:'dense-adaptive-v1'};
 }
 return Response.json({markets},{headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:(e as Error).message},{status:503});}
}
