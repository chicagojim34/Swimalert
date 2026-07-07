#!/usr/bin/env node
/**
 * Swimalert capture agent: turns a laptop with a USB-attached MTP/PTP camera
 * (anything gphoto2 supports — most Canon/Nikon/Sony bodies) into a lane
 * camera. Phones use the mobile app instead; this agent covers "real"
 * cameras on tripods.
 *
 * Usage:
 *   node agent.mjs --server http://localhost:4000 --meet <meetId> --lane 4 [--out ./clips]
 *
 * Requires gphoto2 on PATH for actual capture (`apt install gphoto2` /
 * `brew install gphoto2`). Without it the agent runs in dry-run mode and
 * logs what it would do — handy for testing the sync/stream plumbing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { hostname } from 'node:os';

const args = Object.fromEntries(
  process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : [])).filter((p) => p.length),
);
const SERVER = args.server ?? 'http://localhost:4000';
const MEET_ID = args.meet;
const LANE = Number(args.lane);
const OUT_DIR = args.out ?? './clips';
const DEVICE_ID = `mtp-${hostname()}-lane${LANE}`;
const POST_ROLL_MS = 4000;

if (!MEET_ID || !Number.isInteger(LANE)) {
  console.error('Usage: node agent.mjs --server URL --meet MEET_ID --lane N [--out DIR]');
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

await post('/cameras', { deviceId: DEVICE_ID, meetId: MEET_ID, lane: LANE, kind: 'mtp', clockOffsetMs });
console.log(`Registered ${DEVICE_ID} on lane ${LANE}`);

let capture = null; // { proc, file, startServerTs, race }

function startCapture(race) {
  if (capture) return;
  const file = `${OUT_DIR}/e${race.eventNumber}h${race.heatNumber}-lane${LANE}.mjpg`;
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
  try {
    const clip = await post('/clips', {
      meetId: MEET_ID,
      eventNumber: race.eventNumber,
      heatNumber: race.heatNumber,
      lane: LANE,
      deviceId: DEVICE_ID,
      startTs: startServerTs,
      endTs: endServerTs,
      uri: `file://${file}`,
    });
    console.log(`  clip reported (${clip.id})${clip.unofficialMs ? ` — unofficial ${clip.unofficialMs}ms` : ''}`);
  } catch (err) {
    console.error('  clip report failed:', err.message);
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

    if (type === 'position' && data.current) {
      startCapture({ eventNumber: data.current.eventNumber, heatNumber: data.current.heatNumber });
    } else if (type === 'horn') {
      startCapture({ eventNumber: data.eventNumber, heatNumber: data.heatNumber });
    } else if (type === 'touch' && data.lane === LANE) {
      console.log(`  touch on lane ${LANE}${data.unofficial ? ` — ${data.unofficial} (unofficial)` : ''}`);
      setTimeout(stopCapture, POST_ROLL_MS);
    }
  }
}
