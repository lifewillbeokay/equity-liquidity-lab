/** All values are independent USD-notional exact-input simulations. */
export const BASE_SIZES = [100, 250, 500, 1000, 2500, ...Array.from({length:20}, (_, i)=>(i+1)*5000)];
export const SAMPLING_VERSION = 'dense-adaptive-v1';
export const MAX_ADAPTIVE_PER_SIDE = 12;
export const ADAPTIVE_ROUNDS = 4;
export const ADAPTIVE_PER_ROUND = 3;
export type Side = 'buy'|'sell';
export type Sample = {size:number; side:Side; status:string; impactBps:number|null};
export type SampleRequest = {size:number; side:Side};
export type Sampling = {version:string; baseSizes:number[]; adaptiveSizes:Record<Side,number[]>; rounds:number};
export const newSampling = ():Sampling=>({version:SAMPLING_VERSION,baseSizes:[...BASE_SIZES],adaptiveSizes:{buy:[],sell:[]},rounds:0});

/** Bisect observed discontinuities; never treat an RPC error as a liquidity cliff.
 * Each scope competes for a bounded shared budget. Highest-priority fill boundaries
 * and crossings of displayed impact bands are refined before smooth intervals.
 */
export function refinementRequests(scopes:Sample[][], attempted:SampleRequest[], perSide=ADAPTIVE_PER_ROUND):SampleRequest[]{
 const requests:SampleRequest[]=[];
 for(const side of ['buy','sell'] as const){
  const seen=new Set(attempted.filter(p=>p.side===side).map(p=>p.size));
  const remaining=MAX_ADAPTIVE_PER_SIDE-[...seen].filter(n=>n!==10&&!BASE_SIZES.includes(n)).length;
  const candidates=new Map<number,number>();
  for(const scope of scopes){
   const points=scope.filter(p=>p.side===side&&p.size>=BASE_SIZES[0]).sort((a,b)=>a.size-b.size);
   for(let j=1;j<points.length;j++){
    const a=points[j-1],b=points[j],width=b.size-a.size;
    if(width<50||a.status==='error'||b.status==='error')continue;
    const af=a.status==='ok'&&a.impactBps!==null&&Number.isFinite(a.impactBps),bf=b.status==='ok'&&b.impactBps!==null&&Number.isFinite(b.impactBps);
    if(!af&&!bf)continue;
    const ai=af?Math.max(0,a.impactBps!):Infinity,bi=bf?Math.max(0,b.impactBps!):Infinity;
    // Beyond the largest displayed 10% band, further precision is not useful.
    if(Math.min(ai,bi)>1000)continue;
    let priority=0;
    if(af!==bf)priority=10000;
    else {
     const low=Math.min(ai,bi),high=Math.max(ai,bi),jump=high-low;
     if(jump<2)continue;
     const crossings=[10,20,50,100,200,500,1000].filter(t=>low<t&&high>=t);
     if(crossings.length)priority=2000+(crossings.includes(100)?500:0)+crossings.length*100;
     if(jump>=25)priority=Math.max(priority,1000+Math.min(jump,1000));
     const previous=points[j-2];
     if(previous?.status==='ok'&&previous.impactBps!==null){
      const oldSlope=Math.abs(ai-Math.max(0,previous.impactBps))/(a.size-previous.size);
      if(jump>=10&&jump/width>Math.max(oldSlope*3,.001))priority=Math.max(priority,1800+Math.min(jump,1000));
     }
    }
    if(!priority)continue;
    const size=Math.round((a.size+b.size)/2); // Whole-dollar samples are exact and reproducible.
    if(size<=a.size||size>=b.size||seen.has(size))continue;
    candidates.set(size,Math.max(candidates.get(size)??0,priority+Math.log2(width)));
   }
  }
  for(const [size] of [...candidates].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,Math.max(0,Math.min(perSide,remaining))))requests.push({side,size});
 }
 return requests;
}
