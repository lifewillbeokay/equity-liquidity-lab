import {sharedReference} from '@/lib/server/cache-service';
import {STOCKS} from '@/lib/market';
export async function GET(request:Request){const stock=new URL(request.url).searchParams.get('stock')??'AAPL';if(!STOCKS.some(s=>s.id===stock))return Response.json({error:'Unknown stock'},{status:400});try{return Response.json(await sharedReference(stock),{headers:{'Cache-Control':'no-store'}});}catch(e){return Response.json({error:(e as Error).message},{status:502});}}
