import {ISSUERS} from '../lib/registry';
import {simulateIssuer,getReference} from '../lib/simulator';
import {writeFileSync} from 'node:fs';
let reference;
try{reference=await getReference();console.log('REF',reference)}catch(e){console.log('REF ERROR',String(e));process.exit(1)}
const simulations=await Promise.all(ISSUERS.map(async i=>{const s=await simulateIssuer(i,reference);console.log(i.id,s.status,s.error,s.normalization,s.points.map(p=>[p.side,p.size,p.status,p.price,p.routeLabel,p.reason]));return s;}));
writeFileSync('../discovery/first-simulation.json',JSON.stringify({version:1,reference,simulations,capturedAt:new Date().toISOString(),coverageVersion:'2026-11-14'},null,2));
