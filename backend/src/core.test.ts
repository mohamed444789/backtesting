import test from 'node:test';import assert from 'node:assert/strict';import{aggregate,exitHit,pnl,sizeForRisk,valid}from'./core.js';
test('candle validation',()=>{assert.ok(valid({time:60,open:1,high:2,low:.5,close:1.5,volume:1}));assert.ok(!valid({time:60,open:1,high:.8,low:.5,close:1.5,volume:1}))});
test('M5 aggregation',()=>{const x=aggregate([{time:60,open:1,high:2,low:.5,close:1.5,volume:1},{time:120,open:1.5,high:3,low:1,close:2,volume:2}],5);assert.equal(x.length,1);assert.equal(x[0].high,3);assert.equal(x[0].volume,3)});
test('conservative ambiguous exit',()=>assert.equal(exitHit({time:1,open:100,high:112,low:88,close:105,volume:0},90,110),'stop'));
test('long/short PnL and risk sizing',()=>{assert.ok(Math.abs(pnl('buy',1,1.01,1)-1000)<1e-6);assert.ok(Math.abs(pnl('sell',1,1.01,1)+1000)<1e-6);assert.ok(Math.abs(sizeForRisk(10000,1,1.1,1.09)-.1)<1e-8)});
