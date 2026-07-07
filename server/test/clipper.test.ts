import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFfmpegArgs, findCoveringVideo } from '../src/clipper.js';
import type { SourceVideo } from '../src/types.js';

test('buildFfmpegArgs seeks to the window offset within the source', () => {
  const args = buildFfmpegArgs({
    sourcePath: '/videos/src.mp4',
    sourceStartTs: 1_000_000,
    window: { startTs: 1_006_500, endTs: 1_020_000 },
    outPath: '/clips/out.mp4',
  });
  const ss = args[args.indexOf('-ss') + 1];
  const t = args[args.indexOf('-t') + 1];
  assert.equal(ss, '6.500');
  assert.equal(t, '13.500');
  // No crop -> lossless stream copy, no re-encode.
  assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy');
  assert.ok(!args.includes('-vf'));
});

test('buildFfmpegArgs clamps when the window starts before the recording did', () => {
  const args = buildFfmpegArgs({
    sourcePath: 'src.mp4',
    sourceStartTs: 5_000, // camera started late: horn pre-roll predates the file
    window: { startTs: 2_000, endTs: 12_000 },
    outPath: 'out.mp4',
  });
  assert.equal(args[args.indexOf('-ss') + 1], '0.000');
  assert.equal(args[args.indexOf('-t') + 1], '7.000'); // 12s - 5s
});

test('buildFfmpegArgs crop uses resolution-independent expressions and re-encodes', () => {
  const args = buildFfmpegArgs({
    sourcePath: 'src.mp4',
    sourceStartTs: 0,
    window: { startTs: 0, endTs: 10_000 },
    crop: { x: 0.25, y: 0, w: 0.25, h: 1 },
    outPath: 'out.mp4',
  });
  const vf = args[args.indexOf('-vf') + 1];
  assert.match(vf, /crop=floor\(in_w\*0\.25\/2\)\*2:floor\(in_h\*1\/2\)\*2:floor\(in_w\*0\.25\/2\)\*2:floor\(in_h\*0\/2\)\*2/);
  assert.ok(args.includes('libx264'));
});

test('buildFfmpegArgs rejects impossible windows and bad crops', () => {
  assert.throws(
    () =>
      buildFfmpegArgs({
        sourcePath: 's',
        sourceStartTs: 50_000,
        window: { startTs: 10_000, endTs: 20_000 }, // ends before recording began
        outPath: 'o',
      }),
    /ends before the source video starts/,
  );
  assert.throws(
    () =>
      buildFfmpegArgs({
        sourcePath: 's',
        sourceStartTs: 0,
        window: { startTs: 0, endTs: 1_000 },
        crop: { x: -0.1, y: 0, w: 0.5, h: 1 },
        outPath: 'o',
      }),
    /Crop x=-0.1 outside 0..1/,
  );
});

test('findCoveringVideo picks the tightest covering source from allowed devices', () => {
  const mk = (id: string, deviceId: string, startTs: number, endTs?: number): SourceVideo => ({
    id, meetId: 'm', deviceId, startTs, endTs, path: `/v/${id}.mp4`, createdAt: 0,
  });
  const window = { startTs: 10_000, endTs: 20_000, provisionalEnd: false };
  const videos = [
    mk('early', 'cam1', 0, 30_000),
    mk('tight', 'cam1', 8_000, 25_000),
    mk('late', 'cam1', 15_000, 30_000), // starts after window -> unusable
    mk('short', 'cam1', 0, 15_000), // ends before window end -> unusable
    mk('other', 'cam2', 5_000, 30_000), // right timing, wrong device
  ];
  assert.equal(findCoveringVideo(videos, new Set(['cam1']), window)?.id, 'tight');
  assert.equal(findCoveringVideo(videos, new Set(['cam2']), window)?.id, 'other');
  assert.equal(findCoveringVideo(videos, new Set(['cam3']), window), undefined);
  // Open-ended videos (still recording) are trusted to cover the window.
  assert.equal(findCoveringVideo([mk('live', 'cam1', 9_000)], new Set(['cam1']), window)?.id, 'live');
});
