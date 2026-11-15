/** Route groups form a directed flow graph, not necessarily independent paths. */
export function validateKyberEvidence(summary,tokenIn,tokenOut,amountIn){
 if(summary?.tokenIn?.toLowerCase()!==tokenIn.toLowerCase()||summary?.tokenOut?.toLowerCase()!==tokenOut.toLowerCase()||summary?.amountIn!==amountIn)return 'Quote identity/input mismatch';
 if(!/^\d+$/.test(summary.amountOut)||BigInt(summary.amountOut)<=0n)return 'No positive output';
 if(!Array.isArray(summary.route)||!summary.route.length)return 'Missing route evidence';
 const net=new Map();
 for(const group of summary.route){
  if(!Array.isArray(group)||!group.length)return 'Missing route edges';
  for(const hop of group){
   if(!/^0x[0-9a-f]{40}$/i.test(hop.tokenIn??'')||!/^0x[0-9a-f]{40}$/i.test(hop.tokenOut??'')||!/^\d+$/.test(hop.swapAmount)||!/^\d+$/.test(hop.amountOut))return 'Invalid route amounts';
   for(const [token,amount] of [[hop.tokenIn,-BigInt(hop.swapAmount)],[hop.tokenOut,BigInt(hop.amountOut)]])net.set(token.toLowerCase(),(net.get(token.toLowerCase())??0n)+amount);
   // Remaining input on an actual chosen edge is a partial quote. Do not inspect
   // alternatives nested in _ce, which were not selected for this route.
   if(hop.extra?.rAI&&BigInt(hop.extra.rAI)!==0n)return 'Route leaves input unconsumed';
  }
 }
 if(net.get(tokenIn.toLowerCase())!==-BigInt(amountIn)||net.get(tokenOut.toLowerCase())!==BigInt(summary.amountOut))return 'Route input/output does not reconcile';
 for(const [token,amount] of net)if(token!==tokenIn.toLowerCase()&&token!==tokenOut.toLowerCase()&&amount!==0n)return 'Intermediate route flow does not reconcile';
 return null;
}
