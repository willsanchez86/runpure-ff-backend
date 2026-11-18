/** Pure-mapping tests for the contract service (02-field-mapping.md). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeCursor,
  encodeCursor,
  kickoffIso,
  mapInjuryStatus,
  mapPhase,
  mapPosition,
} from './nfl.service.js';

test('mapPosition: groups map to contract positions; K lives under SPEC', () => {
  assert.equal(mapPosition('QB', 'QB'), 'QB');
  assert.equal(mapPosition('DB', 'CB'), 'DB');
  assert.equal(mapPosition('SPEC', 'K'), 'K');
  // punters and linemen are out of contract
  assert.equal(mapPosition('SPEC', 'P'), null);
  assert.equal(mapPosition('OL', 'T'), null);
});

test('mapInjuryStatus: reserve list wins; report statuses map to Q/O', () => {
  assert.equal(mapInjuryStatus('Questionable', 'ACT'), 'Q');
  assert.equal(mapInjuryStatus('Out', 'ACT'), 'O');
  assert.equal(mapInjuryStatus('Doubtful', 'ACT'), 'O');
  assert.equal(mapInjuryStatus(null, 'RES'), 'IR');
  assert.equal(mapInjuryStatus('Questionable', 'RES'), 'IR');
  assert.equal(mapInjuryStatus(null, 'ACT'), null);
});

test('mapPhase: REG stays REG; every playoff type is POST', () => {
  assert.equal(mapPhase('REG'), 'REG');
  for (const playoff of ['WC', 'DIV', 'CON', 'SB']) {
    assert.equal(mapPhase(playoff), 'POST');
  }
});

test('kickoffIso: gameday + Eastern time becomes a UTC instant', () => {
  // 13:00 ET (EST) = 18:00 UTC
  assert.equal(kickoffIso('2026-11-15', '13:00'), '2026-11-15T18:00:00.000Z');
  // a missing time falls back to the 1pm window
  assert.equal(kickoffIso('2026-11-15', null), '2026-11-15T18:00:00.000Z');
});

test('cursor round-trips, including player ids containing dashes', () => {
  const cursor = encodeCursor('00-0031234', 9);
  assert.deepEqual(decodeCursor(cursor), { playerId: '00-0031234', week: 9 });
  // null and malformed cursors both safely restart from the beginning
  assert.deepEqual(decodeCursor(null), { playerId: '', week: 0 });
  assert.deepEqual(decodeCursor('garbage'), { playerId: '', week: 0 });
});
