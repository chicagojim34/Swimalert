import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDueAlerts } from '../src/alerts.js';
import type { Follow, Swimmer } from '../src/types.js';
import { sampleMeet, swimmer } from './helpers.js';

function follow(swimmerId: string, racesBefore: number): Follow {
  return { id: `f-${swimmerId}-${racesBefore}`, swimmerId, deviceToken: `tok-${swimmerId}`, racesBefore, alertedKeys: [] };
}

function setup() {
  const s = { emma: swimmer('Emma'), liam: swimmer('Liam'), ava: swimmer('Ava') };
  const swimmers = new Map<string, Swimmer>(Object.values(s).map((x) => [x.id, x]));
  return { s, swimmers, meet: sampleMeet(s) };
}

test('no alerts before the meet starts', () => {
  const { s, swimmers, meet } = setup();
  assert.equal(meet.currentHeatIndex, -1);
  assert.deepEqual(computeDueAlerts(meet, [follow(s.emma.id, 3)], swimmers), []);
});

test('alert fires when swimmer comes within the threshold, with lane and heat info', () => {
  const { s, swimmers, meet } = setup();
  meet.currentHeatIndex = 0; // Emma (E1H2) is 1 away, Emma (E2H3) is 4 away
  const f = follow(s.emma.id, 3);
  const due = computeDueAlerts(meet, [f], swimmers);
  assert.equal(due.length, 1);
  assert.equal(due[0].eventNumber, 1);
  assert.equal(due[0].heatNumber, 2);
  assert.equal(due[0].lane, 3);
  assert.equal(due[0].racesAway, 1);
  assert.match(due[0].title, /Emma is up next race/);
  assert.match(due[0].body, /Event 1 50 Free — Heat 2, Lane 3/);
});

test('the same entry never alerts twice for one follow', () => {
  const { s, swimmers, meet } = setup();
  meet.currentHeatIndex = 0;
  const f = follow(s.emma.id, 3);
  assert.equal(computeDueAlerts(meet, [f], swimmers).length, 1);
  assert.equal(computeDueAlerts(meet, [f], swimmers).length, 0);
  // Advancing re-fires nothing for the already-alerted entry…
  meet.currentHeatIndex = 1;
  const again = computeDueAlerts(meet, [f], swimmers);
  // …E1H2 was already alerted; E2H3 is now 3 away, which is within threshold.
  assert.equal(again.length, 1);
  assert.equal(again[0].eventNumber, 2);
  assert.equal(again[0].heatNumber, 3);
  assert.equal(again[0].racesAway, 3);
});

test('threshold zero means alert only when the swimmer is up NOW', () => {
  const { s, swimmers, meet } = setup();
  meet.currentHeatIndex = 0;
  const f = follow(s.emma.id, 0);
  assert.equal(computeDueAlerts(meet, [f], swimmers).length, 0);
  meet.currentHeatIndex = 1; // Emma's heat is current
  const due = computeDueAlerts(meet, [f], swimmers);
  assert.equal(due.length, 1);
  assert.match(due[0].title, /Emma is UP NOW/);
});

test('a follow created mid-meet catches up immediately if already within range', () => {
  const { s, swimmers, meet } = setup();
  meet.currentHeatIndex = 2; // E2H1: Ava is up now
  const due = computeDueAlerts(meet, [follow(s.ava.id, 2)], swimmers);
  assert.equal(due.length, 1);
  assert.equal(due[0].racesAway, 0);
});

test('multiple parents following the same swimmer each get their own alert', () => {
  const { s, swimmers, meet } = setup();
  meet.currentHeatIndex = 0;
  const mom = follow(s.emma.id, 3);
  const dad = { ...follow(s.emma.id, 1), id: 'f-dad', deviceToken: 'tok-dad' };
  const due = computeDueAlerts(meet, [mom, dad], swimmers);
  assert.equal(due.length, 2);
  assert.deepEqual(new Set(due.map((d) => d.deviceToken)), new Set(['tok-' + s.emma.id, 'tok-dad']));
});
