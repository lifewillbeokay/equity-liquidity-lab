import {getReference} from '@/lib/simulator';
let cached:Awaited<ReturnType<typeof getReference>>|null=null;
export async function GET(){try{if(!cached||Date.now()-Date.parse(cached.fetchedAt)>60000)cached=await getReference();return Response.json(cached);}catch(e){return Response.json({error:(e as Error).message},{status:502});}}
