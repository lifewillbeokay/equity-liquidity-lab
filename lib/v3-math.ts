/** Native-bigint adaptation of Uniswap v3-sdk TickMath/SqrtPriceMath/SwapMath
 * (MIT, Copyright (c) 2021 Uniswap Labs). See THIRD_PARTY_NOTICES.md.
 * Exact-input only. No floating-point prices, interpolation, or skipped bitmap words.
 */
export const Q96=1n<<96n, MIN_TICK=-887272, MAX_TICK=887272;
export const MIN_SQRT=4295128739n, MAX_SQRT=1461446703485210103287273052203988822378723970342n;
const MAX256=(1n<<256n)-1n;
const multipliers=[0xfffcb933bd6fad37aa2d162d1a594001n,0xfff97272373d413259a46990580e213an,0xfff2e50f5f656932ef12357cf3c7fdccn,0xffe5caca7e10e4e61c3624eaa0941cd0n,0xffcb9843d60f6159c9db58835c926644n,0xff973b41fa98c081472e6896dfb254c0n,0xff2ea16466c96a3843ec78b326b52861n,0xfe5dee046a99a2a811c461f1969c3053n,0xfcbe86c7900a88aedcffc83b479aa3a4n,0xf987a7253ac413176f2b074cf7815e54n,0xf3392b0822b70005940c7a398e4b70f3n,0xe7159475a2c29b7443b29c7fa6e889d9n,0xd097f3bdfd2022b8845ad8f792aa5825n,0xa9f746462d870fdf8a65dc1f90e061e5n,0x70d869a156d2a1b890bb3df62baf32f7n,0x31be135f97d08fd981231505542fcfa6n,0x9aa508b5b7a84e1c677de54f3e99bc9n,0x5d6af8dedb81196699c329225ee604n,0x2216e584f5fa1ea926041bedfe98n,0x48a170391f7dc42444e8fa2n];
export const ceilDiv=(a:bigint,b:bigint)=>(a+b-1n)/b;
export function sqrtAtTick(tick:number){
 if(!Number.isInteger(tick)||tick<MIN_TICK||tick>MAX_TICK)throw new Error('Invalid tick');
 const abs=Math.abs(tick);let ratio=1n<<128n;
 for(let bit=0;bit<multipliers.length;bit++)if(abs&(1<<bit))ratio=ratio*multipliers[bit]>>128n;
 if(tick>0)ratio=MAX256/ratio;
 return ceilDiv(ratio,1n<<32n);
}
export function amount0(a:bigint,b:bigint,l:bigint,up:boolean){if(a>b)[a,b]=[b,a];const n=(l<<96n)*(b-a);return up?ceilDiv(ceilDiv(n,b),a):n/b/a;}
export function amount1(a:bigint,b:bigint,l:bigint,up:boolean){if(a>b)[a,b]=[b,a];const n=l*(b-a);return up?ceilDiv(n,Q96):n/Q96;}
export function nextSqrtInput(p:bigint,l:bigint,a:bigint,zero:boolean){
 if(l<=0n||p<=0n)throw new Error('Invalid liquidity/price');
 if(!zero)return p+a*Q96/l;
 if(a===0n)return p;
 const n=l<<96n,product=a*p;
 // Replicate the Solidity uint256-overflow fallback, including its rounding.
 if(product<=MAX256&&n+product<=MAX256)return ceilDiv(n*p,n+product);
 return ceilDiv(n,n/p+a);
}
export function swapStep(p:bigint,target:bigint,l:bigint,remaining:bigint,fee:number){
 if(fee<0||fee>=1000000||!Number.isInteger(fee))throw new Error('Invalid fee');
 const zero=p>=target,afterFee=remaining*BigInt(1000000-fee)/1000000n;
 let input=zero?amount0(target,p,l,true):amount1(p,target,l,true);
 const next=afterFee>=input?target:nextSqrtInput(p,l,afterFee,zero);
 if(next!==target)input=zero?amount0(next,p,l,true):amount1(p,next,l,true);
 const output=zero?amount1(next,p,l,false):amount0(p,next,l,false);
 const charged=next!==target?remaining-input:ceilDiv(input*BigInt(fee),BigInt(1000000-fee));
 return {next,input,output,fee:charged};
}
export class MissingWord extends Error{constructor(public word:number){super('Missing bitmap word '+word);}}
export class MissingTick extends Error{constructor(public tick:number){super('Missing initialized tick '+tick);}}
export type V3State={sqrt:bigint;tick:number;liquidity:bigint;spacing:number;fee:number;words:Map<number,bigint>;ticks:Map<number,bigint>};
export function nextTick(state:V3State,tick:number,zero:boolean):{tick:number;initialized:boolean}{
 const compressed=Math.floor(tick/state.spacing)+(zero?0:1),word=Math.floor(compressed/256),bit=compressed-word*256;
 const bitmap=state.words.get(word);if(bitmap===undefined)throw new MissingWord(word);
 const masked=zero?bitmap&((1n<<BigInt(bit+1))-1n):bitmap&(~((1n<<BigInt(bit))-1n)&MAX256);
 if(!masked)return {tick:(zero?word*256:word*256+255)*state.spacing,initialized:false};
 const found=zero?masked.toString(2).length-1:(masked&-masked).toString(2).length-1;
 return {tick:(word*256+found)*state.spacing,initialized:true};
}
export function swapV3(state:V3State,amount:bigint,zero:boolean){
 if(amount<=0n||amount>=(1n<<255n))throw new Error('Invalid exact input');
 let remaining=amount,output=0n,p=state.sqrt,tick=state.tick,l=state.liquidity,steps=0;
 const limit=zero?MIN_SQRT+1n:MAX_SQRT-1n;
 if(zero?p<=limit:p>=limit)throw new Error('Price already at limit');
 while(remaining>0n&&p!==limit){
  if(++steps>4096)throw new Error('Local swap step budget exceeded');
  const found=nextTick(state,tick,zero),next=Math.max(MIN_TICK,Math.min(MAX_TICK,found.tick)),boundary=sqrtAtTick(next);
  const target=zero?(boundary<limit?limit:boundary):(boundary>limit?limit:boundary);
  const step=swapStep(p,target,l,remaining,state.fee);
  remaining-=step.input+step.fee;output+=step.output;p=step.next;
  if(remaining<0n)throw new Error('Input overconsumed');
  if(p===boundary){
   if(found.initialized){const net=state.ticks.get(next);if(net===undefined)throw new MissingTick(next);l+=zero?-net:net;if(l<0n||l>=(1n<<128n))throw new Error('Invalid crossed liquidity');}
   tick=zero?next-1:next;
  }else if(remaining!==0n&&p!==limit)throw new Error('Unexpected incomplete step');
 }
 return {amount:output,consumedInput:amount-remaining,complete:remaining===0n&&p>MIN_SQRT+1n&&p<MAX_SQRT-1n,sqrt:p,steps};
}
