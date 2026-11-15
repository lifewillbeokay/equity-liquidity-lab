import {centralCache} from '@/lib/server/cache-service';
import {DEPLOYMENTS} from '@/lib/registry';
export async function GET(request:Request){const key=new URL(request.url).searchParams.get('key')??'';if(!/^[a-f0-9]{64}$/.test(key))return Response.json({error:'Invalid capture key'},{status:400});
 try{const cache=centralCache(),row=await cache.row(key);if(!row?.object_key||!DEPLOYMENTS.some(d=>d.id===row.issuer))return Response.json({error:'Capture unavailable'},{status:404});const object=await cache.objects.get(row.object_key);if(!object)return Response.json({error:'Capture unavailable'},{status:404});return new Response(object.body,{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});}catch{return Response.json({error:'Shared storage unavailable'},{status:503});}}
