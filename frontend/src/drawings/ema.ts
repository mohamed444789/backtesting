export type Candle = {time:number;close:number};
export type EmaPoint = {time:number;value:number};
export const EMA_PERIOD=200, EMA_MULTIPLIER=2/(EMA_PERIOD+1);
export function calculateEma(candles:readonly Candle[],period=EMA_PERIOD):EmaPoint[] {
 if(!Number.isInteger(period)||period<1)throw new Error('EMA period must be a positive integer');
 if(candles.length<period)return [];
 const out:EmaPoint[]=[];let sum=0,ema=0;const k=2/(period+1);
 for(let i=0;i<candles.length;i++){const c=candles[i];if(!Number.isFinite(c.close)||!Number.isFinite(c.time))continue;
 if(i<period){sum+=c.close;if(i===period-1){ema=sum/period;out.push({time:c.time,value:ema})}}
 else{ema=c.close*k+ema*(1-k);out.push({time:c.time,value:ema})}}
 return out;
}
export class ReplayEma {
 private prefix:Candle[]=[];
 update(revealed:readonly Candle[]){let common=0;while(common<this.prefix.length&&common<revealed.length&&this.prefix[common].time===revealed[common].time&&this.prefix[common].close===revealed[common].close)common++;
 if(common!==this.prefix.length||revealed.length<this.prefix.length){this.prefix=revealed.map(c=>({...c}));return calculateEma(this.prefix)}
 for(let i=this.prefix.length;i<revealed.length;i++)this.prefix.push({...revealed[i]});
 return calculateEma(this.prefix);
 }
 reset(){this.prefix=[]}
}
