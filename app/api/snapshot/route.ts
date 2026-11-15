import asset from '@/lib/data/snapshot-asset.json';
export async function GET(request:Request){
 return new Response(null,{status:307,headers:{Location:new URL(asset.path,request.url).href,'Cache-Control':'no-store'}});
}
