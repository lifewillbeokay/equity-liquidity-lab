import {getReference} from '@/lib/simulator';
import {STOCKS} from '@/lib/market';
const cache=new Map<string,Awaited<ReturnType<typeof getReference>>>();
export async function GET(request:Request){const stock=new URL(request.url).searchParams.get('stock')??'AAPL';if(!STOCKS.some(s=>s.id===stock))return Response.json({error:'Unknown stock'},{status:400});try{let value=cache.get(stock);if(!value||Date.now()-Date.parse(value.fetchedAt)>60000){value=await getReference(stock);cache.set(stock,value);}return Response.json(value);}catch(e){return Response.json({error:(e as Error).message},{status:502});}}
