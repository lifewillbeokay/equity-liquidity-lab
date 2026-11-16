/** Refresh direct AAPL/MSFT inventory. Exact issuer addresses and canonical contracts only.
 * node --import tsx scripts/discover-metric.mjs /absolute/evidence.json
 */
import {writeFile} from 'node:fs/promises';
import {DEPLOYMENTS,CHAINS,routesFor} from '../lib/registry.ts';
import {rpcBatch,verifyRoutes} from '../lib/simulator.ts';
const evidence={asOf:new Date().toISOString(),chains:[],routes:[]};
for(const chain of ['ethereum','bsc','robinhood']){
 const profiles=DEPLOYMENTS.filter(d=>d.chain===chain&&['AAPL','MSFT'].includes(d.stock??'AAPL'));
 let offset=0,pools=[];do{const r=await fetch(`https://api.metric.xyz/public/v1/evm/${CHAINS[chain].id}/metadata?count=500&offset=${offset}&minTvlFiat=0`,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw new Error('Metadata HTTP '+r.status);const b=await r.json();pools.push(...b.data);offset=b.nextOffset;}while(offset!==null);
 const matches=pools.filter(p=>profiles.some(d=>[p.token0.toLowerCase(),p.token1.toLowerCase()].includes(d.token.toLowerCase())));const record={chain,total:pools.length,matches};evidence.chains.push(record);
 const [head]=await rpcBatch(chain,[{method:'eth_getBlockByNumber',params:['latest',false]}]);
 for(const issuer of profiles){
  const routes=routesFor(issuer).filter(r=>!r.id.startsWith('metric-discovered-'));const leaves=routes.flatMap(r=>r.hops??[r]);
  const template=leaves.find(r=>r.version==='metric');if(!template)continue;
  const candidates=matches.filter(p=>p.priceProviderStatus==='healthy'&&p.pauseLevel===0&&p.poolFactoryAddress.toLowerCase()===template.factory.toLowerCase()&&p.quoterAddress.toLowerCase()===template.quoter.toLowerCase()&&[p.token0,p.token1].map(x=>x.toLowerCase()).sort().join()=== [issuer.token,issuer.settlement].map(x=>x.toLowerCase()).sort().join()&&!leaves.some(r=>r.poolIds.some(x=>x.toLowerCase()===p.poolAddress.toLowerCase()))).map(p=>({...template,issuerId:issuer.id,id:'metric-discovered-'+chain+'-'+p.poolAddress.toLowerCase(),poolIds:[p.poolAddress],tokens:[issuer.settlement,issuer.token],token0:p.token0,label:'Metric · '+p.pair,verification:'Official metadata, exact issuer/settlement addresses, onchain factory registration and immutable token pair verified. Runtime full-input checks apply.'}));
  const checked=await verifyRoutes(issuer,candidates,head.result.number);if(checked.errors.length)record.verificationErrors=checked.errors;evidence.routes.push(...checked.routes);
 }
 console.log(JSON.stringify({chain,total:pools.length,matches:matches.length,added:evidence.routes.filter(r=>r.id.includes(chain)).length}));
}
await writeFile(new URL('../lib/data/metric-discovered-routes.json',import.meta.url),JSON.stringify({asOf:evidence.asOf,routes:evidence.routes},null,2)+'\n');
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(evidence,null,2)+'\n');
