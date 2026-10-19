import{spawn}from'node:child_process';import{fileURLToPath}from'node:url';import express from'express';import helmet from'helmet';import cors from'cors';import multer from'multer';import path from'node:path';import fs from'node:fs';import{db}from'./db.js';import{describeDownloadError,sanitizeLogMessage}from'./download-utils.js';import{parseCandleCsv}from'./csv-import.js';import{aggregate,valid,exitHit,pnl}from'./core.js';const app=express(),root=process.env.DATA_DIR||'./data';fs.mkdirSync(path.join(root,'dukascopy-cache'),{recursive:true});fs.mkdirSync(path.join(root,'dukascopy-legacy-cache'),{recursive:true});app.disable('x-powered-by');app.use(helmet({crossOriginResourcePolicy:{policy:'same-origin'}}));app.use(cors({origin:false}));app.use(express.json({limit:'2mb'}));const port=Number(process.env.PORT||8080);
type AppLog={id:number;time:string;level:string;scope:string;message:string};
const logBuffer:AppLog[]=[];const logClients=new Set<any>();const cancelledDownloads=new Set<number>();const pythonDownloadProcesses=new Map<number,ReturnType<typeof spawn>>();const downloadTasks=new Map<number,Promise<void>>();let downloadQueueTail:Promise<void>=Promise.resolve();let nextLogId=1;
function appLog(level:string,scope:string,message:string){const entry:AppLog={id:nextLogId++,time:new Date().toISOString().slice(11,23),level,scope,message:sanitizeLogMessage(message)};logBuffer.push(entry);if(logBuffer.length>500)logBuffer.shift();const payload='data: '+JSON.stringify(entry)+'\n\n';for(const client of logClients){try{client.write(payload)}catch{logClients.delete(client)}}}
appLog('INFO','API','Atlas backend process initialized');
app.use((q,r,next)=>{const started=Date.now();if(q.path.startsWith('/api/')&&!q.path.startsWith('/api/logs')&&['POST','PUT','PATCH','DELETE'].includes(q.method)){r.on('finish',()=>appLog(r.statusCode>=400?'WARN':'INFO','HTTP',q.method+' '+q.path+' → '+r.statusCode+' ('+(Date.now()-started)+' ms)'))}next()});
app.get('/api/diagnostics',(_q,r)=>{try{const dbPath=path.join(root,'atlas.sqlite');const fileSize=(p:string)=>{try{return fs.statSync(p).size}catch{return 0}};const databaseBytes=fileSize(dbPath),walBytes=fileSize(dbPath+'-wal'),shmBytes=fileSize(dbPath+'-shm');const directorySize=(dir:string):number=>{let total=0;try{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())total+=directorySize(full);else if(entry.isFile())total+=fileSize(full)}}catch{}return total};const dataDirectoryBytes=directorySize(root);let filesystem:any=null;try{const statfs=(fs as any).statfsSync;if(typeof statfs==='function'){const s=statfs(root);filesystem={path:root,totalBytes:Number(s.blocks)*Number(s.bsize),freeBytes:Number(s.bavail)*Number(s.bsize),usedBytes:(Number(s.blocks)-Number(s.bfree))*Number(s.bsize)}}}catch{}r.json({databasePath:dbPath,databaseBytes,walBytes,shmBytes,dataDirectoryBytes,filesystem,checkedAt:new Date().toISOString()})}catch(e){r.status(500).json({error:'Unable to inspect database storage'})}});
app.get('/api/diagnostics/tables',(_q,r)=>{try{const names=db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all() as {name:string}[];const tables=names.map(({name})=>{const safe='"'+name.replace(/"/g,'""')+'"';const rows=Number((db.prepare('select count(*) as n from '+safe).get() as any).n||0);const columns=db.prepare('pragma table_info('+safe+')').all() as any[];const sample=rows?db.prepare('select * from '+safe+' limit 30').all() as any[]:[];const avgRowBytes=sample.length?sample.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row),'utf8'),0)/sample.length:0;const indexes=db.prepare('pragma index_list('+safe+')').all() as any[];const sizeBytes=rows?Math.round(avgRowBytes*rows*(1+indexes.length*0.12)):0;return{name,rows,sizeBytes,columns:columns.map(c=>({name:c.name,type:c.type,notnull:c.notnull,pk:c.pk,dflt_value:c.dflt_value}))}});r.json({tables})}catch(e){r.status(500).json({error:'Unable to inspect database tables'})}});
app.get('/api/diagnostics/table/:name',(q,r)=>{try{const name=String(q.params.name||'');const exists=db.prepare("select name from sqlite_master where type='table' and name=? and name not like 'sqlite_%'").get(name) as any;if(!exists)return r.status(404).json({error:'Table not found'});const safe='"'+name.replace(/"/g,'""')+'"';const limit=Math.max(1,Math.min(100,Number(q.query.limit)||10)),offset=Math.max(0,Math.min(10000000,Number(q.query.offset)||0));const columns=db.prepare('pragma table_info('+safe+')').all() as any[];const columnNames=new Set(columns.map(c=>String(c.name)));const requestedSort=String(q.query.sortBy||'');const sortBy=columnNames.has(requestedSort)?requestedSort:(columnNames.has('time')?'time':String(columns[0]?.name||''));const sortDir=String(q.query.sortDir||'desc').toLowerCase()==='asc'?'ASC':'DESC';const quote=(value:string)=>'"'+value.replace(/"/g,'""')+'"';const search=String(q.query.search||'').trim().slice(0,100);let where='',params:any[]=[];if(search){const symbol=columns.find(c=>String(c.name).toLowerCase()==='symbol');const searchable=symbol?[symbol]:columns.filter(c=>/CHAR|TEXT|CLOB/i.test(String(c.type||''))).slice(0,8);if(searchable.length){where=' where ('+searchable.map(c=>'cast('+quote(String(c.name))+' as text) like ?').join(' or ')+')';params=searchable.map(()=>'%'+search+'%')}}const totalRows=Number((db.prepare('select count(*) as n from '+safe+where).get(...params) as any)?.n||0);const order=sortBy?' order by '+quote(sortBy)+' '+sortDir:'';const rows=db.prepare('select * from '+safe+where+order+' limit ? offset ?').all(...params,limit,offset);r.json({name,columns:columns.map(c=>({name:c.name,type:c.type,notnull:c.notnull,pk:c.pk,dflt_value:c.dflt_value})),rows,limit,offset,totalRows,sortBy,sortDir,search})}catch(e){r.status(500).json({error:'Unable to inspect selected table'})}});
app.delete('/api/candles/instrument/:symbol',(q,r)=>{try{
 const symbol=String(q.params.symbol||'').trim().toUpperCase();
 if(!symbol||!db.prepare('select symbol from instruments where symbol=?').get(symbol))return r.status(404).json({error:'Unknown instrument symbol'});
 const active=db.prepare("select id,status from downloads where upper(symbol)=? and status in ('queued','running') order by id").all(symbol) as {id:number;status:string}[];
 if(active.length)return r.status(409).json({error:'Cannot delete '+symbol+' candles while download job(s) are active: '+active.map(j=>'#'+j.id+' '+j.status).join(', ')+'. Stop or finish those jobs first.'});
 const deleted=db.transaction(()=>Number(db.prepare('delete from candles where symbol=?').run(symbol).changes))();
 appLog('WARN','DATABASE','Deleted '+deleted+' candle row(s) for instrument '+symbol+' at user request');
 r.json({ok:true,symbol,deletedRows:deleted,message:'Only candle rows for '+symbol+' were deleted. Sessions, trades, download history and other instruments were left unchanged.'});
}catch(e){r.status(500).json({error:'Could not delete candles for the selected instrument'})}});
app.get('/api/logs',(_q,r)=>r.json({logs:logBuffer}));
app.get('/api/logs/stream',(q,r)=>{r.status(200);r.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});r.flushHeaders?.();for(const entry of logBuffer.slice(-100))r.write('data: '+JSON.stringify(entry)+'\n\n');logClients.add(r);const heartbeat=setInterval(()=>{try{r.write(': keep-alive\n\n')}catch{}},20000);q.on('close',()=>{clearInterval(heartbeat);logClients.delete(r)})});
app.get('/api/health',(_q,r)=>{try{db.prepare('select 1').get();r.json({ok:true,db:'ready'})}catch{r.status(503).json({ok:false})}});app.get('/api/instruments',(_q,r)=>r.json(db.prepare('select * from instruments order by symbol').all()));app.get('/api/coverage',(q,r)=>{const symbol=String(q.query.symbol||'EURUSD').toUpperCase(),start=String(q.query.start||''),end=String(q.query.end||'');if(start||end){if(!validDateOnly(start)||!validDateOnly(end)||start>end)return r.status(400).json({error:'Valid start and end dates in YYYY-MM-DD format are required'});const from=Math.floor(new Date(start+'T00:00:00Z').getTime()/1000),until=Math.floor(new Date(end+'T00:00:00Z').getTime()/1000)+86400;const range:any=db.prepare('select min(time) start,max(time) end,count(*) candles from candles where symbol=? and time>=? and time<?').get(symbol,from,until);const total:any=db.prepare('select count(*) candles from candles where symbol=?').get(symbol);return r.json({...range,rangeCandles:Number(range?.candles||0),totalCandles:Number(total?.candles||0),requestedStart:start,requestedEnd:end})}r.json(db.prepare('select min(time) start,max(time) end,count(*) candles from candles where symbol=?').get(symbol))});

app.get('/api/coverage/check',(q,r)=>{const symbol=String(q.query.symbol||'EURUSD').toUpperCase(),start=String(q.query.start||''),end=String(q.query.end||'');if(!validDateOnly(start)||!validDateOnly(end)||start>end)return r.status(400).json({error:'Valid start and end dates in YYYY-MM-DD format are required'});const from=Math.floor(new Date(start+'T00:00:00Z').getTime()/1000),until=Math.floor(new Date(end+'T00:00:00Z').getTime()/1000)+86400,dayCount=Math.round((until-from)/86400);if(dayCount>366)return r.status(400).json({error:'Scan at most 366 calendar days at a time'});const rows=db.prepare("select time from candles where symbol=? and price_type='bid' and time>=? and time<? order by time").all(symbol,from,until) as any[],stored=new Set<number>(),days=new Map<string,{expected:number;found:number;actual:number}>();for(let offset=0;offset<dayCount;offset++)days.set(shiftCoverageDate(start,offset),{expected:0,found:0,actual:0});for(const row of rows){const timestamp=Math.floor(Number(row.time)/60)*60;if(timestamp<from||timestamp>=until)continue;stored.add(timestamp);const date=new Date(timestamp*1000).toISOString().slice(0,10),daily=days.get(date);if(daily)daily.actual++}const expected=new Set<number>();const localStart=shiftCoverageDate(start,-2),localEnd=shiftCoverageDate(end,2);for(let cursor=localStart;cursor<=localEnd;cursor=shiftCoverageDate(cursor,1)){const weekday=new Date(cursor+'T00:00:00Z').getUTCDay(),next=shiftCoverageDate(cursor,1),isMetal=symbol==='XAUUSD',intervals:[number,number][]=[];if(weekday===0)intervals.push([newYorkCoverageTime(cursor,isMetal?18:17,0),newYorkCoverageTime(next,0,0)]);else if(weekday>=1&&weekday<=4){if(isMetal)intervals.push([newYorkCoverageTime(cursor,0,0),newYorkCoverageTime(cursor,17,0)],[newYorkCoverageTime(cursor,18,0),newYorkCoverageTime(next,0,0)]);else intervals.push([newYorkCoverageTime(cursor,0,0),newYorkCoverageTime(next,0,0)])}else if(weekday===5)intervals.push([newYorkCoverageTime(cursor,0,0),newYorkCoverageTime(cursor,17,0)]);for(const [sessionStart,sessionEnd] of intervals){for(let timestamp=sessionStart;timestamp<sessionEnd;timestamp+=60){if(timestamp<from||timestamp>=until)continue;expected.add(timestamp);const date=new Date(timestamp*1000).toISOString().slice(0,10),daily=days.get(date);if(daily)daily.expected++}}}let foundExpected=0,missingMinutes=0,gapCount=0,gaps:any[]=[],gapStart:number|null=null,gapLast:number|null=null,gapLength=0;const closeGap=()=>{if(gapStart!==null){gapCount++;gaps.push({start:gapStart,end:gapLast,missingMinutes:gapLength});gapStart=null;gapLast=null;gapLength=0}};for(const timestamp of [...expected].sort((a,b)=>a-b)){const present=stored.has(timestamp);if(present){foundExpected++;const daily=days.get(new Date(timestamp*1000).toISOString().slice(0,10));if(daily)daily.found++}else{missingMinutes++;if(gapStart===null||gapLast===null||timestamp!==gapLast+60){closeGap();gapStart=timestamp;gapLength=1}else gapLength++;gapLast=timestamp}}closeGap();const daily=[...days.entries()].map(([date,value])=>({date,expectedMinutes:value.expected,candles:value.actual,observedExpectedMinutes:value.found,missingMinutes:Math.max(0,value.expected-value.found),status:value.expected===0?'closed':value.found===0?'missing':value.found===value.expected?'complete':'partial'}));const outside=rows.reduce((n,row)=>n+(expected.has(Math.floor(Number(row.time)/60)*60)?0:1),0);gaps.sort((a,b)=>b.missingMinutes-a.missingMinutes||a.start-b.start);r.json({symbol,start,end,calendarDays:dayCount,totalCandles:rows.length,expectedMinutes:expected.size,observedExpectedMinutes:foundExpected,missingMinutes,gapIntervalsTotal:gapCount,gaps:gaps.slice(0,100).map(g=>({start:g.start,end:g.end,missingMinutes:g.missingMinutes})),moreGapIntervals:Math.max(0,gapCount-100),candlesOutsideModeledSession:outside,daily,assumptions:symbol==='XAUUSD'?'Estimated Dukascopy XAUUSD schedule in America/New_York time: Sunday opens at 18:00, weekdays pause 17:00–18:00, Friday closes at 17:00; Saturday is closed. UTC dates are used in this report. US holidays, early closes, and exceptions are not modeled and may be flagged as missing.':'Estimated Dukascopy FX schedule in America/New_York time: Sunday opens at 17:00 and Friday closes at 17:00, with continuous trading through Monday–Thursday; Saturday is closed. UTC dates are used in this report. Public holidays, early closes, and instrument-specific exceptions are not modeled and may be flagged as missing.'})});
function easterSundayUtc(year:number):Date{
 const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=((h+l-7*m+114)%31)+1;
 return new Date(Date.UTC(year,month-1,day));
}
function coverageMarketClosure(date:string):'closed'|'reduced-hours'|null{
 const d=new Date(date+'T00:00:00Z'),year=d.getUTCFullYear(),month=d.getUTCMonth()+1,day=d.getUTCDate();
 // FX is normally closed on New Year's Day, Good Friday and Christmas Day.
 if((month===1&&day===1)||(month===12&&day===25))return 'closed';
 const easter=easterSundayUtc(year),goodFriday=new Date(easter.getTime()-2*86400000).toISOString().slice(0,10);
 if(date===goodFriday)return 'closed';
 // These dates often have shortened/reduced FX sessions. A zero-candle result
 // should be reviewed against the provider calendar rather than asserted missing.
 if((month===11&&day>=22&&day<=28&&d.getUTCDay()===4)||(month===12&&(day===24||day===31)))return 'reduced-hours';
 return null;
}
app.get('/api/coverage/full-days',(q,r)=>{
 const symbol=String(q.query.symbol||'EURUSD').toUpperCase(),start=String(q.query.start||''),end=String(q.query.end||'');
 if(!validDateOnly(start)||!validDateOnly(end)||start>end)return r.status(400).json({error:'Valid start and end dates in YYYY-MM-DD format are required'});
 const from=Math.floor(new Date(start+'T00:00:00Z').getTime()/1000),until=Math.floor(new Date(end+'T00:00:00Z').getTime()/1000)+86400,calendarDays=Math.round((until-from)/86400);
 if(calendarDays>366)return r.status(400).json({error:'Scan at most 366 calendar days at a time'});
 const grouped=db.prepare("select strftime('%Y-%m-%d',time,'unixepoch') as date,count(*) as candles from candles where symbol=? and price_type='bid' and time>=? and time<? group by strftime('%Y-%m-%d',time,'unixepoch') order by date").all(symbol,from,until) as any[];
 const counts=new Map<string,number>(grouped.map((row:any)=>[String(row.date),Number(row.candles||0)] as [string,number]));
 const todayUtc=new Date().toISOString().slice(0,10);
 const daily:any[]=[];let weekdaysChecked=0,missingWholeWeekdays=0,weekdaysWithCandles=0,weekendDaysIgnored=0,marketClosedDays=0,reducedHoursReviewDays=0,futureDaysIgnored=0,currentDayInProgress=0,totalCandlesInRange=0;
 for(let offset=0;offset<calendarDays;offset++){
  const date=shiftCoverageDate(start,offset),weekday=new Date(date+'T00:00:00Z').getUTCDay(),weekend=weekday===0||weekday===6,candles=counts.get(date)||0,closure=coverageMarketClosure(date);
  totalCandlesInRange+=candles;let status:string;
  if(date>todayUtc){status='future';futureDaysIgnored++}
  else if(date===todayUtc){status='today-in-progress';currentDayInProgress++}
  else if(weekend){status='weekend';weekendDaysIgnored++}
  else if(closure==='closed'&&candles===0){status='market-closed';marketClosedDays++}
  else if(closure==='reduced-hours'&&candles===0){status='holiday-review';reducedHoursReviewDays++}
  else{
   weekdaysChecked++;
   if(candles===0){status='missing';missingWholeWeekdays++}
   else{status='has-data';weekdaysWithCandles++}
  }
  daily.push({date,weekday:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][weekday],status,candles});
 }
 r.json({symbol,start,end,todayUtc,calendarDays,totalCandlesInRange,weekdaysChecked,missingWholeWeekdays,weekdaysWithCandles,weekendDaysIgnored,marketClosedDays,reducedHoursReviewDays,futureDaysIgnored,currentDayInProgress,daily,missingDays:daily.filter(day=>day.status==='missing').map(day=>day.date),reviewDays:daily.filter(day=>day.status==='holiday-review').map(day=>day.date),assumptions:'Only completed UTC dates before today are evaluated for missing whole days. Today is marked in progress and is never flagged as missing; all later dates are ignored as future. Saturdays and Sundays in the past are ignored. Known full FX closures (New Year’s Day, Good Friday and Christmas Day) are not counted as missing when empty. US Thanksgiving and Dec 24/31 are flagged for schedule review if empty because sessions can be shortened. This check does not detect missing minutes within a day, and other provider/instrument-specific holidays may need manual review.'});
});
app.get('/api/candles',(q,r)=>{const symbol=String(q.query.symbol||'EURUSD').toUpperCase(),from=Number(q.query.from||0),cursor=Number(q.query.cursor||q.query.to||Date.now()/1000),limit=Math.max(1,Math.min(10000,Number(q.query.limit||3000))),tf=Math.max(1,Number(q.query.timeframe||1));const rows=db.prepare('select time,open,high,low,close,volume from candles where symbol=? and time>=? and time<=? order by time desc limit ?').all(symbol,from,cursor,limit).reverse() as any[];r.json(tf===1?rows:aggregate(rows,tf))});
app.post('/api/sessions',(q,r)=>{const b=q.body||{};if(!Number.isFinite(Number(b.startTime))||!(Number(b.initialBalance||10000)>0))return r.status(400).json({error:'Valid start time and positive balance required'});const symbol=String(b.symbol||'EURUSD').toUpperCase(),start=Number(b.startTime),endTime=Number.isFinite(Number(b.endTime))&&Number(b.endTime)>0?Number(b.endTime):null;if(endTime!==null&&endTime<start)return r.status(400).json({error:'End date must be on or after start date'});const first:any=db.prepare('select time from candles where symbol=? and time>=? and (? is null or time<=?) order by time limit 1').get(symbol,start,endTime,endTime);if(!first)return r.status(422).json({error:'No candles for this instrument/date. Download historical data first and check date coverage.'});const id=db.prepare('insert into sessions(name,symbol,start_time,cursor,initial_balance,balance,timeframe,account_currency,end_time) values(?,?,?,?,?,?,?,?,?)').run(String(b.name||symbol+' replay').slice(0,120),symbol,start,Number(first.time),Number(b.initialBalance||10000),Number(b.initialBalance||10000),Number(b.timeframe||1),b.accountCurrency||'USD',endTime).lastInsertRowid;r.status(201).json(db.prepare('select * from sessions where id=?').get(id))});app.get('/api/sessions',(_q,r)=>r.json(db.prepare('select * from sessions order by id desc').all()));
app.patch('/api/sessions/:id',(q,r)=>{const id=Number(q.params.id),name=String(q.body?.name??'').trim();if(!name)return r.status(400).json({error:'Session name is required'});if(name.length>120)return r.status(400).json({error:'Session name must be 120 characters or fewer'});const result=db.prepare('update sessions set name=? where id=?').run(name,id);if(!result.changes)return r.status(404).json({error:'Session not found'});r.json(db.prepare('select * from sessions where id=?').get(id))});
app.delete('/api/sessions/:id',(q,r)=>{const id=Number(q.params.id);if(!db.prepare('select id from sessions where id=?').get(id))return r.status(404).json({error:'Session not found'});db.transaction(()=>{db.prepare('delete from journal_notes where trade_id in (select id from trades where session_id=?)').run(id);db.prepare('delete from trades where session_id=?').run(id);db.prepare('delete from orders where session_id=?').run(id);db.prepare('delete from drawings where session_id=?').run(id);db.prepare('delete from sessions where id=?').run(id)})();r.json({ok:true,id})});app.get('/api/sessions/:id/visible',(q,r)=>{const s:any=db.prepare('select * from sessions where id=?').get(Number(q.params.id));if(!s)return r.status(404).json({error:'Session not found'});r.json({session:s,candles:db.prepare('select time,open,high,low,close,volume from candles where symbol=? and time>=? and time<=? order by time desc limit 1200').all(s.symbol,s.start_time,s.cursor).reverse()})});
app.post('/api/sessions/:id/step',(q,r)=>{const id=Number(q.params.id),s:any=db.prepare('select * from sessions where id=?').get(id);if(!s)return r.status(404).json({error:'Session not found'});const n=Math.min(1000,Math.max(1,Number(q.body?.count||1))),cs=db.prepare('select time,open,high,low,close,volume from candles where symbol=? and time>? and (? is null or time<=?) order by time limit ?').all(s.symbol,s.cursor,s.end_time??null,s.end_time??null,n) as any[];if(!cs.length)return r.json({session:s,candles:[],done:true});db.transaction(()=>{db.prepare('update sessions set cursor=? where id=?').run(cs.at(-1).time,id);for(const c of cs){const orders=db.prepare("select * from orders where session_id=? and status='pending'").all(id) as any[];for(const o of orders){const hit=o.type==='buy_limit'?c.low<=o.price:o.type==='sell_limit'?c.high>=o.price:o.type==='buy_stop'?c.high>=o.price:c.low<=o.price;if(hit){db.prepare("update orders set status='filled' where id=?").run(o.id);db.prepare('insert into trades(session_id,symbol,side,entry_time,entry,sl,tp,lots,initial_risk) values(?,?,?,?,?,?,?,?,?)').run(id,s.symbol,o.side,c.time,o.price,o.sl,o.tp,o.lots,Math.abs(o.price-(o.sl||o.price))*o.lots*100000)}}for(const t of db.prepare("select * from trades where session_id=? and status='open'").all(id) as any[]){const hit=exitHit(c,t.sl,t.tp,'conservative');if(hit){const price=hit==='stop'?t.sl:t.tp,profit=pnl(t.side,t.entry,price,t.lots);db.prepare("update trades set exit_time=?,exit=?,pnl=?,status='closed' where id=?").run(c.time,price,profit,t.id);db.prepare('update sessions set balance=balance+? where id=?').run(profit,id)}}}})();r.json({session:db.prepare('select * from sessions where id=?').get(id),candles:cs,done:cs.length<n})});
app.post('/api/orders',(q,r)=>{const b=q.body||{},s:any=db.prepare('select * from sessions where id=?').get(Number(b.sessionId));if(!s)return r.status(404).json({error:'Session not found'});if(!['buy','sell'].includes(b.side)||!['market','limit','stop'].includes(b.type)||!(Number(b.lots)>0))return r.status(400).json({error:'Invalid order fields'});const c:any=db.prepare('select close,time from candles where symbol=? and time<=? order by time desc limit 1').get(s.symbol,s.cursor);if(!c)return r.status(422).json({error:'Step replay forward to reveal a price first'});const price=b.type==='market'?c.close:Number(b.price);if(!(price>0))return r.status(400).json({error:'Invalid price'});if(b.sl!=null&&((b.side==='buy'&&Number(b.sl)>=price)||(b.side==='sell'&&Number(b.sl)<=price)))return r.status(400).json({error:'Stop-loss is on the wrong side of entry'});let id:any;if(b.type==='market')id=db.prepare('insert into trades(session_id,symbol,side,entry_time,entry,sl,tp,lots,initial_risk) values(?,?,?,?,?,?,?,?,?)').run(s.id,s.symbol,b.side,c.time,price,b.sl??null,b.tp??null,Number(b.lots),Math.abs(price-Number(b.sl||price))*Number(b.lots)*100000).lastInsertRowid;else id=db.prepare('insert into orders(session_id,symbol,side,type,price,lots,sl,tp) values(?,?,?,?,?,?,?,?)').run(s.id,s.symbol,b.side,b.side+'_'+b.type,price,Number(b.lots),b.sl??null,b.tp??null).lastInsertRowid;r.status(201).json({id})});
app.get('/api/trades',(_q,r)=>r.json(db.prepare('select * from trades order by entry_time desc limit 1000').all()));app.get('/api/sessions/:id/trades',(q,r)=>r.json(db.prepare('select * from trades where session_id=? order by entry_time desc').all(Number(q.params.id))));app.post('/api/sessions/:sessionId/trades/:tradeId/close',(q,r)=>{const sessionId=Number(q.params.sessionId),tradeId=Number(q.params.tradeId),s:any=db.prepare('select * from sessions where id=?').get(sessionId);if(!s)return r.status(404).json({error:'Session not found'});const t:any=db.prepare('select * from trades where id=? and session_id=?').get(tradeId,sessionId);if(!t)return r.status(404).json({error:'Trade not found in this session'});if(t.status!=='open')return r.status(409).json({error:'Trade is already closed'});const c:any=db.prepare('select close,time from candles where symbol=? and time<=? order by time desc limit 1').get(s.symbol,s.cursor);if(!c)return r.status(422).json({error:'No revealed candle available at the replay cursor'});const profit=pnl(t.side,t.entry,c.close,t.lots);const result=db.transaction(()=>{const changed=db.prepare("update trades set exit_time=?,exit=?,pnl=?,status='closed' where id=? and session_id=? and status='open'").run(c.time,c.close,profit,tradeId,sessionId);if(changed.changes!==1)throw Error('Trade is already closed');db.prepare('update sessions set balance=balance+? where id=?').run(profit,sessionId);return{trade:db.prepare('select * from trades where id=?').get(tradeId),session:db.prepare('select * from sessions where id=?').get(sessionId)}})();r.json(result)});app.patch('/api/trades/:id',(q,r)=>{const b=q.body||{},id=Number(q.params.id),t:any=db.prepare('select * from trades where id=?').get(id);if(!t)return r.status(404).json({error:'Trade not found'});const hasSL=Object.prototype.hasOwnProperty.call(b,'sl'),hasTP=Object.prototype.hasOwnProperty.call(b,'tp');if((hasSL||hasTP)&&t.status!=='open')return r.status(409).json({error:'Only open trades can have stop-loss or take-profit changed'});const nextSL=hasSL?(b.sl==null?null:Number(b.sl)):t.sl,nextTP=hasTP?(b.tp==null?null:Number(b.tp)):t.tp;if(hasSL&&nextSL!==null&&(!(nextSL>0)||!Number.isFinite(nextSL)||(t.side==='buy'?nextSL>=Number(t.entry):nextSL<=Number(t.entry))))return r.status(400).json({error:t.side==='buy'?'Stop-loss must be below entry for a buy trade':'Stop-loss must be above entry for a sell trade'});if(hasTP&&nextTP!==null&&(!(nextTP>0)||!Number.isFinite(nextTP)||(t.side==='buy'?nextTP<=Number(t.entry):nextTP>=Number(t.entry))))return r.status(400).json({error:t.side==='buy'?'Take-profit must be above entry for a buy trade':'Take-profit must be below entry for a sell trade'});const sets=['notes=coalesce(?,notes)','strategy=coalesce(?,strategy)','tags=coalesce(?,tags)'],values:any[]=[b.notes??null,b.strategy??null,b.tags?JSON.stringify(b.tags):null];if(hasSL){sets.push('sl=?','initial_risk=?');values.push(nextSL,Math.abs(Number(t.entry)-Number(nextSL??t.entry))*Number(t.lots)*100000)}if(hasTP){sets.push('tp=?');values.push(nextTP)}values.push(id);db.prepare('update trades set '+sets.join(',')+' where id=?').run(...values);r.json(db.prepare('select * from trades where id=?').get(id))});
app.get('/api/analytics',(_q,r)=>{const ts=db.prepare("select * from trades where status='closed'").all() as any[],w=ts.filter(t=>t.pnl>0),l=ts.filter(t=>t.pnl<0),gp=w.reduce((a,t)=>a+t.pnl,0),gl=-l.reduce((a,t)=>a+t.pnl,0),net=gp-gl;r.json({total:ts.length,wins:w.length,losses:l.length,breakEven:ts.length-w.length-l.length,winRate:ts.length?w.length/ts.length*100:0,grossProfit:gp,grossLoss:gl,net,profitFactor:gl?gp/gl:null,averageWinner:w.length?gp/w.length:0,averageLoser:l.length?-gl/l.length:0,expectancy:ts.length?net/ts.length:0,trades:ts})});app.get('/api/settings',(_q,r)=>r.json(Object.fromEntries((db.prepare('select key,value from settings').all() as any[]).map(x=>[x.key,JSON.parse(x.value)]))));app.put('/api/settings',(q,r)=>{const st=db.prepare('insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value');for(const[k,v]of Object.entries(q.body||{}))st.run(k,JSON.stringify(v));r.json({ok:true})});
const upload=multer({storage:multer.diskStorage({destination:(_q,_f,cb)=>cb(null,path.join(root,'screenshots')),filename:(_q,f,cb)=>cb(null,Date.now()+'-'+f.originalname.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-80))}),limits:{fileSize:8*1024*1024},fileFilter:(_q,f,cb)=>cb(null,['image/png','image/jpeg','image/webp'].includes(f.mimetype))});app.post('/api/trades/:id/screenshots',upload.single('image'),(q,r)=>{if(!q.file)return r.status(400).json({error:'PNG/JPEG/WebP image up to 8 MB required'});db.prepare('insert into journal_notes(trade_id,body) values(?,?)').run(Number(q.params.id),'Screenshot: '+q.file.filename);r.status(201).json({filename:q.file.filename})});

function validDateOnly(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value}

const coverageNyFormatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
function shiftCoverageDate(date:string,days:number){const value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10)}
function newYorkCoverageTime(date:string,hour:number,minute:number){const [year,month,day]=date.split('-').map(Number);const desired=Date.UTC(year,month-1,day,hour,minute,0);let guess=desired;for(let i=0;i<4;i++){const parts:any={};for(const part of coverageNyFormatter.formatToParts(new Date(guess)))if(part.type!=='literal')parts[part.type]=part.value;const represented=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));const delta=desired-represented;if(delta===0)break;guess+=delta}return Math.floor(guess/60000)*60}

