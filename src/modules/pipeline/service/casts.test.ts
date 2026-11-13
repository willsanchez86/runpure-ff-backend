/** Tests for the timestamp cast (ETL spec §7.2.2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toUtcDateTime } from './casts.js';

test('toUtcDateTime normalizes ISO-8601 UTC to the MySQL DATETIME form', () => {
  assert.equal(toUtcDateTime('2026-11-12T15:57:12Z'), '2026-11-12 15:57:12');
  assert.equal(toUtcDateTime('2025-09-05T00:23:01.813Z'), '2025-09-05 00:23:01.813');
});

test('toUtcDateTime accepts an already-spaced value', () => {
  assert.equal(toUtcDateTime('2026-11-12 15:57:12'), '2026-11-12 15:57:12');
});

test('toUtcDateTime passes a non-timestamp through unchanged (DB rejects it)', () => {
  assert.equal(toUtcDateTime('not-a-date'), 'not-a-date');
});
