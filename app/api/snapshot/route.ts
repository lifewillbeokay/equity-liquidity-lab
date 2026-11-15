import snapshot from '@/lib/data/market-snapshot.json';
export async function GET(){return Response.json(snapshot,{headers:{'Cache-Control':'no-store'}});}
