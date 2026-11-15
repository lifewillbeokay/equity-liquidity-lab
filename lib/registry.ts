import chainData from './data/chains.json';
import poolData from './data/discovered-pools.json';
import aeroData from './data/aerodrome-pools.json';
import allChainData from './data/all-chain-registry.json';
import allChainRoutes from './data/all-chain-routes.json';
import multiAssetData from './data/multi-asset-registry.json';
import mainDexData from './data/main-dex-routes.json';
export const DEXES=['uniswap','aerodrome','pancakeswap','metric','up','ramses','fluxion','communityv3','nest','sushiswap','jupiter','stonfi','multi'] as const;
export type Dex=typeof DEXES[number];
export type DexScope='all'|Dex;
export const DEX_LABELS:Record<DexScope,string>={all:'Best across DEXs',uniswap:'Uniswap',aerodrome:'Aero / Aerodrome',pancakeswap:'PancakeSwap',metric:'Metric',up:'UP',ramses:'Ramses',fluxion:'Fluxion',communityv3:'CommunityV3',nest:'Nest',sushiswap:'SushiSwap',jupiter:'Jupiter routing',stonfi:'STON.fi',multi:'Cross-DEX'};
import type {Address} from 'viem';
export const SIZES=[100,1000,5000,10000,50000,100000];
export type ChainKey=keyof typeof chainData;
export const CHAINS=chainData;
export type Issuer={id:string;stock?:string;underlying?:Address;oracleToken?:Address;groupId?:string;variant?:string;coverageNote?:string;name:string;symbol:string;chain:ChainKey;token:Address;decimals:number;color:string;settlement:Address;settlementSymbol:string;settlementDecimals:number;normalization:'b20'|'ondo'|'wrapper'|'bep677'|'robinhood'|'native-shares'|'solana-scaled'|'ton-scaled';source:string;note:string};
export const ISSUERS:Issuer[]=[
{id:'coinbase',name:'Coinbase',symbol:'AAPLc',chain:'base',token:'0xb200000000000000000000c2e324d24d7eecd1fb',decimals:8,color:'#6ba4ff',settlement:'0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',settlementSymbol:'USDC',settlementDecimals:6,normalization:'b20',source:'https://www.base.org/stocks',note:'Coinbase-issued Apple certificate on Base.'},
{id:'ondo',name:'Ondo',symbol:'AAPLon',chain:'ethereum',token:'0x14c3abf95cb9c93a8b82c1cdcb76d72cb87b2d4c',decimals:18,color:'#c2a6ff',settlement:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',settlementSymbol:'USDC',settlementDecimals:6,normalization:'ondo',source:'https://github.com/ondoprotocol/ondo-global-markets-token-list',note:'Ondo Apple total-return tracker on Ethereum.'},
{id:'xstocks',name:'xStocks',symbol:'wAAPLx',chain:'ink',token:'0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f',decimals:18,color:'#efae76',settlement:'0xe343167631d89b6ffc58b88d6b7fb0228795491d',settlementSymbol:'USDG',settlementDecimals:6,normalization:'wrapper',source:'https://docs.xstocks.fi/developers/wrapped-xstocks',note:'Official v2 ERC-4626 wrapper. Normalized through convertToAssets; no second multiplier.'},
{id:'binance',name:'bStocks',symbol:'AAPLB',chain:'bsc',token:'0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a',decimals:18,color:'#e7cf6e',settlement:'0x55d398326f99059ff775485246999027b3197955',settlementSymbol:'USDT',settlementDecimals:18,normalization:'bep677',source:'https://www.binance.com/en-NG/square/post/349974574810737',note:'Binance bStocks Apple token. Share units reflect the onchain UI multiplier.'},
{id:'robinhood',name:'Robinhood',symbol:'AAPL',chain:'robinhood',token:'0xaf3d76f1834a1d425780943c99ea8a608f8a93f9',decimals:18,color:'#a4d674',settlement:'0x5fc5360d0400a0fd4f2af552add042d716f1d168',settlementSymbol:'USDG',settlementDecimals:6,normalization:'robinhood',source:'https://api.robinhood.com/rhj/assets',note:'Robinhood Apple token on Robinhood Chain.'},
];
export const DEPLOYMENTS:Issuer[]=[...ISSUERS,...allChainData.deployments as unknown as Issuer[],...multiAssetData.deployments as unknown as Issuer[]];
export const deploymentsForIssuer=(id:string)=>DEPLOYMENTS.filter(d=>(d.groupId??d.id)===id);
export const REGISTRY_AS_OF=allChainData.asOf;
export type PoolKey={currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address};
export type Route={id:string;venue:Dex;version:'v2'|'v3'|'v4'|'slipstream'|'classic'|'aero'|'metric'|'composite'|'provider'|'algebra';hops?:Route[];factory?:Address;quoter?:Address;router?:Address;deployer?:Address;token0?:Address;tickSpacing?:number;tickSpacings?:number[];stable?:boolean;poolIds:string[];tokens:Address[];fees:number[];key?:PoolKey;label:string};
export function routesFor(i:Issuer,scope:DexScope='all'):Route[]{
 if(i.chain==='solana'||i.chain==='ton'){const venue=i.chain==='solana'?'jupiter':'stonfi';return scope==='all'||scope===venue?[{id:venue+'-'+i.id,venue,version:'provider',tokens:[i.settlement,i.token],poolIds:[],fees:[],label:DEX_LABELS[venue]}]:[];}
 const uniswap:Route[]=poolData.filter(p=>p.verified&&p.chain===i.chain&&p.base.address.toLowerCase()===i.token.toLowerCase()&&p.quote.address.toLowerCase()===i.settlement.toLowerCase()&&['v3','v4'].includes(p.version)).map(p=>({id:p.id,venue:'uniswap',version:p.version as 'v3'|'v4',poolIds:[p.id],tokens:[i.settlement,i.token],fees:[p.fee??(p as unknown as {key:PoolKey}).key?.fee??0],key:(p as unknown as {key?:PoolKey}).key,label:`Uniswap ${p.version} · ${(p.fee??(p as unknown as {key:PoolKey}).key?.fee)===8388608?'dynamic fee':((p.fee??(p as unknown as {key:PoolKey}).key?.fee??0)/10000).toFixed(2)+'%'}`}));
 const aerodrome:Route[]=aeroData.verified.filter(p=>p.chain===i.chain&&p.token===i.token&&p.settlement===i.settlement).map(p=>({id:p.id,venue:'aerodrome',version:p.version as 'slipstream'|'classic',factory:p.factory as Address,quoter:p.quoter as Address,tickSpacing:p.tickSpacing,stable:p.stable,poolIds:[p.id],tokens:[i.settlement,i.token],fees:[],label:p.version==='slipstream'?`Aerodrome Slipstream · ts ${p.tickSpacing}`:`Aerodrome ${p.stable?'stable':'volatile'}`}));
 const additional=[...mainDexData.routes,...allChainRoutes.routes,...multiAssetData.routes].filter(p=>p.issuerId===i.id) as unknown as Route[];
 return [...uniswap,...aerodrome,...additional].filter(r=>scope==='all'||r.venue===scope);
}
export const CHAIN_LABELS:Record<ChainKey,string>={ethereum:'Ethereum',base:'Base',bsc:'BNB Chain',ink:'Ink',robinhood:'Robinhood Chain',arbitrum:'Arbitrum',optimism:'Optimism',mantle:'Mantle',xlayer:'X Layer',hyperevm:'HyperEVM',monad:'Monad',solana:'Solana',ton:'TON',tron:'Tron'};
export const EXPLORERS:Record<ChainKey,string>={ethereum:'https://etherscan.io',base:'https://basescan.org',bsc:'https://bscscan.com',ink:'https://explorer.inkonchain.com',robinhood:'https://robinhoodchain.blockscout.com',arbitrum:'https://arbiscan.io',optimism:'https://optimistic.etherscan.io',mantle:'https://mantlescan.xyz',xlayer:'https://www.oklink.com/xlayer',hyperevm:'https://hyperevmscan.io',monad:'https://monadvision.com',solana:'https://solscan.io',ton:'https://tonviewer.com',tron:'https://tronscan.org'};
export function addressUrl(chain:ChainKey,address:string){return EXPLORERS[chain]+(chain==='solana'?'/account/':chain==='ton'?'/':chain==='tron'?'/#/token20/':'/address/')+address;}
export function poolUrl(chain:ChainKey,id:string){return id.length!==66||['solana','ton','tron'].includes(chain)?addressUrl(chain,id):`https://app.uniswap.org/explore/pools/${chain==='bsc'?'bnb':chain}/${id}`;}
export function routeUrl(chain:ChainKey,routeId:string){const route=DEPLOYMENTS.filter(i=>i.chain===chain).flatMap(i=>routesFor(i)).find(r=>r.id===routeId);return poolUrl(chain,route?.poolIds.at(-1)??routeId);}
