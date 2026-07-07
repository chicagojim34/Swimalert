import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ffmpegAvailable } from '../src/clipper.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import type { PushSender } from '../src/alerts.js';

/**
 * True end-to-end clip generation: build a real test video with ffmpeg,
 * upload it as a wide camera's recording, run a race, and cut per-lane
 * clips. Skipped when ffmpeg isn't installed.
 */

const skip = !ffmpegAvailable();
const pushed: Array<{ deviceToken: string; title: string; body: string }> = [];
const recordingPush: PushSender = {
  send: async (m) => {
    pushed.push({ deviceToken: m.deviceToken, title: m.title, body: m.body });
  },
};
const workDir = mkdtempSync(join(tmpdir(), 'swimalert-clips-'));
const { server } = createApp(new Store(), recordingPush, { mediaDir: join(workDir, 'media') });
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data.error}`);
  return data;
}

function ffprobe(path: string): { durationSec: number; width: number; height: number } {
  const out = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
     'stream=width,height:format=duration', '-of', 'json', path],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(out.stdout);
  return {
    durationSec: Number(parsed.format.duration),
    width: parsed.streams[0].width,
    height: parsed.streams[0].height,
  };
}

test('wide camera covering 4 lanes yields cropped per-lane clips; phone camera yields full-frame', { skip }, async () => {
  // A 12-second 320x240 test-pattern video stands in for the pool recording.
  const srcPath = join(workDir, 'source.mp4');
  const gen = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=12:size=320x240:rate=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', srcPath,
  ]);
  assert.equal(gen.status, 0, gen.stderr?.toString());

  const meet = await api('POST', '/meets', {
    name: 'Clip Meet',
    laneCount: 6,
    events: [{
      number: 1,
      name: '50 Free',
      heats: [{
        number: 1,
        entries: [
          { swimmer: { name: 'L1' }, lane: 1 },
          { swimmer: { name: 'L2' }, lane: 2 },
          { swimmer: { name: 'L5' }, lane: 5 },
        ],
      }],
    }],
  });

  // Grandma follows the lane-2 swimmer so we can verify the clip-ready push.
  const [l2] = await api('GET', '/swimmers?q=L2');
  await api('POST', '/follows', { swimmerId: l2.id, deviceToken: 'tok-grandma', racesBefore: 0 });

  // One wide camera covers lanes 1-4 (auto column crops); a phone covers lane 5.
  const wide = await api('POST', '/cameras', { deviceId: 'wide-cam', meetId: meet.id, lanes: '1-4', kind: 'wide' });
  assert.deepEqual(wide.lanes, [1, 2, 3, 4]);
  assert.deepEqual(wide.crops['2'], { x: 0.25, y: 0, w: 0.25, h: 1 });
  await api('POST', '/cameras', { deviceId: 'phone-5', meetId: meet.id, lane: 5 });

  // Race timeline (server clock): both recordings start at S, horn S+6s, touches S+7s.
  const S = 1_700_000_000_000;
  const upload = async (deviceId: string) => {
    const res = await fetch(
      `${base}/videos/upload?meetId=${meet.id}&deviceId=${deviceId}&startTs=${S}&endTs=${S + 12_000}&ext=mp4`,
      { method: 'POST', body: readFileSync(srcPath) },
    );
    const data = await res.json();
    assert.equal(res.status, 201, data.error);
    assert.ok(data.bytes > 0);
    return data;
  };
  await upload('wide-cam');
  await upload('phone-5');

  await api('POST', `/meets/${meet.id}/events/1/heats/1/horn`, { ts: S + 6_000 });
  await api('POST', `/meets/${meet.id}/events/1/heats/1/touch`, { lane: 2, ts: S + 7_000 });
  await api('POST', `/meets/${meet.id}/events/1/heats/1/touch`, { lane: 5, ts: S + 7_200 });

  const { results } = await api('POST', `/meets/${meet.id}/events/1/heats/1/generate-clips`, {});
  const byLane = Object.fromEntries(results.map((r: any) => [r.lane, r]));

  // Lane 1 never touched: provisional window (horn + 20min) outruns the video.
  assert.equal(byLane[1].status, 'skipped');
  assert.match(byLane[1].reason, /no uploaded video covers/);

  // Lane 2: cut from the wide camera with its column crop -> quarter width.
  assert.equal(byLane[2].status, 'generated');
  assert.equal(byLane[2].clip.unofficialMs, 1_000);
  // Window: (S+6000-5000 preroll) .. (S+7000+4000 postroll) = 10s of video.
  const clip2 = ffprobe(join(workDir, 'media', 'clips', `${byLane[2].clip.id}.mp4`));
  assert.ok(Math.abs(clip2.durationSec - 10) < 0.8, `lane 2 duration ${clip2.durationSec}`);
  assert.equal(clip2.width, 80); // 320 * 0.25
  assert.equal(clip2.height, 240);

  // Lane 5: single-lane phone camera, full frame via stream copy.
  assert.equal(byLane[5].status, 'generated');
  const clip5 = ffprobe(join(workDir, 'media', 'clips', `${byLane[5].clip.id}.mp4`));
  assert.equal(clip5.width, 320);

  // Clips are streamable, with Range support for scrubbing.
  const full = await fetch(`${base}${byLane[2].clip.uri}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  const partial = await fetch(`${base}${byLane[2].clip.uri}`, { headers: { range: 'bytes=0-99' } });
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 100);

  // And the meet's clip list includes both, without leaking server paths.
  const clips = await api('GET', `/meets/${meet.id}/clips`);
  assert.equal(clips.length, 2);
  assert.ok(clips.every((c: any) => c.path === undefined && c.uri.startsWith('/clips/')));

  // Share link: public page renders swimmer + time, video streams by token.
  const token = byLane[2].clip.shareToken;
  assert.ok(token?.length >= 32);
  const sharePage = await fetch(`${base}/share/${token}`);
  assert.equal(sharePage.status, 200);
  const html = await sharePage.text();
  assert.match(html, /L2's race/);
  assert.match(html, /1\.00/); // 1000ms unofficial
  const shareVideo = await fetch(`${base}/share/${token}/video`, { headers: { range: 'bytes=0-49' } });
  assert.equal(shareVideo.status, 206);
  assert.equal((await fetch(`${base}/share/nope`)).status, 404);

  // Grandma got the clip-ready push with the share path in it.
  const clipPush = pushed.find((p) => p.title.includes('race clip is ready'));
  assert.ok(clipPush, 'expected a clip-ready push');
  assert.equal(clipPush.deviceToken, 'tok-grandma');
  assert.match(clipPush.body, new RegExp(`/share/${token}`));
});

test('generate-clips without a horn is a 409; before any upload lanes are skipped', { skip }, async () => {
  const meet = await api('POST', '/meets', {
    name: 'No Horn Meet',
    events: [{ number: 1, name: '50 Free', heats: [{ number: 1, entries: [{ swimmer: { name: 'A' }, lane: 1 }] }] }],
  });
  await assert.rejects(
    api('POST', `/meets/${meet.id}/events/1/heats/1/generate-clips`, {}),
    /No horn recorded/,
  );
  await api('POST', `/meets/${meet.id}/events/1/heats/1/horn`, { ts: 1000 });
  await api('POST', `/meets/${meet.id}/events/1/heats/1/touch`, { lane: 1, ts: 31_000 });
  const { results } = await api('POST', `/meets/${meet.id}/events/1/heats/1/generate-clips`, {});
  assert.equal(results[0].status, 'skipped');
  assert.match(results[0].reason, /no camera covers/);
});
