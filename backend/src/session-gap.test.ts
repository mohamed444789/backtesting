import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { findNextSundayCandle } from './session-gap.js';

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE candles (
      symbol TEXT NOT NULL,
      time INTEGER NOT NULL,
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

test('from Friday, chooses the first available candle on the upcoming Sunday', () => {
  const { db, add } = setup();
  try {
    const friday = Date.UTC(2026, 4, 22, 20, 59) / 1000; // 22:59 in Berlin
    const sundayOpen = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    const monday = Date.UTC(2026, 4, 25, 0, 0) / 1000;
    add('EURUSD', monday, sundayOpen);

    assert.deepEqual(findNextSundayCandle(db, 'EURUSD', friday, null), {
      time: sundayOpen,
      targetSunday: '2026-05-24',
    });
  } finally {
    db.close();
  }
});

test('from a Sunday candle, targets the Sunday of the following week', () => {
  const { db, add } = setup();
  try {
    const currentSunday = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    const nextSunday = Date.UTC(2026, 4, 31, 21, 0) / 1000;
    add('EURUSD', currentSunday, nextSunday);

    assert.deepEqual(findNextSundayCandle(db, 'EURUSD', currentSunday, null), {
      time: nextSunday,
      targetSunday: '2026-05-31',
    });
  } finally {
    db.close();
  }
});

test('does not select a candle before Sunday even if Saturday data exists', () => {
  const { db, add } = setup();
  try {
    const friday = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const saturday = Date.UTC(2026, 4, 23, 12, 0) / 1000;
    const sunday = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    add('EURUSD', saturday, sunday);

    assert.equal(findNextSundayCandle(db, 'EURUSD', friday, null)?.time, sunday);
  } finally {
    db.close();
  }
});

test('does not select a candle beyond the replay end time', () => {
  const { db, add } = setup();
  try {
    const friday = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const sunday = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    add('EURUSD', sunday);

    assert.equal(findNextSundayCandle(db, 'EURUSD', friday, sunday - 1), null);
  } finally {
    db.close();
  }
});

test('does not use another instrument to find the next Sunday candle', () => {
  const { db, add } = setup();
  try {
    const friday = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const sunday = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    add('GBPUSD', sunday);

    assert.equal(findNextSundayCandle(db, 'EURUSD', friday, null), null);
  } finally {
    db.close();
  }
});

test('uses the chart displayed date in Europe/Berlin when the UTC date has rolled over', () => {
  const { db, add } = setup();
  try {
    // 22:30 UTC is already Saturday 00:30 in Berlin during summer time.
    const cursor = Date.UTC(2026, 4, 22, 22, 30) / 1000;
    const sunday = Date.UTC(2026, 4, 24, 21, 0) / 1000;
    add('EURUSD', sunday);

    assert.deepEqual(findNextSundayCandle(db, 'EURUSD', cursor, null), {
      time: sunday,
      targetSunday: '2026-05-24',
    });
  } finally {
    db.close();
  }
});
