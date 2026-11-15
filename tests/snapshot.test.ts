import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUnits} from 'viem';
import data from '../lib/data/market-snapshot.json';
import {STOCKS,deploymentsForStock} from '../lib/market';
import {ISSUERS} from '../lib/registry';
import {bestAcrossDeployments} from '../lib/view';
import type {Snapshot} from '../lib/simulator';
test('All eight stocks have current-profile captures; full quotes reconcile normalized share and cash units',()=>{
 for(const stock of STOCKS){const s=(data.markets as Record<string,Snapshot>)[stock.id];assert.ok(s,stock.id);const ds=deploymentsForStock(stock.id);assert.equal(s.simulations.length,ds.length,stock.id);assert.ok(s.reference.price>0);assert.ok(Number.isFinite(Date.parse(s.reference.updatedAt)));let usable=0;
 for(const sim of s.simulations){const d=ds.find(d=>d.id===sim.issuerId);assert.ok(d);if(sim.status==='error'){assert.ok(sim.points.every(p=>p.status!=='ok'));continue;}for(const p of sim.points){if(p.status!=='ok')continue;usable++;assert.ok(Number.isFinite(p.price)&&p.price!>0,sim.issuerId);assert.equal(p.inputRaw,p.consumedInputRaw);assert.ok(p.outputRaw&&BigInt(p.outputRaw)>0n);assert.ok(p.shares!>0);const price=(p.side==='buy'?p.input:p.output!)/p.shares!;assert.ok(Math.abs(price-p.price!)<=Math.max(1e-8,Math.abs(price)*1e-12));if(p.side==='buy')assert.equal(p.inputRaw,parseUnits(String(p.size),d.settlementDecimals).toString());else assert.ok(Math.abs(p.shares!-p.size/s.reference.price)<1e-6);if(sim.quoteKind==='provider')assert.ok(p.observedAt);else assert.match(sim.blockHash!,/^0x[0-9a-f]{64}$/i);}}
 assert.ok(usable>0,stock.id);for(const issuer of ISSUERS){const view=bestAcrossDeployments(s.simulations,stock.id,issuer.id);for(const p of view.points){const candidates=view.deployments.flatMap(d=>d.status==='ok'?d.points.filter(q=>q.side===p.side&&q.size===p.size&&q.status==='ok'):[]);assert.equal(p.price,p.side==='buy'?Math.min(...candidates.map(c=>c.price!)):Math.max(...candidates.map(c=>c.price!)));}}
 }
});
