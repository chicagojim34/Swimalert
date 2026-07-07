import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clipWindow,
  DEFAULT_POST_ROLL_MS,
  DEFAULT_PRE_ROLL_MS,
  formatSwimTime,
  MAX_RACE_MS,
  recordHorn,
  recordTouch,
  unofficialMs,
} from '../src/timing.js';
import type { Heat } from '../src/types.js';

function emptyHeat(): Heat {
  return { number: 1, entries: [], touches: {} };
}

test('horn-to-touch produces an unofficial time per lane', () => {
  const heat = emptyHeat();
  recordHorn(heat, 1_000_000);
  const lane4 = recordTouch(heat, 4, 1_027_450);
  const lane5 = recordTouch(heat, 5, 1_028_010);
  assert.equal(lane4, 27_450);
  assert.equal(lane5, 28_010);
  assert.equal(unofficialMs(heat, 6), undefined); // no touch in lane 6
});

test('touch without a horn yields no time; negative elapsed rejected', () => {
  const heat = emptyHeat();
  assert.equal(recordTouch(heat, 3, 5000), undefined);
  recordHorn(heat, 10_000);
  assert.equal(unofficialMs(heat, 3), undefined); // touch predates horn
});

test('formatSwimTime renders swim-style times', () => {
  assert.equal(formatSwimTime(27_450), '27.45');
  assert.equal(formatSwimTime(64_300), '1:04.30');
  assert.equal(formatSwimTime(1_051_020), '17:31.02');
  assert.equal(formatSwimTime(59_996), '1:00.00'); // rounds up across the minute
});

test('clipWindow spans pre-roll before horn to post-roll after touch', () => {
  const heat = emptyHeat();
  recordHorn(heat, 1_000_000);
  recordTouch(heat, 4, 1_030_000);
  const w = clipWindow(heat, 4);
  assert.deepEqual(w, {
    startTs: 1_000_000 - DEFAULT_PRE_ROLL_MS,
    endTs: 1_030_000 + DEFAULT_POST_ROLL_MS,
    provisionalEnd: false,
  });
});

test('clipWindow without a touch is provisional and capped at max race length', () => {
  const heat = emptyHeat();
  recordHorn(heat, 1_000_000);
  const w = clipWindow(heat, 2);
  assert.ok(w);
  assert.equal(w.provisionalEnd, true);
  assert.equal(w.endTs, 1_000_000 + MAX_RACE_MS);
});

test('clipWindow without a horn is undefined', () => {
  assert.equal(clipWindow(emptyHeat(), 1), undefined);
});
