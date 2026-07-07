import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advance, currentHeat, flatHeats, setPosition, upcomingSwims, validateProgram } from '../src/meets.js';
import { sampleMeet, swimmer } from './helpers.js';

const swimmers = { emma: swimmer('Emma'), liam: swimmer('Liam'), ava: swimmer('Ava') };

test('flatHeats orders by event number then heat number', () => {
  const meet = sampleMeet(swimmers);
  const flat = flatHeats(meet);
  assert.equal(flat.length, 5);
  assert.deepEqual(
    flat.map((f) => `E${f.eventNumber}H${f.heatNumber}`),
    ['E1H1', 'E1H2', 'E2H1', 'E2H2', 'E2H3'],
  );
  assert.deepEqual(flat.map((f) => f.index), [0, 1, 2, 3, 4]);
});

test('advance walks the program and ends cleanly', () => {
  const meet = sampleMeet(swimmers);
  assert.equal(currentHeat(meet), null);
  const first = advance(meet);
  assert.equal(first?.eventNumber, 1);
  assert.equal(first?.heatNumber, 1);
  for (let i = 0; i < 5; i++) advance(meet);
  assert.equal(currentHeat(meet), null); // past the end
  advance(meet); // advancing past the end doesn't blow up or run away
  assert.equal(meet.currentHeatIndex, 5);
});

test('setPosition jumps to a specific event/heat and rejects unknown heats', () => {
  const meet = sampleMeet(swimmers);
  const pos = setPosition(meet, 2, 3);
  assert.equal(pos.index, 4);
  assert.equal(meet.currentHeatIndex, 4);
  assert.throws(() => setPosition(meet, 9, 1), /No heat found/);
});

test('upcomingSwims reports races away from the current position', () => {
  const meet = sampleMeet(swimmers);
  meet.currentHeatIndex = 0; // E1H1 behind the blocks

  const emma = upcomingSwims(meet, swimmers.emma.id);
  assert.deepEqual(
    emma.map((s) => ({ ev: s.flat.eventNumber, heat: s.flat.heatNumber, away: s.racesAway, lane: s.lane })),
    [
      { ev: 1, heat: 2, away: 1, lane: 3 },
      { ev: 2, heat: 3, away: 4, lane: 6 },
    ],
  );

  // Liam is up right now.
  assert.deepEqual(upcomingSwims(meet, swimmers.liam.id)[0]?.racesAway, 0);

  // Past swims disappear.
  meet.currentHeatIndex = 2;
  assert.equal(upcomingSwims(meet, swimmers.liam.id).length, 0);
});

test('upcomingSwims before the meet starts counts from the first heat', () => {
  const meet = sampleMeet(swimmers);
  assert.equal(meet.currentHeatIndex, -1);
  assert.equal(upcomingSwims(meet, swimmers.liam.id)[0]?.racesAway, 0);
});

test('validateProgram rejects out-of-range and duplicate lanes', () => {
  const meet = sampleMeet(swimmers);
  assert.doesNotThrow(() => validateProgram(meet.events, 8));
  assert.throws(() => validateProgram(meet.events, 4), /lane 5 outside/);

  const dup = sampleMeet(swimmers);
  dup.events[0].heats[0].entries.push({ swimmerId: swimmers.ava.id, lane: 4 });
  assert.throws(() => validateProgram(dup.events, 8), /duplicate lane 4/);
});
