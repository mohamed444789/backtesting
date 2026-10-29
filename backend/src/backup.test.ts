import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackupArchive, restoreBackupArchive } from './backup.js';

function createTestDatabase(filePath: string) {
  const db = new Database(filePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE instruments(symbol TEXT PRIMARY KEY, provider_symbol TEXT NOT NULL, pip_size REAL NOT NULL, units REAL NOT NULL DEFAULT 100000);
    CREATE TABLE candles(symbol TEXT, time INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL DEFAULT 0, price_type TEXT DEFAULT 'bid', PRIMARY KEY(symbol,time,price_type));
    CREATE TABLE sessions(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE trades(id INTEGER PRIMARY KEY, session_id INTEGER REFERENCES sessions(id), notes TEXT);
    CREATE TABLE orders(id INTEGER PRIMARY KEY, session_id INTEGER REFERENCES sessions(id), status TEXT);
    CREATE TABLE downloads(id INTEGER PRIMARY KEY, status TEXT, error TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE drawings(id INTEGER PRIMARY KEY, session_id INTEGER, kind TEXT, payload TEXT);
    CREATE TABLE journal_notes(id INTEGER PRIMARY KEY, trade_id INTEGER REFERENCES trades(id), body TEXT);
    CREATE TABLE media_files(filename TEXT PRIMARY KEY, mime_type TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  `);
  return db;
}

test('portable backup restores SQLite content, screenshots and browser state', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-backup-test-'));
  const sourceDir = path.join(tempRoot, 'source');
  const targetDir = path.join(tempRoot, 'target');
  fs.mkdirSync(path.join(sourceDir, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'screenshots'), { recursive: true });
  const sourceDb = createTestDatabase(path.join(sourceDir, 'atlas.sqlite'));
  const targetDb = createTestDatabase(path.join(targetDir, 'atlas.sqlite'));
  try {
    sourceDb.prepare('INSERT INTO instruments(symbol,provider_symbol,pip_size) VALUES(?,?,?)').run('EURUSD', 'eurusd', 0.0001);
    sourceDb.prepare('INSERT INTO candles(symbol,time,open,high,low,close) VALUES(?,?,?,?,?,?)').run('EURUSD', 100, 1, 1.1, 0.9, 1.05);
    sourceDb.prepare('INSERT INTO sessions(id,name) VALUES(?,?)').run(7, 'Source session');
    sourceDb.prepare('INSERT INTO drawings(session_id,kind,payload) VALUES(?,?,?)').run(7, 'chart_snapshot', '[{"kind":"rectangle"}]');
    sourceDb.prepare('INSERT INTO trades(id,session_id,notes) VALUES(?,?,?)').run(9, 7, 'Keep this note');
    sourceDb.prepare('INSERT INTO journal_notes(id,trade_id,body) VALUES(?,?,?)').run(4, 9, 'Journal content');
    sourceDb.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('risk', '1');
    sourceDb.prepare('INSERT INTO media_files(filename,mime_type,data) VALUES(?,?,?)').run('inline.png','image/png',Buffer.from('embedded screenshot'));

    fs.writeFileSync(path.join(sourceDir, 'screenshots', 'chart-1.png'), 'source screenshot');
    targetDb.prepare('INSERT INTO instruments(symbol,provider_symbol,pip_size) VALUES(?,?,?)').run('GBPUSD', 'gbpusd', 0.0001);
    targetDb.prepare('INSERT INTO sessions(id,name) VALUES(?,?)').run(1, 'Destination data');
    fs.writeFileSync(path.join(targetDir, 'screenshots', 'old.png'), 'old screenshot');

    const backup = await createBackupArchive(sourceDb, sourceDir, {
      'atlas-drawings-session-7': '[{"kind":"rectangle"}]',
      'not-an-atlas-key': 'must not be included'
    });
    const browserState = await restoreBackupArchive(targetDb, targetDir, backup.archivePath);

    const preRestoreFiles = fs.readdirSync(path.join(targetDir, 'backups')).filter(name => name.startsWith('pre-restore-') && name.endsWith('.sqlite'));
    assert.equal(preRestoreFiles.length, 1, 'restore should preserve a pre-restore snapshot');
    const preRestoreDb = new Database(path.join(targetDir, 'backups', preRestoreFiles[0]), { readonly: true, fileMustExist: true });
    try {
      assert.equal((preRestoreDb.prepare('SELECT symbol FROM instruments').get() as any).symbol, 'GBPUSD');
      assert.equal((preRestoreDb.prepare('SELECT name FROM sessions WHERE id=1').get() as any).name, 'Destination data');
    } finally {
      preRestoreDb.close();
    }

    assert.equal(targetDb.prepare('SELECT symbol FROM instruments').get() && (targetDb.prepare('SELECT symbol FROM instruments').get() as any).symbol, 'EURUSD');
    assert.equal((targetDb.prepare('SELECT name FROM sessions WHERE id=7').get() as any).name, 'Source session');
    assert.equal((targetDb.prepare('SELECT notes FROM trades WHERE id=9').get() as any).notes, 'Keep this note');
    assert.equal((targetDb.prepare('SELECT COUNT(*) AS n FROM candles').get() as any).n, 1);
    assert.equal((targetDb.prepare('SELECT CAST(data AS TEXT) AS data FROM media_files WHERE filename=?').get('inline.png') as any).data, 'embedded screenshot');
    assert.equal((targetDb.prepare('SELECT payload FROM drawings WHERE session_id=7 AND kind=?').get('chart_snapshot') as any).payload, '[{"kind":"rectangle"}]');
    assert.equal((targetDb.prepare('SELECT CAST(data AS TEXT) AS data FROM media_files WHERE filename=?').get('chart-1.png') as any).data, 'source screenshot');
    assert.equal(fs.existsSync(path.join(targetDir, 'screenshots', 'chart-1.png')), false);
    assert.equal(fs.existsSync(path.join(targetDir, 'screenshots', 'old.png')), false);
    assert.deepEqual(browserState, { 'atlas-drawings-session-7': '[{"kind":"rectangle"}]' });
  } finally {
    sourceDb.close();
    targetDb.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
