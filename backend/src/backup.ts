import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

type SqliteDatabase = InstanceType<typeof Database>;

const REQUIRED_TABLES = ['instruments', 'candles', 'sessions', 'trades', 'orders', 'downloads', 'settings', 'drawings', 'journal_notes'];

function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(stdout)
      : reject(new Error(stderr.trim() || command + ' exited with code ' + code)));
  });
}

function quoteIdentifier(value: string): string {
  return '"' + value.replace(/"/g, '""') + '"';
}

function parseBrowserState(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.startsWith('atlas-') || typeof entry !== 'string') continue;
    result[key] = entry;
  }
  return result;
}

export async function createBackupArchive(
  db: SqliteDatabase,
  dataDir: string,
  browserState: unknown
): Promise<{ archivePath: string; workDir: string }> {
  const root = path.resolve(dataDir);
  fs.mkdirSync(root, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(root, '.atlas-backup-create-'));
  try {
    const snapshotPath = path.join(workDir, 'atlas.sqlite');
    await db.backup(snapshotPath);
    const screenshotsPath = path.join(workDir, 'screenshots');
    fs.mkdirSync(screenshotsPath, { recursive: true });
    const liveScreenshotsPath = path.join(root, 'screenshots');
    if (fs.existsSync(liveScreenshotsPath)) {
      fs.cpSync(liveScreenshotsPath, screenshotsPath, { recursive: true, force: true });
    }
    fs.writeFileSync(path.join(workDir, 'browser-state.json'), JSON.stringify(parseBrowserState(browserState)), 'utf8');
    fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify({
      format: 'atlas-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      contents: ['atlas.sqlite', 'screenshots/', 'browser-state.json']
    }, null, 2), 'utf8');
    const archivePath = path.join(workDir, 'atlas-backup.tar.gz');
    await runProcess('tar', ['-czf', archivePath, '-C', workDir, 'atlas.sqlite', 'screenshots', 'browser-state.json', 'manifest.json']);
    return { archivePath, workDir };
  } catch (error) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreBackupArchive(
  db: SqliteDatabase,
  dataDir: string,
  archivePath: string
): Promise<Record<string, string>> {
  const root = path.resolve(dataDir);
  const workDir = fs.mkdtempSync(path.join(root, '.atlas-backup-restore-'));
  const extractedDir = path.join(workDir, 'extracted');
  fs.mkdirSync(extractedDir, { recursive: true });
  let oldScreenshotsMoved = false;
  let newScreenshotsMoved = false;
  const liveScreenshotsPath = path.join(root, 'screenshots');
  const previousScreenshotsPath = path.join(workDir, 'previous-screenshots');
  let browserState: Record<string, string> = {};
  try {
    const namesOutput = await runProcess('tar', ['-tzf', archivePath]);
    const verboseOutput = await runProcess('tar', ['-tvzf', archivePath]);
    const names = namesOutput.split(/\r?\n/).filter(Boolean);
    const verboseLines = verboseOutput.split(/\r?\n/).filter(Boolean);
    if (!names.length || names.length !== verboseLines.length) throw new Error('Backup archive listing is invalid.');
    const normalizedNames = new Set<string>();
    for (let i = 0; i < names.length; i++) {
      const name = names[i].replace(/^\.\//, '').replace(/\/$/, '');
      const type = verboseLines[i][0];
      if (type !== '-' && type !== 'd') throw new Error('Backup contains an unsupported link or special file.');
      if (!name || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '')) throw new Error('Backup contains an unsafe file path.');
      const allowed = name === 'atlas.sqlite' || name === 'manifest.json' || name === 'browser-state.json' || name === 'screenshots' || /^screenshots\/[^/]+$/.test(name);
      if (!allowed) throw new Error('Backup contains an unexpected path: ' + name);
      if (normalizedNames.has(name)) throw new Error('Backup contains duplicate paths.');
      normalizedNames.add(name);
    }
    for (const required of ['atlas.sqlite', 'manifest.json', 'browser-state.json', 'screenshots']) {
      if (!normalizedNames.has(required)) throw new Error('Backup is missing required content: ' + required);
    }
    await runProcess('tar', ['-xzf', archivePath, '-C', extractedDir]);

    const manifest = JSON.parse(fs.readFileSync(path.join(extractedDir, 'manifest.json'), 'utf8'));
    if (manifest?.format !== 'atlas-backup' || manifest?.version !== 1) throw new Error('Unsupported backup format or version.');
    browserState = parseBrowserState(JSON.parse(fs.readFileSync(path.join(extractedDir, 'browser-state.json'), 'utf8')));
    const snapshotPath = path.join(extractedDir, 'atlas.sqlite');
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      const integrity = snapshot.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new Error('Backup database failed its integrity check.');
      const sourceTables = new Set((snapshot.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name));
      for (const required of REQUIRED_TABLES) {
        if (!sourceTables.has(required)) throw new Error('Backup database is missing required table: ' + required);
      }
    } finally {
      snapshot.close();
    }

    const sourceDb = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    const sourceTables = new Set((sourceDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(row => row.name));
    const targetTables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
    if (fs.existsSync(liveScreenshotsPath)) {
      fs.renameSync(liveScreenshotsPath, previousScreenshotsPath);
      oldScreenshotsMoved = true;
    }
    try {
      fs.renameSync(path.join(extractedDir, 'screenshots'), liveScreenshotsPath);
      newScreenshotsMoved = true;
    } catch (error) {
      if (oldScreenshotsMoved) {
        fs.renameSync(previousScreenshotsPath, liveScreenshotsPath);
        oldScreenshotsMoved = false;
      }
      throw error;
    }
    try {
      for (const name of targetTables) {
        if (!sourceTables.has(name)) throw new Error('This backup does not contain the current table: ' + name + '. Use a backup from a compatible Atlas version.');
      }
      db.pragma('foreign_keys = OFF');
      db.prepare('ATTACH DATABASE ? AS restore_source').run(snapshotPath);
      try {
        const restoreTransaction = db.transaction(() => {
          for (const table of [...targetTables].reverse()) db.exec('DELETE FROM main.' + quoteIdentifier(table));
          for (const table of targetTables) {
            const sourceColumns = new Set((sourceDb.prepare('PRAGMA table_info(' + quoteIdentifier(table) + ')').all() as { name: string }[]).map(column => column.name));
            const targetColumns = (db.prepare('PRAGMA main.table_info(' + quoteIdentifier(table) + ')').all() as { name: string }[]).map(column => column.name);
            const commonColumns = targetColumns.filter(column => sourceColumns.has(column));
            if (!commonColumns.length) throw new Error('No compatible columns found for table: ' + table);
            const columns = commonColumns.map(quoteIdentifier).join(',');
            db.exec('INSERT INTO main.' + quoteIdentifier(table) + '(' + columns + ') SELECT ' + columns + ' FROM restore_source.' + quoteIdentifier(table));
          }
          db.prepare("UPDATE downloads SET status='failed', error='Restored from backup; retry this job if needed.' WHERE status IN ('queued','running')").run();
          const violations = db.pragma('foreign_key_check') as any[];
          if (violations.length) throw new Error('Backup contains broken references and was not restored.');
        });
        restoreTransaction();
      } finally {
        db.exec('DETACH DATABASE restore_source');
        db.pragma('foreign_keys = ON');
      }
    } finally {
      sourceDb.close();
    }

    if (oldScreenshotsMoved) fs.rmSync(previousScreenshotsPath, { recursive: true, force: true });
    return browserState;
  } catch (error) {
    if (newScreenshotsMoved) fs.rmSync(liveScreenshotsPath, { recursive: true, force: true });
    if (oldScreenshotsMoved && fs.existsSync(previousScreenshotsPath) && !fs.existsSync(liveScreenshotsPath)) fs.renameSync(previousScreenshotsPath, liveScreenshotsPath);
    throw error;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
