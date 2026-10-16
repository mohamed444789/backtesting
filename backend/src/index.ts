import express from'express';import helmet from'helmet';import cors from'cors';import multer from'multer';import path from'node:path';import fs from'node:fs';import{db}from'./db.js';import{aggregate,valid,exitHit,pnl}from'./core.js';const app=express(),root=process.env.DATA_DIR||'./data';app.disable('x-powered-by');app.use(helmet({crossOriginResourcePolicy:{policy:'same-origin'}}));app.use(cors({origin:false}));app.use(express.json({limit:'2mb'}));const port=Number(process.env.PORT||8080);
app.get('/api/health',(_q,r)=>{try{db.prepare('select 1').get();r.json({ok:true,db:'ready'})}catch{r.status(503).json({ok:false})}});app.get('/api/instruments',(_q,r)=>r.json(db.prepare('select * from instruments order by symbol').all()));app.get('/api/coverage',(q,r)=>r.json(db.prepare('select min(time) start,max(time) end,count(*) candles from candles where symbol=?').get(String(q.query.symbol||'EURUSD').toUpperCase())));
app.get('/api/candles',(q,r)=>{const symbol=String(q.query.symbol||'EURUSD').toUpperCase(),from=Number(q.query.from||0),cursor=Number(q.query.cursor||q.query.to||Date.now()/1000),limit=Math.max(1,Math.min(10000,Number(q.query.limit||3000))),tf=Math.max(1,Number(q.query.timeframe||1));const rows=db.prepare('select time,open,high,low,close,volume from candles where symbol=? and time>=? and time<=? order by time desc limit ?').all(symbol,from,cursor,limit).reverse() as any[];r.json(tf===1?rows:aggregate(rows,tf))});
app.post('/api/sessions',(q,r)=>{const b=q.body||{};if(!Number.isFinite(Number(b.startTime))||!(Number(b.initialBalance||10000)>0))return r.status(400).json({error:'Valid start time and positive balance required'});const symbol=String(b.symbol||'EURUSD').toUpperCase(),start=Number(b.startTime),endTime=Number.isFinite(Number(b.endTime))&&Number(b.endTime)>0?Number(b.endTime):null;if(endTime!==null&&endTime<start)return r.status(400).json({error:'End date must be on or after start date'});const first:any=db.prepare('select time from candles where symbol=? and time>=? and (? is null or time<=?) order by time limit 1').get(symbol,start,endTime,endTime);if(!first)return r.status(422).json({error:'No candles for this instrument/date. Download historical data first and check date coverage.'});const id=db.prepare('insert into sessions(name,symbol,start_time,cursor,initial_balance,balance,timeframe,account_currency,end_time) values(?,?,?,?,?,?,?,?,?)').run(String(b.name||symbol+' replay').slice(0,120),symbol,start,Number(first.time),Number(b.initialBalance||10000),Number(b.initialBalance||10000),Number(b.timeframe||1),b.accountCurrency||'USD',endTime).lastInsertRowid;r.status(201).json(db.prepare('select * from sessions where id=?').get(id))});app.get('/api/sessions',(_q,r)=>r.json(db.prepare('select * from sessions order by id desc').all()));
app.patch('/api/sessions/:id',(q,r)=>{const id=Number(q.params.id),name=String(q.body?.name??'').trim();if(!name)return r.status(400).json({error:'Session name is required'});if(name.length>120)return r.status(400).json({error:'Session name must be 120 characters or fewer'});const result=db.prepare('update sessions set name=? where id=?').run(name,id);if(!result.changes)return r.status(404).json({error:'Session not found'});r.json(db.prepare('select * from sessions where id=?').get(id))});
app.delete('/api/sessions/:id',(q,r)=>{const id=Number(q.params.id);if(!db.prepare('select id from sessions where id=?').get(id))return r.status(404).json({error:'Session not found'});db.transaction(()=>{db.prepare('delete from journal_notes where trade_id in (select id from trades where session_id=?)').run(id);db.prepare('delete from trades where session_id=?').run(id);db.prepare('delete from orders where session_id=?').run(id);db.prepare('delete from drawings where session_id=?').run(id);db.prepare('delete from sessions where id=?').run(id)})();r.json({ok:true,id})});app.get('/api/sessions/:id/visible',(q,r)=>{const s:any=db.prepare('select * from sessions where id=?').get(Number(q.params.id));if(!s)return r.status(404).json({error:'Session not found'});r.json({session:s,candles:db.prepare('select time,open,high,low,close,volume from candles where symbol=? and time>=? and time<=? order by time desc limit 1200').all(s.symbol,s.start_time,s.cursor).reverse()})});
app.post('/api/sessions/:id/step',(q,r)=>{const id=Number(q.params.id),s:any=db.prepare('select * from sessions where id=?').get(id);if(!s)return r.status(404).json({error:'Session not found'});const n=Math.min(1000,Math.max(1,Number(q.body?.count||1))),cs=db.prepare('select time,open,high,low,close,volume from candles where symbol=? and time>? and (? is null or time<=?) order by time limit ?').all(s.symbol,s.cursor,s.end_time??null,s.end_time??null,n) as any[];if(!cs.length)return r.json({session:s,candles:[],done:true});db.transaction(()=>{db.prepare('update sessions set cursor=? where id=?').run(cs.at(-1).time,id);for(const c of cs){const orders=db.prepare("select * from orders where session_id=? and status='pending'").all(id) as any[];for(const o of orders){const hit=o.type==='buy_limit'?c.low<=o.price:o.type==='sell_limit'?c.high>=o.price:o.type==='buy_stop'?c.high>=o.price:c.low<=o.price;if(hit){db.prepare("update orders set status='filled' where id=?").run(o.id);db.prepare('insert into trades(session_id,symbol,side,entry_time,entry,sl,tp,lots,initial_risk) values(?,?,?,?,?,?,?,?,?)').run(id,s.symbol,o.side,c.time,o.price,o.sl,o.tp,o.lots,Math.abs(o.price-(o.sl||o.price))*o.lots*100000)}}for(const t of db.prepare("select * from trades where session_id=? and status='open'").all(id) as any[]){const hit=exitHit(c,t.sl,t.tp,'conservative');if(hit){const price=hit==='stop'?t.sl:t.tp,profit=pnl(t.side,t.entry,price,t.lots);db.prepare("update trades set exit_time=?,exit=?,pnl=?,status='closed' where id=?").run(c.time,price,profit,t.id);db.prepare('update sessions set balance=balance+? where id=?').run(profit,id)}}}})();r.json({session:db.prepare('select * from sessions where id=?').get(id),candles:cs,done:cs.length<n})});
app.post('/api/orders',(q,r)=>{const b=q.body||{},s:any=db.prepare('select * from sessions where id=?').get(Number(b.sessionId));if(!s)return r.status(404).json({error:'Session not found'});if(!['buy','sell'].includes(b.side)||!['market','limit','stop'].includes(b.type)||!(Number(b.lots)>0))return r.status(400).json({error:'Invalid order fields'});const c:any=db.prepare('select close,time from candles where symbol=? and time<=? order by time desc limit 1').get(s.symbol,s.cursor);if(!c)return r.status(422).json({error:'Step replay forward to reveal a price first'});const price=b.type==='market'?c.close:Number(b.price);if(!(price>0))return r.status(400).json({error:'Invalid price'});if(b.sl!=null&&((b.side==='buy'&&Number(b.sl)>=price)||(b.side==='sell'&&Number(b.sl)<=price)))return r.status(400).json({error:'Stop-loss is on the wrong side of entry'});let id:any;if(b.type==='market')id=db.prepare('insert into trades(session_id,symbol,side,entry_time,entry,sl,tp,lots,initial_risk) values(?,?,?,?,?,?,?,?,?)').run(s.id,s.symbol,b.side,c.time,price,b.sl??null,b.tp??null,Number(b.lots),Math.abs(price-Number(b.sl||price))*Number(b.lots)*100000).lastInsertRowid;else id=db.prepare('insert into orders(session_id,symbol,side,type,price,lots,sl,tp) values(?,?,?,?,?,?,?,?)').run(s.id,s.symbol,b.side,b.side+'_'+b.type,price,Number(b.lots),b.sl??null,b.tp??null).lastInsertRowid;r.status(201).json({id})});
app.get('/api/trades',(_q,r)=>r.json(db.prepare('select * from trades order by entry_time desc limit 1000').all()));app.get('/api/sessions/:id/trades',(q,r)=>r.json(db.prepare('select * from trades where session_id=? order by entry_time desc').all(Number(q.params.id))));app.post('/api/sessions/:sessionId/trades/:tradeId/close',(q,r)=>{const sessionId=Number(q.params.sessionId),tradeId=Number(q.params.tradeId),s:any=db.prepare('select * from sessions where id=?').get(sessionId);if(!s)return r.status(404).json({error:'Session not found'});const t:any=db.prepare('select * from trades where id=? and session_id=?').get(tradeId,sessionId);if(!t)return r.status(404).json({error:'Trade not found in this session'});if(t.status!=='open')return r.status(409).json({error:'Trade is already closed'});const c:any=db.prepare('select close,time from candles where symbol=? and time<=? order by time desc limit 1').get(s.symbol,s.cursor);if(!c)return r.status(422).json({error:'No revealed candle available at the replay cursor'});const profit=pnl(t.side,t.entry,c.close,t.lots);const result=db.transaction(()=>{const changed=db.prepare("update trades set exit_time=?,exit=?,pnl=?,status='closed' where id=? and session_id=? and status='open'").run(c.time,c.close,profit,tradeId,sessionId);if(changed.changes!==1)throw Error('Trade is already closed');db.prepare('update sessions set balance=balance+? where id=?').run(profit,sessionId);return{trade:db.prepare('select * from trades where id=?').get(tradeId),session:db.prepare('select * from sessions where id=?').get(sessionId)}})();r.json(result)});app.patch('/api/trades/:id',(q,r)=>{const b=q.body||{};db.prepare('update trades set notes=coalesce(?,notes),strategy=coalesce(?,strategy),tags=coalesce(?,tags) where id=?').run(b.notes??null,b.strategy??null,b.tags?JSON.stringify(b.tags):null,Number(q.params.id));r.json(db.prepare('select * from trades where id=?').get(Number(q.params.id)))});
app.get('/api/analytics',(_q,r)=>{const ts=db.prepare("select * from trades where status='closed'").all() as any[],w=ts.filter(t=>t.pnl>0),l=ts.filter(t=>t.pnl<0),gp=w.reduce((a,t)=>a+t.pnl,0),gl=-l.reduce((a,t)=>a+t.pnl,0),net=gp-gl;r.json({total:ts.length,wins:w.length,losses:l.length,breakEven:ts.length-w.length-l.length,winRate:ts.length?w.length/ts.length*100:0,grossProfit:gp,grossLoss:gl,net,profitFactor:gl?gp/gl:null,averageWinner:w.length?gp/w.length:0,averageLoser:l.length?-gl/l.length:0,expectancy:ts.length?net/ts.length:0,trades:ts})});app.get('/api/settings',(_q,r)=>r.json(Object.fromEntries((db.prepare('select key,value from settings').all() as any[]).map(x=>[x.key,JSON.parse(x.value)]))));app.put('/api/settings',(q,r)=>{const st=db.prepare('insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value');for(const[k,v]of Object.entries(q.body||{}))st.run(k,JSON.stringify(v));r.json({ok:true})});
const upload=multer({storage:multer.diskStorage({destination:(_q,_f,cb)=>cb(null,path.join(root,'screenshots')),filename:(_q,f,cb)=>cb(null,Date.now()+'-'+f.originalname.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-80))}),limits:{fileSize:8*1024*1024},fileFilter:(_q,f,cb)=>cb(null,['image/png','image/jpeg','image/webp'].includes(f.mimetype))});app.post('/api/trades/:id/screenshots',upload.single('image'),(q,r)=>{if(!q.file)return r.status(400).json({error:'PNG/JPEG/WebP image up to 8 MB required'});db.prepare('insert into journal_notes(trade_id,body) values(?,?)').run(Number(q.params.id),'Screenshot: '+q.file.filename);r.status(201).json({filename:q.file.filename})});
app.get('/api/downloads',(_q,r)=>r.json(db.prepare('select * from downloads order by id desc').all()));app.post('/api/downloads',(q,r)=>{const b=q.body||{};if(!b.symbol||!b.startDate||!b.endDate||b.startDate>b.endDate)return r.status(400).json({error:'Instrument and valid date range required'});const id=Number(db.prepare("insert into downloads(symbol,start_date,end_date,status) values(?,?,?,'queued')").run(String(b.symbol).toUpperCase(),b.startDate,b.endDate).lastInsertRowid);r.status(202).json({id,status:'queued'});download(id,String(b.symbol).toLowerCase(),String(b.startDate),String(b.endDate))});const MARKET_TZ='America/New_York';
const MAX_DAY_ATTEMPTS=3;
const RETRY_DELAY_MS=1000;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function marketClock(epochMs:number){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:MARKET_TZ,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(epochMs));
  return Object.fromEntries(parts.filter(p=>p.type!=='literal').map(p=>[p.type,p.value])) as Record<string,string>;
}
function forexMarketOpen(epochMs:number){
  const t=marketClock(epochMs),day=t.weekday,h=Number(t.hour),m=Number(t.minute),afterOpen=h>17||(h===17&&m>=0),beforeClose=h<17;
  if(day==='Sat')return false;
  if(day==='Sun')return afterOpen;
  if(day==='Fri')return beforeClose;
  return true;
}
function utcDayHasOpenMarket(startMs:number,endMs:number){
  for(let t=startMs;t<endMs;t+=60*60*1000)if(forexMarketOpen(t))return true;
  return false;
}
async function download(id:number,symbol:string,start:string,end:string){
  const pair=symbol.toUpperCase(),failures:string[]=[];
  const log=(event:string,details:Record<string,unknown>={})=>console.log('[historical-download]',JSON.stringify({id,symbol:pair,event,...details}));
  try{
    log('started',{startDate:start,endDate:end,maxAttempts:MAX_DAY_ATTEMPTS});
    db.prepare("update downloads set status='running',progress=0,error=NULL where id=?").run(id);
    const mod:any=await import('dukascopy-node'),fn=mod.getHistoricalRates||mod.default;
    if(typeof fn!=='function')throw Error('dukascopy-node getHistoricalRates API unavailable');
    const first=Date.parse(start+'T00:00:00Z'),last=Date.parse(end+'T00:00:00Z');
    if(!Number.isFinite(first)||!Number.isFinite(last)||first>last)throw Error('Invalid UTC date range');
    const totalDays=Math.floor((last-first)/86400000)+1;
    log('range-validated',{totalDays});
    const hasCandles=db.prepare('select 1 from candles where symbol=? and time>=? and time<? limit 1');
    const put=db.prepare('insert or ignore into candles(symbol,time,open,high,low,close,volume,price_type) values(?,?,?,?,?,?,?,?)');
    const saveDay=(rows:any[],dayStart:number,dayEnd:number)=>db.transaction((batch:any[])=>{
      for(const x of batch){
        const rawTime=x.timestamp??x.time;
        const ms=rawTime instanceof Date?rawTime.getTime():typeof rawTime==='number'?(rawTime<1e12?rawTime*1000:rawTime):new Date(rawTime).getTime();
        if(!Number.isFinite(ms)||ms<dayStart||ms>=dayEnd||!forexMarketOpen(ms))continue;
        const c={time:Math.floor(ms/1000),open:Number(x.open),high:Number(x.high),low:Number(x.low),close:Number(x.close),volume:Number(x.volume||0)};
        if(valid(c))put.run(pair,c.time,c.open,c.high,c.low,c.close,c.volume,'bid');
      }
    })(rows);
    for(let n=0;n<totalDays;n++){
      const dayStart=first+n*86400000,dayEnd=dayStart+86400000,day=new Date(dayStart).toISOString().slice(0,10);
      if(!utcDayHasOpenMarket(dayStart,dayEnd)){
        log('day-skipped-market-closed',{day});
        db.prepare('update downloads set progress=? where id=?').run(Math.round((n+1)/totalDays*100),id);
        continue;
      }
      if(hasCandles.get(pair,Math.floor(dayStart/1000),Math.floor(dayEnd/1000))){
        log('day-skipped-existing-data',{day});
        db.prepare('update downloads set progress=? where id=?').run(Math.round((n+1)/totalDays*100),id);
        continue;
      }
      let saved=false,lastError='No candles returned for an open-market period';
      for(let attempt=1;attempt<=MAX_DAY_ATTEMPTS;attempt++){
        try{
          log('day-attempt',{day,attempt,maxAttempts:MAX_DAY_ATTEMPTS});
          const result=await fn({instrument:symbol,dates:{from:new Date(dayStart),to:new Date(dayEnd-60000)},timeframe:'m1',format:'json',priceType:'bid',volume:true});
          const rows=Array.isArray(result)?result:result?.data||[];
          log('provider-response',{day,attempt,returnedRows:rows.length});
          const relevant=rows.filter((x:any)=>{
            const raw=x.timestamp??x.time,ms=raw instanceof Date?raw.getTime():typeof raw==='number'?(raw<1e12?raw*1000:raw):new Date(raw).getTime();
            return Number.isFinite(ms)&&ms>=dayStart&&ms<dayEnd&&forexMarketOpen(ms);
          });
          if(relevant.length===0)throw Error('No candles returned for an open-market period');
          saveDay(relevant,dayStart,dayEnd);
          saved=true;
          log('day-saved',{day,attempt,eligibleRows:relevant.length});
          break;
        }catch(e){lastError=String(e).slice(0,300);log('day-attempt-failed',{day,attempt,maxAttempts:MAX_DAY_ATTEMPTS,error:lastError,retrying:attempt<MAX_DAY_ATTEMPTS});if(attempt<MAX_DAY_ATTEMPTS)await sleep(RETRY_DELAY_MS*attempt);}
      }
      if(!saved){failures.push(day+': '+lastError);log('day-abandoned',{day,attempts:MAX_DAY_ATTEMPTS,error:lastError});}
      db.prepare('update downloads set progress=? where id=?').run(Math.round((n+1)/totalDays*100),id);
    }
    db.prepare("update downloads set status='completed',progress=100,error=? where id=?").run(failures.length?('Skipped after '+MAX_DAY_ATTEMPTS+' attempts: '+failures.join('; ')).slice(0,800):null,id);
    log('finished',{totalDays,failedDays:failures.length,failedDates:failures.map(x=>x.split(':')[0])});
  }catch(e){
    log('download-failed',{error:String(e).slice(0,800)});
    db.prepare("update downloads set status='failed',error=? where id=?").run(String(e).slice(0,800),id);
  }
}
app.get('/api/export/trades.csv',(_q,r)=>{const rows=db.prepare('select * from trades order by entry_time').all() as any[],cols=rows.length?Object.keys(rows[0]):['id','symbol','side','entry_time','entry','exit_time','exit','lots','pnl','status','notes'];r.type('text/csv').attachment('atlas-trades.csv').send([cols.join(','),...rows.map(x=>cols.map(k=>JSON.stringify(x[k]??'')).join(','))].join('\n'))});const front=path.resolve(process.cwd(),'frontend/dist');if(fs.existsSync(front)){app.use(express.static(front));app.get('*',(q,r,next)=>q.path.startsWith('/api/')?next():r.sendFile(path.join(front,'index.html')))}app.listen(port,'0.0.0.0',()=>console.log('MH Forex Replay listening on '+port));
