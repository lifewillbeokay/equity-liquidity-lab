import {readFileSync,writeFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {encodeFunctionData,decodeFunctionResult,parseAbi,keccak256,encodeAbiParameters,parseAbiParameters} from 'viem';
const run=promisify(execFile), dir='../discovery/';
const dep=JSON.parse(readFileSync(dir+'deployments.json')).records;
export const chains={ethereum:{id:1,rpc:'https://ethereum.publicnode.com'},base:{id:8453,rpc:'https://base.publicnode.com'},bsc:{id:56,rpc:'https://bsc.publicnode.com'},ink:{id:57073,rpc:'https://rpc-gel.inkonchain.com'},robinhood:{id:4663,rpc:'https://rpc.mainnet.chain.robinhood.com'}};
export async function rpc(chain,method,params){const {stdout}=await run('curl',['-fsS','--max-time','25',chains[chain].rpc,'-H','Content-Type: application/json','--data',JSON.stringify({jsonrpc:'2.0',id:1,method,params})],{maxBuffer:8e6});let d=JSON.parse(stdout);if(d.error)throw new Error(d.error.message);return d.result;}
const abi=parseAbi(['function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function fee() view returns(uint24)','function decimals() view returns(uint8)','function getReserves() view returns(uint112,uint112,uint32)','function liquidity() view returns(uint128)','function getSlot0(bytes32) view returns(uint160,int24,uint24,uint24)','function getPool(address,address,uint24) view returns(address)']);
export async function call(chain,to,fn,args=[],block='latest'){const data=encodeFunctionData({abi,functionName:fn,args});const v=await rpc(chain,'eth_call',[{to,data},block]);return decodeFunctionResult({abi,functionName:fn,data:v});}
export const contract=(chain,name)=>dep.find(r=>r.chainId===chains[chain].id&&r.contract===name&&r.env==='mainnet')?.address;
const result=[];
for(const file of ['ondoon','ondobnb','coinbase','xstocks','xwrapped2','binance','robinhood']){
 const pairs=JSON.parse(readFileSync(dir+file+'.json')).pairs||[];
 for(const p of pairs.filter(p=>p.dexId==='uniswap'&&chains[p.chainId]&&['USDC','USDT','USDG','WETH','ETH','wUSDC'].includes(p.quoteToken.symbol))){
  const c=p.chainId;let r={issuerKey:file,chain:c,id:p.pairAddress,base:p.baseToken,quote:p.quoteToken,discoveryLiquidity:p.liquidity?.usd||0,createdAt:p.pairCreatedAt};
  try{
   if(p.pairAddress.length===42){
    const vals=await Promise.all(['factory','token0','token1','fee'].map(fn=>call(c,p.pairAddress,fn).catch(()=>null)));
    r={...r,version:vals[3]===null?'v2':'v3',factory:vals[0],token0:vals[1],token1:vals[2],fee:vals[3]===null?null:Number(vals[3])};
    r.verified=r.factory?.toLowerCase()===contract(c,r.version==='v3'?'UniswapV3Factory':'UniswapV2Factory')?.toLowerCase();
    if(r.verified&&r.version==='v3')r.liquidity=(await call(c,r.id,'liquidity')).toString();
   }else{
    r.version='v4';const [token0,token1]=[p.baseToken.address.toLowerCase(),p.quoteToken.address.toLowerCase()].sort();
    for(const fee of [100,500,3000,10000,200,400,1000,2000,2500,4000,5000,8388608]){
     for(const tickSpacing of [1,2,4,8,10,20,30,40,50,60,100,200]){
      const key={currency0:token0,currency1:token1,fee,tickSpacing,hooks:'0x0000000000000000000000000000000000000000'};
      const id=keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),Object.values(key)));
      if(id===r.id){r.key=key;break;}
     }if(r.key)break;
    }
    if(r.key){r.state=(await call(c,contract(c,'StateView'),'getSlot0',[r.id])).map(String);r.verified=BigInt(r.state[0])>0n;}else r.verified=false;
   }
  }catch(e){r.error=e.message.slice(0,180);}
  result.push(r);console.log(JSON.stringify(r));
 }
}
writeFileSync(dir+'verified-pools.json',JSON.stringify(result,null,2));
writeFileSync(dir+'chain-deployments.json',JSON.stringify(Object.fromEntries(Object.entries(chains).map(([k,c])=>[k,{...c,...Object.fromEntries(['UniswapV3Factory','UniswapV2Factory','QuoterV2','V4Quoter','PoolManager','StateView'].map(n=>[n,contract(k,n)]))}])),null,2));
