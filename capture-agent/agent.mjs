#!/usr/bin/env node
/**
 * Swimalert capture agent: turns a laptop with a USB-attached MTP/PTP camera
 * (anything gphoto2 supports — most Canon/Nikon/Sony bodies) into a lane
 * camera. Phones use the mobile app instead; this agent covers "real"
 * cameras on tripods.
 *
 * Usage:
 *   # phone-style: one camera, one lane
 *   node agent.mjs --server http://localhost:4000 --meet <meetId> --lane 4
 *   # soccer-style: one wide camera covering every lane, per-lane digital crops
 *   node agent.mjs --server http://localhost:4000 --meet <meetId> --lanes 1-8
 *
 * After each race the agent uploads its recording to the server and asks it
 * to generate clips — with a multi-lane camera that's one clip per lane,
 * cropped to that lane's slice of the frame.
 *
 * Requires gphoto2 on PATH for actual capture (`apt install gphoto2` /
 * `brew install gphoto2`). Without it the agent runs in dry-run mode and
 * logs what it would do — handy for testing the sync/stream plumbing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter((p) => p.length),
);
const SERVER = args.server ?? 'http://localhost:4000';
const MEET_ID = args.meet;
const LANES = args.lanes
  ? args.lanes // range string like "1-8" or comma list
  : args.lane !== undefined
    ? [Number(args.lane)]
    : null;
const OUT_DIR = args.out ?? './clips';
const laneLabel = typeof LANES === 'string' ? LANES.replace(/[^0-9-]/g, '') : LANES?.[0];
const DEVICE_ID = `mtp-${hostname()}-lanes${laneLabel}`;
const POST_ROLL_MS = 4000;

if (!MEET_ID || LANES === null) {
  console.error('Usage: node agent.mjs --server URL --meet MEET_ID (--lane N | --lanes 1-8) [--out DIR]');
  process.exit(1);
}

const hasGphoto2 = spawnSync('gphoto2', ['--version'], { stdio: 'ignore' }).status === 0;
if (!hasGphoto2) console.warn('gphoto2 not found — running in dry-run mode (no video captured)');
mkdirSync(OUT_DIR, { recursive: true });

async function post(path, body) {
  const res = await fetch(SERVER + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path}: ${data.error}`);
  return data;
}

/** NTP-style clock sync against the server (see server/src/timesync.ts). */
async function syncClock(samples = 5) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const clientSendTs = Date.now();
    const s = await post('/timesync', { clientSendTs });
    const clientReceiveTs = Date.now();
    const offset = (s.serverReceiveTs - clientSendTs + (s.serverSendTs - clientReceiveTs)) / 2;
    const delay = clientReceiveTs - clientSendTs - (s.serverSendTs - s.serverReceiveTs);
    if (!best || delay < best.delay) best = { offset, delay };
  }
  return best.offset;
}

let clockOffsetMs = await syncClock();
const serverNow = () => Date.now() + clockOffsetMs;
console.log(`Clock synced: offset ${clockOffsetMs.toFixed(1)}ms vs server`);

const registration = await post('/cameras', {
  deviceId: DEVICE_ID,
  meetId: MEET_ID,
  ...(typeof LANES === 'string' ? { lanes: LANES } : { lane: LANES[0] }),
  kind: typeof LANES === 'string' ? 'wide' : 'mtp',
  clockOffsetMs,
});
const coveredLanes = registration.lanes;
console.log(`Registered ${DEVICE_ID} covering lane(s) ${coveredLanes.join(', ')}`);
if (registration.crops) {
  console.log(`Per-lane crops active: ${Object.keys(registration.crops).length} regions (wide-camera mode)`);
}

let capture = null; // { proc, file, startServerTs, race }

function startCapture(race) {
  if (capture) return;
  const file = `${OUT_DIR}/e${race.eventNumber}h${race.heatNumber}-lanes${laneLabel}.mjpg`;
  const startServerTs = serverNow();
  const proc = hasGphoto2
    ? spawn('gphoto2', ['--capture-movie', `--stdout`], { stdio: ['ignore', 'pipe', 'inherit'] })
    : null;
  if (proc) proc.stdout.pipe(createWriteStream(file));
  capture = { proc, file, startServerTs, race };
  console.log(`▶ recording E${race.eventNumber} H${race.heatNumber} -> ${file}`);
}

async function stopCapture() {
  if (!capture) return;
  const { proc, file, startServerTs, race } = capture;
  capture = null;
  proc?.kill('SIGINT');
  const endServerTs = serverNow();
  console.log(`■ stopped E${race.eventNumber} H${race.heatNumber}`);

  if (!existsSync(file)) {
    console.log('  dry-run: no video file to upload');
    return;
  }
  try {
    // Upload the whole recording, then let the server cut per-lane clips
    // (cropped per lane when this is a wide camera).
    const uploadRes = await fetch(
      `${SERVER}/videos/upload?meetId=${MEET_ID}&deviceId=${DEVICE_ID}` +
        `&startTs=${startServerTs}&endTs=${endServerTs}&ext=mjpg`,
      { method: 'POST', body: readFileSync(file) },
    );
    const video = await uploadRes.json();
    if (!uploadRes.ok) throw new Error(video.error);
    console.log(`  uploaded recording (${(video.bytes / 1e6).toFixed(1)} MB)`);

    const { results } = await post(
      `/meets/${MEET_ID}/events/${race.eventNumber}/heats/${race.heatNumber}/generate-clips`,
      { lanes: coveredLanes },
    );
    for (const r of results) {
      if (r.status === 'generated') {
        console.log(`  🎬 lane ${r.lane}: clip ready${r.clip.unofficialMs ? ` — ${r.clip.unofficialMs}ms unofficial` : ''}`);
      } else {
        console.log(`  lane ${r.lane}: ${r.status} (${r.reason ?? ''})`);
      }
    }
  } catch (err) {
    console.error('  upload/clip generation failed:', err.message);
  }
}

// Follow the meet's live stream: roll when a heat goes up, cut after our touch.
const res = await fetch(`${SERVER}/meets/${MEET_ID}/stream`);
if (!res.ok) {
  console.error(`Stream failed: ${res.status}`);
  process.exit(1);
}
console.log('Listening for horn/touch events…');

const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let sep;
  while ((sep = buffer.indexOf('\n\n')) !== -1) {
    const frame = buffer.slice(0, sep);
    buffer = buffer.slice(sep + 2);
    const typeMatch = frame.match(/^event: (.+)$/m);
    const dataMatch = frame.match(/^data: (.+)$/m);
    if (!typeMatch || !dataMatch) continue;
    const type = typeMatch[1];
    const data = JSON.parse(dataMatch[1]);

    if (type === 'position') {
      // Deck moved on: finish (and upload) the previous heat's recording,
      // then roll for the new one. This is also how a multi-lane camera
      // knows the whole heat is over without tracking every lane's touch.
      await stopCapture();
      if (data.current) {
        startCapture({ eventNumber: data.current.eventNumber, heatNumber: data.current.heatNumber });
      }
    } else if (type === 'horn') {
      startCapture({ eventNumber: data.eventNumber, heatNumber: data.heatNumber });
    } else if (type === 'touch' && coveredLanes.includes(data.lane)) {
      console.log(`  touch on lane ${data.lane}${data.unofficial ? ` — ${data.unofficial} (unofficial)` : ''}`);
      // Single-lane camera: our race is done, cut after the post-roll.
      if (coveredLanes.length === 1) setTimeout(stopCapture, POST_ROLL_MS);
    }
  }
}