function candleTimestampSeconds(rawTime:any){const numeric=typeof rawTime==='number'?rawTime:(typeof rawTime==='string'&&rawTime.trim()!==''?Number(rawTime):NaN);const milliseconds=Number.isFinite(numeric)?(Math.abs(numeric)<1e12?numeric*1000:numeric):new Date(rawTime).getTime();return Number.isFinite(milliseconds)?Math.floor(milliseconds/1000):NaN}
function scheduleDownload(id:number,symbol:string,start:string,end:string,waitForId?:number){
 const task=downloadQueueTail.then(async()=>{
  if(waitForId!==undefined){
   const previousTask=downloadTasks.get(waitForId);
   if(previousTask)await previousTask;
  }
  if(cancelledDownloads.has(id)){
   cancelledDownloads.delete(id);
   appLog('INFO','DOWNLOAD','Job #'+id+': restart was superseded before the replacement began');
   return;
  }
  appLog('INFO','DOWNLOAD','Job #'+id+': worker started via Python downloader; downloads run one at a time to reduce provider timeouts');
  await download(id,symbol,start,end);
 }).finally(()=>{downloadTasks.delete(id)});
 downloadQueueTail=task.then(()=>undefined,()=>undefined);
 downloadTasks.set(id,task);
 return task;
}
app.get('/api/downloads',(_q,r)=>r.json(db.prepare('select * from downloads order by id desc').all()));
app.post('/api/downloads',(q,r)=>{
 const b=q.body||{},symbol=String(b.symbol||'').toUpperCase(),start=String(b.startDate||''),end=String(b.endDate||'');
 if(!symbol||!validDateOnly(start)||!validDateOnly(end)||start>end)return r.status(400).json({error:'Instrument and valid start/end dates in YYYY-MM-DD format are required'});
 const active:any=db.prepare("select id,status from downloads where upper(symbol)=? and start_date=? and end_date=? and status in ('queued','running') order by id desc limit 1").get(symbol,start,end);
 if(active){appLog('INFO','DOWNLOAD','Duplicate Python downloader request for '+symbol+' '+start+' to '+end+' reused active job #'+active.id);return r.status(200).json({id:Number(active.id),status:String(active.status),existing:true,downloader:'python'})}
 const id=Number(db.prepare("insert into downloads(symbol,start_date,end_date,status,progress,downloader) values(?,?,?,'queued',0,'python')").run(symbol,start,end).lastInsertRowid);
 appLog('INFO','DOWNLOAD','Queued Python downloader job #'+id+' for '+symbol+' from '+start+' to '+end);
 scheduleDownload(id,symbol.toLowerCase(),start,end);
 r.status(202).json({id,status:'queued',existing:false,downloader:'python'});
});
app.post('/api/downloads/delete-failed',(q,r)=>{const raw=Array.isArray(q.body?.ids)?q.body.ids:[];const ids=[...new Set(raw.map(Number).filter((id:number)=>Number.isSafeInteger(id)&&id>0))];if(!ids.length)return r.status(400).json({error:'Select at least one failed job to delete'});if(ids.length>250)return r.status(400).json({error:'Delete at most 250 jobs at a time'});const findJob=db.prepare('select * from downloads where id=?');const hasActiveDescendant=db.prepare("with recursive descendants(id) as (select id from downloads where retry_of=? union all select d.id from downloads d join descendants x on d.retry_of=x.id) select id from downloads where id in (select id from descendants) and status in ('queued','running') limit 1");const candidates=ids.map(id=>findJob.get(id) as any).filter(job=>job&&job.status==='failed'&&!job.recovered_by&&!hasActiveDescendant.get(Number(job.id)));if(!candidates.length)return r.status(409).json({error:'No selected jobs are eligible for deletion. Only unresolved failed jobs without active retries can be deleted.'});const removed=db.transaction(()=>{const del=db.prepare("delete from downloads where id=? and status='failed' and recovered_by is null");return candidates.filter(job=>del.run(Number(job.id)).changes>0).map(job=>Number(job.id))})();appLog('WARN','DOWNLOAD','Deleted '+removed.length+' unresolved failed download job(s): '+removed.map(id=>'#'+id).join(', '));r.json({deleted:removed,skipped:ids.length-removed.length})});
app.delete('/api/downloads/:id',(q,r)=>{const id=Number(q.params.id),job=db.prepare('select id,status,recovered_by from downloads where id=?').get(id) as any;if(!job)return r.status(404).json({error:'Download job not found'});if(job.status!=='failed'||job.recovered_by)return r.status(409).json({error:'Only unresolved failed jobs can be deleted'});const active=db.prepare("with recursive descendants(id) as (select id from downloads where retry_of=? union all select d.id from downloads d join descendants x on d.retry_of=x.id) select id from downloads where id in (select id from descendants) and status in ('queued','running') limit 1").get(id) as any;if(active)return r.status(409).json({error:'This job has an active retry (#'+active.id+'); stop or finish that retry before deleting this failure.'});db.prepare("delete from downloads where id=? and status='failed' and recovered_by is null").run(id);appLog('WARN','DOWNLOAD','Deleted unresolved failed download job #'+id);r.json({id,deleted:true})});
app.post('/api/downloads/retry-failed',(q,r)=>{
 const raw=Array.isArray(q.body?.ids)?q.body.ids:[],ids=[...new Set(raw.map(Number).filter((id:number)=>Number.isSafeInteger(id)&&id>0))];
 if(!ids.length)return r.status(400).json({error:'Select at least one failed job to retry'});
 if(ids.length>250)return r.status(400).json({error:'Retry at most 250 jobs at a time'});
 const candidates=ids.map(id=>db.prepare('select * from downloads where id=?').get(id) as any).filter(job=>job&&job.status==='failed'&&!job.recovered_by);
 if(!candidates.length)return r.status(409).json({error:'No selected jobs remain eligible for retry'});
 const created=db.transaction(()=>candidates.map(previous=>{
  const id=Number(db.prepare("insert into downloads(symbol,start_date,end_date,status,progress,retry_of,downloader) values(?,?,?,'queued',0,?,'python')").run(previous.symbol,previous.start_date,previous.end_date,Number(previous.id)).lastInsertRowid);
  return{id,retryOf:Number(previous.id),symbol:String(previous.symbol),start:String(previous.start_date),end:String(previous.end_date),downloader:'python'};
 }))();
 let waitFor:number|undefined;
 for(const job of created){scheduleDownload(job.id,job.symbol.toLowerCase(),job.start,job.end,waitFor);waitFor=job.id}
 appLog('INFO','DOWNLOAD','Bulk retry queued '+created.length+' failed Python downloader job(s): '+created.map(job=>'#'+job.retryOf+' → #'+job.id).join(', '));
 r.status(202).json({jobs:created.map(({id,retryOf,symbol,start,end,downloader})=>({id,retryOf,symbol,start_date:start,end_date:end,status:'queued',downloader})),skipped:ids.length-candidates.length});
});
app.post('/api/downloads/:id/stop',(q,r)=>{const id=Number(q.params.id),job=db.prepare('select id,status from downloads where id=?').get(id) as any;if(!job)return r.status(404).json({error:'Download job not found'});if(!['queued','running'].includes(String(job.status)))return r.status(409).json({error:'Only queued or running jobs can be stopped'});cancelledDownloads.add(id);pythonDownloadProcesses.get(id)?.kill('SIGTERM');db.prepare("update downloads set status='cancelled',error='Stopped manually by user.' where id=?").run(id);appLog('WARN','DOWNLOAD','Stop requested for job #'+id+'; the Python subprocess is being terminated and no further dates will start');r.status(202).json({id,status:'cancelled',inFlight:downloadTasks.has(id)})});
app.post('/api/downloads/:id/retry',(q,r)=>{
 const previous=db.prepare('select * from downloads where id=?').get(Number(q.params.id)) as any;
 if(!previous)return r.status(404).json({error:'Download job not found'});
 if(previous.status==='failed'&&previous.recovered_by)return r.status(409).json({error:'This failed job was already recovered by job #'+previous.recovered_by});
 const canRetry=['failed','queued','running'].includes(String(previous.status));
 if(!canRetry)return r.status(409).json({error:'Only failed, queued, or running jobs can be retried/restarted'});
 const restarting=['queued','running'].includes(String(previous.status));
 const id=Number(db.prepare("insert into downloads(symbol,start_date,end_date,status,progress,retry_of,downloader) values(?,?,?,'queued',0,?,'python')").run(previous.symbol,previous.start_date,previous.end_date,Number(previous.id)).lastInsertRowid);
 if(restarting){cancelledDownloads.add(Number(previous.id));pythonDownloadProcesses.get(Number(previous.id))?.kill('SIGTERM');db.prepare("update downloads set status='restarted',error=? where id=?").run('Restart requested; the current API request will be discarded when it returns. Replacement job #'+id+' will then start this date range from the beginning.',Number(previous.id))}
 appLog(restarting?'WARN':'INFO','DOWNLOAD',(restarting?'Restart':'Retry')+' requested for Python downloader job #'+previous.id+'; created job #'+id+' for '+previous.symbol+' '+previous.start_date+' to '+previous.end_date+(restarting?'; replacement waits for the old worker to stop':''));
 scheduleDownload(id,String(previous.symbol).toLowerCase(),String(previous.start_date),String(previous.end_date),restarting?Number(previous.id):undefined);
 r.status(202).json({id,status:'queued',retryOf:Number(previous.id),restarted:restarting,waitingFor:restarting?Number(previous.id):undefined,downloader:'python'});
});

