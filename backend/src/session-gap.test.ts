import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { findNextSessionGap, MIN_SESSION_GAP_SECONDS } from './session-gap.js';

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

test('detects a weekend gap between the cursor and the very first future candle', () => {
  const { db, add } = setup();
  try {
    const friday = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const monday = Date.UTC(2026, 4, 25, 0, 0) / 1000;
    add('EURUSD', monday);

    assert.deepEqual(findNextSessionGap(db, 'EURUSD', friday, null), {
      time: monday,
      gapSeconds: monday - friday,
    });
  } finally {
    db.close();
  }
});

test('finds the first weekend gap after normal candles, not a later weekend', () => {
  const { db, add } = setup();
  try {
    const wednesday = Date.UTC(2026, 4, 20, 12, 0) / 1000;
    const normalSessionTimes = [
      Date.UTC(2026, 4, 20, 21, 0) / 1000,
      Date.UTC(2026, 4, 21, 6, 0) / 1000,
      Date.UTC(2026, 4, 21, 15, 0) / 1000,
      Date.UTC(2026, 4, 22, 0, 0) / 1000,
      Date.UTC(2026, 4, 22, 9, 0) / 1000,
      Date.UTC(2026, 4, 22, 18, 0) / 1000,
    ];
    const friday = normalSessionTimes[normalSessionTimes.length - 1];
    const monday = Date.UTC(2026, 4, 25, 0, 0) / 1000;
    add('EURUSD', ...normalSessionTimes, monday);

    assert.deepEqual(findNextSessionGap(db, 'EURUSD', wednesday, null), {
      time: monday,
      gapSeconds: monday - friday,
    });
  } finally {
    db.close();
  }
});

test('does not search beyond a session end date', () => {
  const { db, add } = setup();
  try {
    const friday = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const monday = Date.UTC(2026, 4, 25, 0, 0) / 1000;
    add('EURUSD', monday);

    assert.equal(findNextSessionGap(db, 'EURUSD', friday, monday - 1), null);
  } finally {
    db.close();
  }
});

test('does not treat gaps below the configured threshold as a session break', () => {
  const { db, add } = setup();
  try {
    const cursor = Date.UTC(2026, 4, 20, 12, 0) / 1000;
    const next = cursor + MIN_SESSION_GAP_SECONDS - 1;
    add('EURUSD', next);

    assert.equal(findNextSessionGap(db, 'EURUSD', cursor, null), null);
  } finally {
    db.close();
  }
});

test('does not mix instruments when locating a session gap', () => {
  const { db, add } = setup();
  try {
    const cursor = Date.UTC(2026, 4, 22, 20, 59) / 1000;
    const monday = Date.UTC(2026, 4, 25, 0, 0) / 1000;
    add('GBPUSD', monday);

    assert.equal(findNextSessionGap(db, 'EURUSD', cursor, null), null);
  } finally {
    db.close();
  }
});
