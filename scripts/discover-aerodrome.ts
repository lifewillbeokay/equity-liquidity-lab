import {createPublicClient,http,parseAbi,zeroAddress} from 'viem';
import {writeFileSync} from 'node:fs';
const c=createPublicClient({transport:http('https://base.publicnode.com')});
const token='0xb200000000000000000000c2e324d24d7eecd1fb',settlement='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const block=await c.getBlock();
const abi=parseAbi(['function tickSpacings() view returns(int24[])','function getPool(address,address,int24) view returns(address)','function factory() view returns(address)','function token0() view returns(address)','function token1() view returns(address)','function tickSpacing() view returns(int24)','function fee() view returns(uint24)']);
const deployments=[
 {factory:'0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a',quoter:'0x254cf9e1e6e233aa1ac962cb9b05b2cfeaae15b0'},
 {factory:'0xade65c38cd4849adba595a4323a8c7ddfe89716a',quoter:'0x3d4c22254f86f64b7ec90ab8f7aec1fbfd271c6c'},
 {factory:'0xf8f2eb4940cfe7d13603dddd87f123820fc061ef',quoter:'0x514c8b5f54112481e28028f1166bd78501089259'},
] as const;
const verified=[],scanned=[];
for(const d of deployments){
 const spacings=await c.readContract({address:d.factory,abi,functionName:'tickSpacings',blockNumber:block.number});
 const qFactory=await c.readContract({address:d.quoter,abi,functionName:'factory',blockNumber:block.number});if(qFactory.toLowerCase()!==d.factory)throw new Error('Quoter mismatch');
 for(const tickSpacing of spacings){const pool=await c.readContract({address:d.factory,abi,functionName:'getPool',args:[token,settlement,tickSpacing],blockNumber:block.number});scanned.push({factory:d.factory,tickSpacing,pool});if(pool===zeroAddress)continue;
 const [poolFactory,t0,t1,spacing,fee]=await Promise.all(['factory','token0','token1','tickSpacing','fee'].map(fn=>c.readContract({address:pool,abi,functionName:fn as never,blockNumber:block.number})));
 if(String(poolFactory).toLowerCase()!==d.factory||Number(spacing)!==tickSpacing||![t0,t1].map(x=>String(x).toLowerCase()).includes(token)||![t0,t1].map(x=>String(x).toLowerCase()).includes(settlement))throw new Error('Pool mismatch');
 verified.push({id:pool.toLowerCase(),...d,chain:'base',venue:'aerodrome',version:'slipstream',token,settlement,tickSpacing,feeAtDiscovery:Number(fee),source:'https://github.com/aerodrome-finance/slipstream/blob/main/README.md'});
 }
}
const classicFactory='0x420dd381b31aef6683db6b902084cb0ffece40da';const classicAbi=parseAbi(['function getPool(address,address,bool) view returns(address)']);
for(const stable of [false,true]){const pool=await c.readContract({address:classicFactory,abi:classicAbi,functionName:'getPool',args:[token,settlement,stable],blockNumber:block.number});scanned.push({factory:classicFactory,stable,pool});if(pool!==zeroAddress){const [factory,t0,t1]=await Promise.all(['factory','token0','token1'].map(fn=>c.readContract({address:pool,abi,functionName:fn as never,blockNumber:block.number})));if(String(factory).toLowerCase()!==classicFactory||![t0,t1].map(x=>String(x).toLowerCase()).includes(token)||![t0,t1].map(x=>String(x).toLowerCase()).includes(settlement))throw new Error('Classic pool mismatch');verified.push({id:pool.toLowerCase(),factory:classicFactory,quoter:'0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',chain:'base',venue:'aerodrome',version:'classic',token,settlement,stable,source:'https://github.com/aerodrome-finance/contracts/blob/main/README.md'});}}
const data={discoveredAt:new Date().toISOString(),blockNumber:Number(block.number),blockHash:block.hash,source:'https://github.com/aerodrome-finance/slipstream/blob/main/README.md',verified,scanned};
writeFileSync('lib/data/aerodrome-pools.json',JSON.stringify(data,null,2));console.log(JSON.stringify(data,null,2));
