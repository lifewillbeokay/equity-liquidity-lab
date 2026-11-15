import {ISSUERS} from '@/lib/registry';
import {simulateIssuer,type Simulation} from '@/lib/simulator';
const cache=new Map<string,{at:number;value:Simulation}>();const pending=new Map<string,Promise<Simulation>>();
export async function GET(request:Request){
 const url=new URL(request.url);const issuer=ISSUERS.find(i=>i.id===url.searchParams.get('issuer'));if(!issuer)return Response.json({error:'Unknown issuer'},{status:400});
 const ref=Number(url.searchParams.get('reference'));const updated=url.searchParams.get('referenceTime');
 if(!Number.isFinite(ref)||ref<=0||ref>1000000||!updated||!Number.isFinite(Date.parse(updated)))return Response.json({error:'Valid reference price and timestamp required'},{status:400});
 const key=issuer.id+':'+ref+':'+updated;const old=cache.get(key);if(old&&Date.now()-old.at<25000)return Response.json(old.value);
 let task=pending.get(key);if(!task){task=simulateIssuer(issuer,{price:ref,updatedAt:updated,fetchedAt:new Date().toISOString(),source:'https://api.coinbase.com/v1/tokenized-stocks',label:'Coinbase / Chainlink share reference'});pending.set(key,task);}
 try{const value=await task;if(cache.size>30)cache.clear();cache.set(key,{at:Date.now(),value});return Response.json(value,{headers:{'Cache-Control':'no-store'}});}finally{pending.delete(key);}
}
