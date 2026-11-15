import {CHAINS,type ChainKey} from './registry';
import {digest} from './shared-cache';
import {fetchTransport,rpcTransport,type Transport,type RpcReply} from './simulator';
type Request={id:number|string;jsonrpc:string;method:string;params:any[]};
type Reply=RpcReply&{id:number|string;jsonrpc?:string};
type Read={key:string;chain:ChainKey;blockHash:string;value:RpcReply};
/** Request-local staging: no writes are shared until uncached canonicality checks pass. */
export class PoolReadCache{
 readonly pins=new Map<string,{chain:ChainKey;number:string;hash:string}>();
 readonly staged=new Map<string,Read>();readonly local=new Map<string,RpcReply>();hits=0;misses=0;
 constructor(readonly db:D1Database,readonly upstream:Transport=fetchTransport,readonly now:()=>number=Date.now){}
 chain(url:string){return url==='https://rpc.mainnet.chain.robinhood.com'?'robinhood':(Object.keys(CHAINS) as ChainKey[]).find(k=>CHAINS[k].rpc===url);}
 readonly transport:Transport=async(url,body)=>{
  const requests=body as Request[],chain=this.chain(url);if(!chain||!Array.isArray(requests))return this.upstream(url,body);
  const keyed=requests.map(r=>{const block=r.method==='eth_call'&&typeof r.params[1]==='string'?r.params[1].toLowerCase():null;const pin=block?this.pins.get(chain+':'+block):null;return pin?{request:r,key:digest({chain,blockHash:pin.hash,method:r.method,params:[r.params[0],pin.hash,...r.params.slice(2)]}),pin}:null;});
  const keys=[...new Set(keyed.flatMap(k=>k&&!this.local.has(k.key)?[k.key]:[]))];
  if(keys.length){const rows=await this.db.prepare(`SELECT key,value FROM pool_reads WHERE key IN (${keys.map(()=>'?').join(',')}) AND expires_at>?`).bind(...keys,this.now()).all<{key:string;value:string}>();for(const row of rows.results)this.local.set(row.key,JSON.parse(row.value));}
  const output=new Map<number|string,Reply>(),missing:Request[]=[];
  requests.forEach((r,i)=>{const k=keyed[i],cached=k&&this.local.get(k.key);if(cached){this.hits++;output.set(r.id,{...cached,id:r.id,jsonrpc:'2.0'});}else{if(k)this.misses++;missing.push(r);}});
  if(missing.length){const replies=await this.upstream(url,missing) as Reply[];if(!Array.isArray(replies))return replies;const byId=new Map(replies.map(r=>[r.id,r]));for(const request of missing){const reply=byId.get(request.id)??{id:request.id,error:{code:-1,message:'Missing RPC response'}};output.set(request.id,reply);
    if(request.method==='eth_getBlockByNumber'&&reply.result&&typeof reply.result==='object'){const block=reply.result as {number?:string;hash?:string};if(block.number&&block.hash){const key=chain+':'+block.number.toLowerCase(),old=this.pins.get(key);if(old&&old.hash!==block.hash)throw new Error('Snapshot block changed during collection');this.pins.set(key,{chain,number:block.number,hash:block.hash});}}
    const k=keyed[requests.indexOf(request)];if(k&&!reply.error&&typeof reply.result==='string'){const value={result:reply.result};this.local.set(k.key,value);this.staged.set(k.key,{key:k.key,chain,blockHash:k.pin.hash,value});}
  }}
  return requests.map(r=>output.get(r.id));
 };
 async commit(){
  // Verify every dependency again (including Ondo's normalization chain), without caching.
  for(const pin of this.pins.values()){
   const replies=await rpcTransport(pin.chain,[{jsonrpc:'2.0',id:1,method:'eth_getBlockByNumber',params:[pin.number,false]}],this.upstream) as Reply[];
   if(!Array.isArray(replies)||(replies[0]?.result as {hash?:string})?.hash!==pin.hash)throw new Error('Pool-read snapshot changed; nothing cached');
  }
  const reads=[...this.staged.values()];for(let i=0;i<reads.length;i+=15){const chunk=reads.slice(i,i+15);await this.db.prepare(`INSERT INTO pool_reads(key,chain,block_hash,value,expires_at) VALUES ${chunk.map(()=>'(?,?,?,?,?)').join(',')} ON CONFLICT(key) DO NOTHING`).bind(...chunk.flatMap(r=>[r.key,r.chain,r.blockHash,JSON.stringify(r.value),this.now()+900_000])).run();}
 }
}
