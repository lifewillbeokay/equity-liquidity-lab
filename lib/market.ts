import {DEPLOYMENTS,type Issuer} from './registry';
export const STOCKS=[{id:'AAPL',name:'Apple',mark:'A'},{id:'NVDA',name:'NVIDIA',mark:'N'},{id:'GOOGL',name:'Alphabet · Class A',mark:'G'},{id:'MU',name:'Micron',mark:'μ'},{id:'SPCX',name:'SpaceX',mark:'X'},{id:'META',name:'Meta Platforms',mark:'∞'},{id:'MSFT',name:'Microsoft',mark:'M'},{id:'TSLA',name:'Tesla',mark:'T'}];
export type MarketSnapshot={version:number;capturedAt:string;markets:Record<string,import('./simulator').Snapshot>};
export const stockOf=(d:Issuer)=>d.stock??'AAPL';
export const groupOf=(d:Issuer)=>d.groupId??d.id;
export const deploymentsForStock=(stock:string)=>DEPLOYMENTS.filter(d=>stockOf(d)===stock);
