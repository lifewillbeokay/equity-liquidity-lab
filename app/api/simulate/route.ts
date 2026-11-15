import {DEPLOYMENTS} from '@/lib/registry';
import {compactSimulation} from '@/lib/shared-cache';
import {sharedSimulation,finishBrowserCapture} from '@/lib/server/cache-service';
export async function GET(request:Request){
 const url=new URL(request.url),issuer=DEPLOYMENTS.find(i=>i.id===url.searchParams.get('issuer'));if(!issuer)return Response.json({error:'Unknown issuer'},{status:400});
 const price=Number(url.searchParams.get('reference')),updatedAt=url.searchParams.get('referenceTime');
 if(!Number.isFinite(price)||price<=0||price>1_000_000||!updatedAt||!Number.isFinite(Date.parse(updatedAt)))return Response.json({error:'Valid reference price and timestamp required'},{status:400});
 try{const reference={price,updatedAt,fetchedAt:new Date().toISOString(),source:issuer.stock==='MU'?'https://api.robinhood.com/quotes/MU/':'https://api.coinbase.com/v1/tokenized-stocks',label:issuer.stock==='MU'?'Robinhood consolidated underlying last trade':'Coinbase / Chainlink share reference'};
  const result=await sharedSimulation(issuer,reference);const value=url.searchParams.get('compact')==='1'&&'points' in result.value?compactSimulation(result.value):result.value;
  return Response.json(value,{status:result.status,headers:{'Cache-Control':'no-store','X-Curve-Cache':('cache' in result.value?result.value.cache?.state:null)??'miss',...(result.status===202?{'Retry-After':'2'}:{})}});
 }catch(e){return Response.json({error:(e as Error).message},{status:503,headers:{'Cache-Control':'no-store'}});}
}
export async function POST(request:Request){
 if(request.headers.get('origin')&&request.headers.get('origin')!==new URL(request.url).origin)return Response.json({error:'Origin mismatch'},{status:403});
 if(Number(request.headers.get('content-length'))>8*1024*1024)return Response.json({error:'Capture too large'},{status:413});
 try{const text=await request.text();if(text.length>8*1024*1024)return Response.json({error:'Capture too large'},{status:413});const body=JSON.parse(text),issuer=DEPLOYMENTS.find(d=>d.id===body.issuer);if(!issuer||typeof body.key!=='string'||typeof body.owner!=='string')return Response.json({error:'Invalid capture request'},{status:400});
 const result=await finishBrowserCapture(issuer,body.key,body.owner,body.simulation,body.error);return Response.json(result.value,{status:result.status,headers:{'Cache-Control':'no-store'}});
 }catch(e){return Response.json({error:(e as Error).message},{status:400});}
}
