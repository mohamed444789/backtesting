import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { dateInBerlin, findFirstCandleOnDate, isValidDateOnly } from './session-gap.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE candles (
      symbol TEXT NOT NULL,
      time INTEGER NOT NULL,
      open REAL NOT NULL DEFAULT 1,
      high REAL NOT NULL DEFAULT 1,
      low REAL NOT NULL DEFAULT 1,
      close REAL NOT NULL DEFAULT 1,
      volume REAL NOT NULL DEFAULT 0,
      price_type TEXT NOT NULL DEFAULT 'bid',
      PRIMARY KEY(symbol, time, price_type)
    );
    CREATE INDEX candle_range ON candles(symbol, time);
  `);
  const insert = db.prepare('INSERT INTO candles(symbol, time) VALUES(?, ?)');
  return {
    db,
    add: (symbol: string, ...times: number[]) => {
      for (const time of times) insert.run(symbol, time);
    },
  };
}

test('returns the first stored M1 candle for the selected Berlin calendar date', () => {
  const { db, add } = setup();
  try {
    const fridayCursor = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const sundayFirst = Date.UTC(2026, 4, 24, 21, 0) / 1000; // Sunday 23:00 in Berlin
    const mondayFirst = Date.UTC(2026, 4, 25, 0, 0) / 1000; // Monday 02:00 in Berlin
    add('EURUSD', mondayFirst, sundayFirst);

    assert.deepEqual(findFirstCandleOnDate(db, 'EURUSD', '2026-05-24', fridayCursor, null), {
      time: sundayFirst,
      date: '2026-05-24',
    });
  } finally {
    db.close();
  }
});

test('a Saturday with no candles returns null instead of jumping to Sunday', () => {
  const { db, add } = setup();
  try {
    const fridayCursor = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const sundayFirst = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    add('EURUSD', sundayFirst);

    assert.equal(findFirstCandleOnDate(db, 'EURUSD', '2026-05-23', fridayCursor, null), null);
  } finally {
    db.close();
  }
});

test('when selecting the current replay date, chooses the first candle strictly after the cursor', () => {
  const { db, add } = setup();
  try {
    const earlier = Date.UTC(2026, 4, 21, 8, 0) / 1000;
    const cursor = Date.UTC(2026, 4, 21, 8, 2) / 1000;
    const next = Date.UTC(2026, 4, 21, 8, 3) / 1000;
    add('EURUSD', earlier, next);

    assert.deepEqual(findFirstCandleOnDate(db, 'EURUSD', '2026-05-21', cursor, null), {
      time: next,
      date: '2026-05-21',
    });
  } finally {
    db.close();
  }
});

test('does not select a candle beyond the replay end time', () => {
  const { db, add } = setup();
  try {
    const cursor = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const candle = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    add('EURUSD', candle);

    assert.equal(findFirstCandleOnDate(db, 'EURUSD', '2026-05-24', cursor, candle - 1), null);
  } finally {
    db.close();
  }
});

test('does not use a different instrument or an ask-only candle', () => {
  const { db, add } = setup();
  try {
    const cursor = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const candle = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    add('GBPUSD', candle);
    db.prepare("INSERT INTO candles(symbol,time,price_type) VALUES(?,?,'ask')").run('EURUSD', candle);

    assert.equal(findFirstCandleOnDate(db, 'EURUSD', '2026-05-24', cursor, null), null);
  } finally {
    db.close();
  }
});

test('uses Berlin date boundaries across the spring daylight-saving transition', () => {
  const { db, add } = setup();
  try {
    const cursor = Date.UTC(2026, 2, 28, 21, 0) / 1000; // Saturday 22:00 in Berlin
    const sundayFirst = Date.UTC(2026, 2, 29, 22, 0) / 1000; // Sunday 00:00 on Monday? verify local date below
    add('EURUSD', sundayFirst);

    assert.equal(dateInBerlin(cursor), '2026-03-28');
    assert.equal(dateInBerlin(sundayFirst), '2026-03-30');
    assert.equal(findFirstCandleOnDate(db, 'EURUSD', '2026-03-29', cursor, null), null);
  } finally {
    db.close();
  }
});

test('validates dates strictly', () => {
  assert.equal(isValidDateOnly('2026-10-22'), true);
  assert.equal(isValidDateOnly('2026-02-30'), false);
  assert.equal(isValidDateOnly('22.10.2026'), false);
  assert.equal(isValidDateOnly(''), false);
});
