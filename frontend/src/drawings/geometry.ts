import type { Drawing, PositionDrawing } from './model';
export const FIB_RATIOS = [0, .382, .5, .618, 1] as const;
export function fibonacciLevels(a: number, b: number) {
  if (![a,b].every(Number.isFinite)) return [];
  const low = Math.min(a,b), high = Math.max(a,b);
  return FIB_RATIOS.map(ratio => ({ ratio, price: a <= b ? high - ratio*(high-low) : low + ratio*(high-low) }));
}
export type PositionMetrics = { risk: number; reward: number; ratio: number | null; riskPercent: number | null; rewardPercent: number | null };
export function positionMetrics(d: Pick<PositionDrawing,'type'|'entry'|'stopLoss'|'takeProfit'>): PositionMetrics {
 const isLong=d.type==='long-position', risk=isLong?d.entry-d.stopLoss:d.stopLoss-d.entry, reward=isLong?d.takeProfit-d.entry:d.entry-d.takeProfit;
 const valid=Number.isFinite(d.entry)&&d.entry>0&&Number.isFinite(risk)&&risk>0&&Number.isFinite(reward)&&reward>=0;
 return {risk:valid?risk:0,reward:valid?reward:0,ratio:valid?reward/risk:null,riskPercent:valid?risk/d.entry*100:null,rewardPercent:valid?reward/d.entry*100:null};
}
export function movePosition(d: PositionDrawing, deltaPrice: number): PositionDrawing {
 const entry=d.entry+deltaPrice, stopLoss=d.stopLoss+deltaPrice, takeProfit=d.takeProfit+deltaPrice;
 if (![entry,stopLoss,takeProfit].every(Number.isFinite)||entry<=0||stopLoss<=0||takeProfit<=0) return d;
 if (d.type==='long-position' && !(stopLoss<entry&&takeProfit>entry)) return d;
 if (d.type==='short-position' && !(stopLoss>entry&&takeProfit<entry)) return d;
 return {...d,entry,stopLoss,takeProfit,updatedAt:Date.now()};
}
export function formatMetric(n:number|null, suffix=''):string { return n===null||!Number.isFinite(n)?'—':`${n.toFixed(2)}${suffix}`; }
export type Point = {x:number;y:number};
export function distanceToSegment(p:Point,a:Point,b:Point):number { const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;if(!l)return Math.hypot(p.x-a.x,p.y-a.y);const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/l));return Math.hypot(p.x-(a.x+t*dx),p.y-(a.y+t*dy)); }
export function visibleRect(x1:number,y1:number,x2:number,y2:number,width:number,height:number) { const left=Math.max(0,Math.min(x1,x2)),right=Math.min(width,Math.max(x1,x2)),top=Math.max(0,Math.min(y1,y2)),bottom=Math.min(height,Math.max(y1,y2));return right>=left&&bottom>=top?{x:left,y:top,width:right-left,height:bottom-top}:null; }
