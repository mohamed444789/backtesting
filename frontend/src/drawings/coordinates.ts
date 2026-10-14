import type { IChartApi, ISeriesApi, Logical, Time } from 'lightweight-charts';
export type CssPoint={x:number;y:number};
export type ResolvedAnchor={time:Time;logical:number;x:number;y:number;price:number};
export class ChartCoordinateAdapter {
 constructor(private chart:IChartApi,private series:ISeriesApi<'Candlestick'>,private container:HTMLElement){}
 normalize(clientX:number,clientY:number):CssPoint|null {
  const r=this.container.getBoundingClientRect(),x=clientX-r.left,y=clientY-r.top;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>r.width||y>r.height)return null;
  const timeAxis=this.chart.timeScale().height?.()??0;
  const rightAxis=(this.chart.priceScale?.('right') as any)?.width?.()??0;
  if(x>r.width-rightAxis||y>r.height-timeAxis)return null;
  return {x,y};
 }
 fromPoint(p:CssPoint):{time:Time;logical:number;price:number}|null {
  const ts=this.chart.timeScale(),logical=ts.coordinateToLogical(p.x),price=this.series.coordinateToPrice(p.y),time=ts.coordinateToTime(p.x);
  if(logical==null||price==null||time==null||!Number.isFinite(logical)||!Number.isFinite(price)||price<=0)return null;
  const nearest=Math.round(logical),nearestTime=ts.coordinateToTime(ts.logicalToCoordinate(nearest as Logical)??NaN);
  return {time:nearestTime??time,logical:nearest,price};
 }
 toPoint(anchor:{time:Time;logical?:number;price:number}):CssPoint|null {
  const ts=this.chart.timeScale();const logical=anchor.logical;const x=logical!=null?ts.logicalToCoordinate(logical as Logical):ts.timeToCoordinate(anchor.time);const y=this.series.priceToCoordinate(anchor.price);
  if(x==null||y==null||!Number.isFinite(x)||!Number.isFinite(y))return null;
  return {x,y};
 }
 resolve(anchor:{time:Time;logical?:number;price:number},data:readonly {time:Time}[]):ResolvedAnchor|null {
  const index=data.findIndex(c=>String(c.time)===String(anchor.time));if(index<0)return null;
  const x=this.chart.timeScale().logicalToCoordinate(index as Logical),y=this.series.priceToCoordinate(anchor.price);
  if(x==null||y==null||!Number.isFinite(x)||!Number.isFinite(y))return null;
  return {time:anchor.time,logical:index,x,y,price:anchor.price};
 }
}
