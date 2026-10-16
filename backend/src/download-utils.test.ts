import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDateRange } from './download-utils.js';

test('keeps a normal Monday-Friday work week in one chunk', () => {
  assert.deepEqual(splitDateRange('2026-10-12', '2026-10-16'), [
    { start: '2026-10-12', end: '2026-10-16' }
  ]);
});

test('skips Saturday but preserves the Sunday FX session', () => {
  assert.deepEqual(splitDateRange('2026-10-16', '2026-10-20'), [
    { start: '2026-10-16', end: '2026-10-16' },
    { start: '2026-10-18', end: '2026-10-20' }
  ]);
});

test('does not create a chunk for a Saturday-only range', () => {
  assert.deepEqual(splitDateRange('2026-10-17', '2026-10-17'), []);
});

test('limits chunks to six consecutive trading dates without Saturdays', () => {
  const chunks = splitDateRange('2026-10-12', '2026-10-30');
  assert.deepEqual(chunks, [
    { start: '2026-10-12', end: '2026-10-16' },
    { start: '2026-10-18', end: '2026-10-23' },
    { start: '2026-10-25', end: '2026-10-30' }
  ]);
  for (const chunk of chunks) {
    const first = new Date(chunk.start + 'T00:00:00Z').getTime();
    const last = new Date(chunk.end + 'T00:00:00Z').getTime();
    assert.ok((last - first) / 86400000 < 6);
  }
});