function expectedUtcMinuteTimestamps(date:string,symbol:string):number[]{
 const from=Math.floor(new Date(date+'T00:00:00Z').getTime()/1000),until=from+86400,isMetal=symbol.toUpperCase()==='XAUUSD',expected=new Set<number>();
 for(let cursor=shiftCoverageDate(date,-2);cursor<=shiftCoverageDate(date,2);cursor=shiftCoverageDate(cursor,1)){
  const weekday=new Date(cursor+'T00:00:00Z').getUTCDay(),next=shiftCoverageDate(cursor,1),intervals:[number,number][]=[];
  if(weekday===0)intervals.push([newYorkCoverageTime(cursor,isMetal?18:17,0),newYorkCoverageTime(next,0,0)]);
  else if(weekday>=1&&weekday<=4){
   if(isMetal)intervals.push([newYorkCoverageTime(cursor,0,0),newYorkCoverageTime(cursor,17,0)],[newYorkCoverageTime(cursor,18,0),newYorkCoverageTime(next,0,0)]);
   else intervals.push([newYorkCoverageTime(cursor,0,0),newYorkCoverageTime(next,0,0)]);
  }else if(weekday===5)intervals.push([newYorkCoverageTime(cursor,0,0),newYorkCoverageTime(cursor,17,0)]);
  for(const [sessionStart,sessionEnd] of intervals){
   const clippedStart=Math.max(from,sessionStart),clippedEnd=Math.min(until,sessionEnd);
   for(let timestamp=Math.ceil(clippedStart/60)*60;timestamp<clippedEnd;timestamp+=60)expected.add(timestamp);
  }
 }
 return [...expected].sort((a,b)=>a-b);
}

