import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, parseHeatSheetCsv } from '../src/heatsheet.js';

test('parseCsv handles quotes, embedded commas, CRLF, and blank lines', () => {
  const rows = parseCsv('a,b,c\r\n"x, y",z,"say ""hi"""\n\n1,2,3\n');
  assert.deepEqual(rows, [
    ['a', 'b', 'c'],
    ['x, y', 'z', 'say "hi"'],
    ['1', '2', '3'],
  ]);
});

test('parseHeatSheetCsv builds events/heats/entries from a typical export', () => {
  const csv = [
    'Event,Event Name,Heat,Lane,Swimmer,Team,Seed,Age',
    '1,Girls 50 Free,1,3,Emma R,DOLPHINS,32.10,11',
    '1,Girls 50 Free,1,4,Ava M,SHARKS,31.55,12',
    '1,Girls 50 Free,2,4,Mia K,WAVES,30.02,',
    '2,Boys 50 Free,1,4,Liam T,DOLPHINS,,10',
  ].join('\n');

  const events = parseHeatSheetCsv(csv);
  assert.equal(events.length, 2);
  assert.equal(events[0].name, 'Girls 50 Free');
  assert.equal(events[0].heats.length, 2);
  assert.deepEqual(events[0].heats[0].entries[0], {
    swimmer: { name: 'Emma R', team: 'DOLPHINS', age: 11 },
    lane: 3,
    seedTime: '32.10',
  });
  assert.equal(events[0].heats[1].entries[0].swimmer.age, undefined);
  assert.equal(events[1].name, 'Boys 50 Free');
  assert.equal(events[1].heats[0].entries[0].seedTime, undefined);
});

test('header aliases work case-insensitively', () => {
  const csv = ['EV,HT,LN,ATHLETE NAME,CLUB', '3,1,5,Zoe C,WAVES'].join('\n');
  const events = parseHeatSheetCsv(csv);
  assert.equal(events[0].number, 3);
  assert.equal(events[0].name, 'Event 3'); // no event-name column -> fallback
  assert.equal(events[0].heats[0].entries[0].swimmer.name, 'Zoe C');
  assert.equal(events[0].heats[0].entries[0].swimmer.team, 'WAVES');
});

test('events sort by number regardless of row order', () => {
  const csv = ['event,heat,lane,name', '5,1,1,A', '2,1,1,B', '5,2,1,C'].join('\n');
  const events = parseHeatSheetCsv(csv);
  assert.deepEqual(events.map((e) => e.number), [2, 5]);
  assert.equal(events[1].heats.length, 2);
});

test('helpful errors: missing columns and bad rows carry row numbers', () => {
  assert.throws(() => parseHeatSheetCsv('heat,lane,name\n1,1,A'), /missing a "event" column/);
  assert.throws(
    () => parseHeatSheetCsv('event,heat,lane,name\nX,1,1,A'),
    /Row 2: bad event number "X"/,
  );
  assert.throws(
    () => parseHeatSheetCsv('event,heat,lane,name\n1,1,0,A'),
    /Row 2: bad lane "0"/,
  );
  assert.throws(
    () => parseHeatSheetCsv('event,heat,lane,name\n1,1,1,'),
    /Row 2: missing swimmer name/,
  );
  assert.throws(() => parseHeatSheetCsv('event,heat,lane,name'), /at least one entry row/);
});
