import test from 'node:test';
import assert from 'node:assert/strict';
import {validateKyberEvidence} from '../scripts/kyber-quote-evidence.mjs';

const a='0x'+'a'.repeat(40),b='0x'+'b'.repeat(40),c='0x'+'c'.repeat(40);
const edge=(tokenIn:string,tokenOut:string,swapAmount:string,amountOut:string)=>({tokenIn,tokenOut,swapAmount,amountOut});
const summary=()=>({tokenIn:a,tokenOut:b,amountIn:'100',amountOut:'90',route:[[edge(a,b,'40','36')],[edge(a,c,'60','60')],[edge(c,b,'60','54')]]});
test('Kyber split and merged route groups reconcile as a flow graph',()=>{
 assert.equal(validateKyberEvidence(summary(),a,b,'100'),null);
});
test('Kyber evidence rejects full-input and output identity mismatches',()=>{
 const partial=summary();partial.route[0][0].swapAmount='39';
 assert.equal(validateKyberEvidence(partial,a,b,'100'),'Route input/output does not reconcile');
 assert.equal(validateKyberEvidence(summary(),a,c,'100'),'Quote identity/input mismatch');
});
test('Kyber evidence rejects missing intermediate funding',()=>{
 const invalid=summary();invalid.route[2][0].swapAmount='61';
 assert.equal(validateKyberEvidence(invalid,a,b,'100'),'Intermediate route flow does not reconcile');
});
test('Kyber evidence rejects unconsumed input on a selected edge',()=>{
 const invalid=summary();Object.assign(invalid.route[0][0],{extra:{rAI:'1'}});
 assert.equal(validateKyberEvidence(invalid,a,b,'100'),'Route leaves input unconsumed');
});
test('Kyber evidence ignores unselected candidate paths',()=>{
 const valid=summary();Object.assign(valid.route[0][0],{extra:{rAI:'0',_ce:{ces:[{extra:{rAI:'7'}}]}}});
 assert.equal(validateKyberEvidence(valid,a,b,'100'),null);
});