function resolvePythonDownloaderPath():string|null{
 const moduleDirectory=path.dirname(fileURLToPath(import.meta.url));
 const candidates=[path.resolve(process.cwd(),'dukascopy_m1.py'),path.resolve(moduleDirectory,'../../dukascopy_m1.py'),path.resolve(moduleDirectory,'../../../dukascopy_m1.py')];
 return candidates.find(candidate=>fs.existsSync(candidate))||null;
}
async function download(id:number,symbol:string,start:string,end:string){
 db.prepare("update downloads set status='running',progress=0,error=null where id=?").run(id);
 const scriptPath=resolvePythonDownloaderPath();
 if(!scriptPath){
  const message='The checked-in dukascopy_m1.py script was not found. Rebuild/deploy the app with the repository root script included.';
  db.prepare("update downloads set status='failed',error=? where id=?").run(message,id);
  appLog('ERROR','PYTHON-DOWNLOADER','Job #'+id+': '+message);
  return;
 }
 if(cancelledDownloads.has(id)){
  cancelledDownloads.delete(id);
  db.prepare("update downloads set status='cancelled',error='Stopped before the Python worker started.' where id=?").run(id);
  return;
 }
 const appUrl='http://127.0.0.1:'+port;
 appLog('INFO','PYTHON-DOWNLOADER','Job #'+id+': starting the checked-in Python downloader for '+symbol.toUpperCase()+' '+start+' to '+end);
 await new Promise<void>(resolve=>{
  let stdoutBuffer='',stderrBuffer='',stderrTail='',spawnError:Error|null=null,closed=false,coveredDays=0;
  const completedDates=new Set<string>();
  const totalDays=Math.max(1,Math.floor((Date.parse(end+'T00:00:00Z')-Date.parse(start+'T00:00:00Z'))/86400000)+1);
  const updateProgress=(value:number)=>{
   const progress=Math.max(0,Math.min(99,Math.floor(value)));
   db.prepare("update downloads set progress=MAX(progress,?) where id=? and status='running'").run(progress,id);
  };
  const handleLine=(stream:'stdout'|'stderr',rawLine:string)=>{
   const line=sanitizeLogMessage(rawLine,1600).trim();
   if(!line)return;
   if(stream==='stderr'){
    stderrTail=(stderrTail+line+'\n').slice(-6000);
    appLog('WARN','PYTHON-DOWNLOADER','Job #'+id+': '+line);
    return;
   }
   appLog('INFO','PYTHON-DOWNLOADER','Job #'+id+': '+line);
   const skipped=line.match(/Skipping\s+(\d+)\s+complete\/closed day\(s\)/i);
   if(skipped)coveredDays=Math.max(coveredDays,Number(skipped[1])||0);
   if(/Nothing to download; every requested date/i.test(line))updateProgress(99);
   const dateRow=line.match(/^[A-Z0-9]+\s+(\d{4}-\d{2}-\d{2})\s+\.\.\.\s*(.*)$/);
   if(dateRow&&/(validated candles|no data \(weekend\/holiday\)|FAILED \(will retry on a later pass\))/i.test(dateRow[2])){
    completedDates.add(dateRow[1]);
    updateProgress((coveredDays+completedDates.size)/totalDays*100);
   }
  };
  const drain=(stream:'stdout'|'stderr',chunk:unknown)=>{
   const text=String(chunk);
   
   let buffer=stream==='stdout'?stdoutBuffer:stderrBuffer;
   buffer+=text;
   const lines=buffer.split(/\r?\n/);
   buffer=lines.pop()||'';
   for(const line of lines)handleLine(stream,line);
   if(stream==='stdout')stdoutBuffer=buffer;else stderrBuffer=buffer;
  };
  let child:ReturnType<typeof spawn>;
  try{
   child=spawn(process.env.PYTHON_EXECUTABLE||'python3',['-u',scriptPath,symbol.toUpperCase(),start,end,'--app',appUrl,'--job-id',String(id)],{
    cwd:path.dirname(scriptPath),
    env:{...process.env,PYTHONUNBUFFERED:'1'},
    stdio:['ignore','pipe','pipe']
   });
  }catch(error){
   spawnError=error instanceof Error?error:new Error(String(error));
   handleLine('stderr','Could not launch Python downloader: '+spawnError.message);
   db.prepare("update downloads set status='failed',error=? where id=?").run(spawnError.message,id);
   resolve();
   return;
  }
  pythonDownloadProcesses.set(id,child);
  child.stdout?.on('data',(chunk)=>drain('stdout',chunk));
  child.stderr?.on('data',(chunk)=>drain('stderr',chunk));
  child.on('error',(error)=>{spawnError=error;handleLine('stderr','Could not launch Python downloader: '+error.message)});
  child.on('close',(code,signal)=>{
   if(closed)return;closed=true;
   if(stdoutBuffer)handleLine('stdout',stdoutBuffer);
   if(stderrBuffer)handleLine('stderr',stderrBuffer);
   pythonDownloadProcesses.delete(id);
   const current=db.prepare('select status from downloads where id=?').get(id) as {status:string}|undefined;
   if(cancelledDownloads.has(id)||current?.status==='cancelled'||current?.status==='restarted'){
    cancelledDownloads.delete(id);
    appLog('INFO','PYTHON-DOWNLOADER','Job #'+id+': Python worker stopped'+(signal?' by '+signal:'')+'; preserving status '+String(current?.status||'cancelled'));
    resolve();
    return;
   }
   if(code===0){
    db.prepare("update downloads set status='completed',progress=100,error=null where id=?").run(id);
    appLog('INFO','PYTHON-DOWNLOADER','Job #'+id+': Python downloader completed successfully.');
   }else{
    const detail=(stderrTail.trim()||(spawnError?spawnError.message:'Python downloader exited with '+String(code)+(signal?' ('+signal+')':''))).slice(-1200);
    db.prepare("update downloads set status='failed',error=? where id=?").run(detail,id);
    appLog('ERROR','PYTHON-DOWNLOADER','Job #'+id+' failed: '+detail);
   }
   resolve();
  });
 });
}
const csvUpload=multer({storage:multer.memoryStorage(),limits:{fileSize:64*1024*1024,files:1}});
app.post('/api/import/candles',(q,r)=>{csvUpload.single('file')(q,r,(uploadError:any)=>{
 if(uploadError){const tooBig=uploadError.code==='LIMIT_FILE_SIZE';return r.status(tooBig?413:400).json({error:tooBig?'CSV file must be 64 MB or smaller':'Upload failed: '+String(uploadError.message||uploadError)})}
 try{
  const symbol=String(q.query.symbol||'').toUpperCase();
  if(!db.prepare('select symbol from instruments where symbol=?').get(symbol))return r.status(400).json({error:'Unknown instrument symbol'});
  let parentDownload:any=null;
  if(q.query.downloadId!==undefined){
   const parentId=Number(q.query.downloadId);
   if(!Number.isSafeInteger(parentId)||parentId<=0)return r.status(400).json({error:'Invalid downloadId'});
   parentDownload=db.prepare('select id,symbol,status,start_date,end_date from downloads where id=?').get(parentId) as any;
   if(!parentDownload)return r.status(404).json({error:'Parent download job not found'});
   if(String(parentDownload.symbol).toUpperCase()!==symbol)return r.status(400).json({error:'Parent download job instrument does not match the CSV'});
   if(parentDownload.status!=='running')return r.status(409).json({error:'Parent download job is not running'});
  }
  if(String(q.query.priceType||'').toLowerCase()!=='bid')return r.status(400).json({error:'This app stores BID candles only. Export Bid prices and pass priceType=bid.'});
  if(!q.file)return r.status(400).json({error:'Attach the CSV as multipart field "file"'});
  const offset=Number(q.query.utcOffsetMinutes??0);
  if(!Number.isFinite(offset)||Math.abs(offset)>840)return r.status(400).json({error:'utcOffsetMinutes must be between -840 and 840'});
  const replaceExisting=['true','1'].includes(String(q.query.replaceExisting??'').toLowerCase());
  const parsed=parseCandleCsv(q.file.buffer.toString('utf8'),{utcOffsetMinutes:offset});
  if(!parsed.candles.length)return r.status(422).json({error:'No valid M1 candles found in the file',totalRows:parsed.totalRows,rejected:parsed.rejected,rejectSamples:parsed.rejectSamples});
  // The opt-in replacement mode is used by the Dukascopy downloader to repair
  // previously imported bad rows. Refuse the whole file before writing if any
  // row fails validation; default CSV imports still preserve existing candles.
  if(replaceExisting&&parsed.rejected>0)return r.status(422).json({error:'Replacement import refused because some rows failed validation',totalRows:parsed.totalRows,accepted:parsed.candles.length,rejected:parsed.rejected,rejectSamples:parsed.rejectSamples});
  const put=db.prepare('insert or ignore into candles(symbol,time,open,high,low,close,volume) values(?,?,?,?,?,?,?)');
  const putReplacing=db.prepare('insert into candles(symbol,time,open,high,low,close,volume) values(?,?,?,?,?,?,?) on conflict(symbol,time,price_type) do update set open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume');
  const exists=db.prepare("select 1 from candles where symbol=? and time=? and price_type='bid'");
  const writeCounts=db.transaction(()=>{let inserted=0,updated=0;for(const c of parsed.candles){if(replaceExisting){const alreadyExists=Boolean(exists.get(symbol,c.time));putReplacing.run(symbol,c.time,c.open,c.high,c.low,c.close,c.volume);if(alreadyExists)updated++;else inserted++}else inserted+=put.run(symbol,c.time,c.open,c.high,c.low,c.close,c.volume).changes}return{inserted,updated}})();
  const {inserted,updated}=writeCounts;
  const duplicatesIgnored=parsed.candles.length-inserted-updated;
  const day=(t:number)=>new Date(t*1000).toISOString().slice(0,10);
  if(inserted+updated>0&&!parentDownload)db.prepare("insert into downloads(symbol,start_date,end_date,status,progress,downloader) values(?,?,?,'completed',100,'csv')").run(symbol,day(parsed.firstTime!),day(parsed.lastTime!));
  if(parentDownload&&inserted+updated>0){
   const totalDays=Math.max(1,Math.floor((Date.parse(String(parentDownload.end_date)+'T00:00:00Z')-Date.parse(String(parentDownload.start_date)+'T00:00:00Z'))/86400000)+1);
   const importedThrough=Math.max(1,Math.floor((Date.parse(day(parsed.lastTime!)+'T00:00:00Z')-Date.parse(String(parentDownload.start_date)+'T00:00:00Z'))/86400000)+1);
   db.prepare("update downloads set progress=MAX(progress,?) where id=? and status='running'").run(Math.min(99,Math.floor(importedThrough/totalDays*100)),Number(parentDownload.id));
  }
  appLog('INFO','IMPORT','Imported '+symbol+' CSV: '+parsed.candles.length+' valid candle(s), '+inserted+' new, '+updated+' replaced, '+duplicatesIgnored+' already present, '+parsed.rejected+' rejected row(s)');
  r.status(201).json({symbol,totalRows:parsed.totalRows,accepted:parsed.candles.length,rejected:parsed.rejected,rejectSamples:parsed.rejectSamples,inserted,updated,duplicatesIgnored,firstTime:parsed.firstTime,lastTime:parsed.lastTime})
 }catch(e){r.status(400).json({error:String((e as Error).message||e)})}
})});
app.get('/api/export/trades.csv',(_q,r)=>{const rows=db.prepare('select * from trades order by entry_time').all() as any[],cols=rows.length?Object.keys(rows[0]):['id','symbol','side','entry_time','entry','exit_time','exit','lots','pnl','status','notes'];r.type('text/csv').attachment('atlas-trades.csv').send([cols.join(','),...rows.map(x=>cols.map(k=>JSON.stringify(x[k]??'')).join(','))].join('\n'))});const front=path.resolve(process.cwd(),'frontend/dist');if(fs.existsSync(front)){app.use(express.static(front));app.get('*',(q,r,next)=>q.path.startsWith('/api/')?next():r.sendFile(path.join(front,'index.html')))}const interruptedDownloads=db.prepare("select id,symbol,start_date,end_date,status,downloader from downloads where status in ('queued','running') order by id").all() as any[];
let recoveryWaitFor:number|undefined;
for(const job of interruptedDownloads){
 const id=Number(job.id);
 appLog('WARN','DOWNLOAD','Recovering persisted '+String(job.status)+' job #'+id+' after backend restart; replaying its date range from the beginning (existing candles are deduplicated).');
 scheduleDownload(id,String(job.symbol).toLowerCase(),String(job.start_date),String(job.end_date),recoveryWaitFor);
 recoveryWaitFor=id;
}
app.listen(port,'0.0.0.0',()=>console.log('MH Forex Replay listening on '+port));
