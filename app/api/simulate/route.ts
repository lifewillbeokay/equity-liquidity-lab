import {DEPLOYMENTS} from '@/lib/registry';
import {simulateIssuer,type Simulation} from '@/lib/simulator';
const cache=new Map<string,{at:number;value:Simulation}>();const pending=new Map<string,Promise<Simulation>>();
export async function GET(request:Request){
 const url=new URL(request.url);const issuer=DEPLOYMENTS.find(i=>i.id===url.searchParams.get('issuer'));if(!issuer)return Response.json({error:'Unknown issuer'},{status:400});
 const ref=Number(url.searchParams.get('reference'));const updated=url.searchParams.get('referenceTime');
 if(!Number.isFinite(ref)||ref<=0||ref>1000000||!updated||!Number.isFinite(Date.parse(updated)))return Response.json({error:'Valid reference price and timestamp required'},{status:400});
 const key=issuer.id+':'+ref+':'+updated;const old=cache.get(key);if(old&&Date.now()-old.at<60000)return Response.json(old.value);
 let task=pending.get(key);if(!task){task=simulateIssuer(issuer,{price:ref,updatedAt:updated,fetchedAt:new Date().toISOString(),source:['MU','COIN'].includes(issuer.stock??'')?'https://api.robinhood.com/quotes/'+issuer.stock+'/':'https://api.coinbase.com/v1/tokenized-stocks',label:['MU','COIN'].includes(issuer.stock??'')?'Robinhood consolidated underlying last trade':'Coinbase / Chainlink share reference'});pending.set(key,task);}
 try{const value=await task;const now=Date.now();for(const [id,entry] of cache)if(now-entry.at>=60000)cache.delete(id);while(cache.size>=8)cache.delete(cache.keys().next().value!);cache.set(key,{at:now,value});return Response.json(value,{headers:{'Cache-Control':'no-store'}});}finally{pending.delete(key);}
}
