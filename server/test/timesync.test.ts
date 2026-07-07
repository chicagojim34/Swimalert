import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bestOffset, estimateOffset, roundTripDelay, type TimesyncSample } from '../src/timesync.js';

test('estimateOffset recovers a known clock skew under symmetric latency', () => {
  // Server is 500ms ahead of the client; 40ms network each way.
  const s: TimesyncSample = {
    clientSendTs: 10_000, // client clock
    serverReceiveTs: 10_540, // 10_040 real + 500 skew
    serverSendTs: 10_541,
    clientReceiveTs: 10_081, // client clock, 81ms after send
  };
  assert.equal(estimateOffset(s), 500);
  assert.equal(roundTripDelay(s), 80);
});

test('negative offset when the client clock runs ahead', () => {
  const s: TimesyncSample = {
    clientSendTs: 20_000,
    serverReceiveTs: 19_720, // 20ms transit − 300ms skew
    serverSendTs: 19_722,
    clientReceiveTs: 20_042,
  };
  assert.equal(estimateOffset(s), -300);
});

test('bestOffset trusts the sample with the lowest round-trip delay', () => {
  const clean: TimesyncSample = {
    clientSendTs: 0,
    serverReceiveTs: 110, // 10ms out, +100 offset
    serverSendTs: 110,
    clientReceiveTs: 20, // 10ms back
  };
  const congested: TimesyncSample = {
    clientSendTs: 0,
    serverReceiveTs: 600, // 500ms out (queueing), +100 offset
    serverSendTs: 600,
    clientReceiveTs: 510, // 10ms back — asymmetry skews this sample's estimate
  };
  assert.equal(bestOffset([congested, clean]), 100);
  assert.throws(() => bestOffset([]), /at least one sample/);
});
