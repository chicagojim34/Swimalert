import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dispatchAlerts, type PushSender } from './alerts.js';
import { cutClip, ffmpegAvailable, findCoveringVideo } from './clipper.js';
import { parseHeatSheetCsv, type ProgramEventInput } from './heatsheet.js';
import { advance, currentHeat, findHeat, flatHeats, setPosition, upcomingSwims, validateProgram } from './meets.js';
import { Store } from './store.js';
import { clipWindow, formatSwimTime, recordHorn, recordTouch, unofficialMs } from './timing.js';
import type { CameraKind, Clip, CropRect, Follow, Meet, SourceVideo, SwimEvent } from './types.js';

interface ProgramInput {
  name: string;
  date?: string;
  laneCount?: number;
  events: ProgramEventInput[];
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBody(req: IncomingMessage): Promise<any> {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

/** Build and store a meet from a validated program (shared by JSON and CSV import). */
function createMeet(store: Store, input: ProgramInput): Meet {
  const laneCount = input.laneCount ?? 8;
  const events: SwimEvent[] = input.events.map((ev) => ({
    number: ev.number,
    name: ev.name,
    heats: ev.heats.map((h) => ({
      number: h.number,
      entries: h.entries.map((e) => ({
        swimmerId: store.upsertSwimmer(e.swimmer.name, e.swimmer.team, e.swimmer.age).id,
        lane: e.lane,
        seedTime: e.seedTime,
      })),
      touches: {},
    })),
  }));
  try {
    validateProgram(events, laneCount);
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
  const meet: Meet = {
    id: store.newId(),
    name: input.name,
    date: input.date,
    laneCount,
    events,
    currentHeatIndex: -1,
  };
  store.meets.set(meet.id, meet);
  store.persist();
  return meet;
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const VIDEO_EXTS = new Set(['mp4', 'mov', 'mkv', 'avi', 'm4v', 'mjpg', 'webm']);

/**
 * Normalize a camera registration's lane coverage: accepts `lane: 4`,
 * `lanes: [1,2,3]`, or `lanes: "1-8"`.
 */
function parseLanes(body: any): number[] {
  if (typeof body.lane === 'number') return [body.lane];
  if (Array.isArray(body.lanes)) return body.lanes.map(Number);
  if (typeof body.lanes === 'string') {
    const m = body.lanes.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const [from, to] = [Number(m[1]), Number(m[2])];
      if (to >= from) return Array.from({ length: to - from + 1 }, (_, i) => from + i);
    }
  }
  throw new HttpError(400, 'Camera requires lane (number) or lanes (array or "1-8" range)');
}

/**
 * Default per-lane crops for a wide camera with no explicit crops: equal
 * vertical strips in lane order across the frame, full height. Matches an
 * end-of-pool wide shot where lanes run left→right; side-mounted or
 * fisheye rigs should send their own measured crops instead.
 */
function autoColumnCrops(lanes: number[]): Record<number, CropRect> {
  const crops: Record<number, CropRect> = {};
  const w = 1 / lanes.length;
  lanes.forEach((lane, i) => {
    crops[lane] = { x: i * w, y: 0, w, h: 1 };
  });
  return crops;
}

/** Live event fan-out over Server-Sent Events, keyed by meet. */
class MeetStream {
  private clients = new Map<string, Set<ServerResponse>>();

  subscribe(meetId: string, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write(': connected\n\n');
    let set = this.clients.get(meetId);
    if (!set) this.clients.set(meetId, (set = new Set()));
    set.add(res);
    res.on('close', () => set!.delete(res));
  }

  broadcast(meetId: string, type: string, data: unknown): void {
    const set = this.clients.get(meetId);
    if (!set) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of set) res.write(frame);
  }
}

export interface App {
  server: Server;
  store: Store;
}

export function createApp(
  store: Store,
  pushSender: PushSender,
  opts: { mediaDir?: string } = {},
): App {
  const stream = new MeetStream();
  const mediaDir = opts.mediaDir ?? join(process.cwd(), 'data', 'media');

  function getMeet(id: string): Meet {
    const meet = store.meets.get(id);
    if (!meet) throw new HttpError(404, `Meet ${id} not found`);
    return meet;
  }

  async function alertAndBroadcast(meet: Meet): Promise<void> {
    const sent = await dispatchAlerts(meet, [...store.follows.values()], store.swimmers, pushSender);
    if (sent.length > 0) store.persist();
    const cur = currentHeat(meet);
    stream.broadcast(meet.id, 'position', {
      currentHeatIndex: meet.currentHeatIndex,
      current: cur && {
        eventNumber: cur.eventNumber,
        eventName: cur.eventName,
        heatNumber: cur.heatNumber,
      },
      alertsSent: sent.length,
    });
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type',
        });
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const method = req.method ?? 'GET';

      // GET /health
      if (method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, now: Date.now() });
      }

      // POST /timesync — NTP-style exchange; client computes offset from these stamps.
      if (method === 'POST' && url.pathname === '/timesync') {
        const serverReceiveTs = Date.now();
        const body = await readBody(req);
        return json(res, 200, {
          clientSendTs: body.clientSendTs,
          serverReceiveTs,
          serverSendTs: Date.now(),
        });
      }

      // GET / — deck operator console (single static page, no build step).
      if (method === 'GET' && (url.pathname === '/' || url.pathname === '/deck')) {
        try {
          const html = readFileSync(join(publicDir, 'deck.html'));
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch {
          throw new HttpError(404, 'Deck console not found');
        }
        return;
      }

      // POST /meets/import/csv?name=...&laneCount=... — heat sheet as CSV.
      if (method === 'POST' && url.pathname === '/meets/import/csv') {
        const name = url.searchParams.get('name');
        if (!name) throw new HttpError(400, 'name query param required');
        const csv = await readRawBody(req);
        let events: ProgramEventInput[];
        try {
          events = parseHeatSheetCsv(csv);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        const meet = createMeet(store, {
          name,
          date: url.searchParams.get('date') ?? undefined,
          laneCount: url.searchParams.get('laneCount')
            ? Number(url.searchParams.get('laneCount'))
            : undefined,
          events,
        });
        return json(res, 201, meet);
      }

      // POST /meets — import a meet program (heat sheet as JSON).
      if (method === 'POST' && url.pathname === '/meets') {
        const body = (await readBody(req)) as ProgramInput;
        if (!body.name || !Array.isArray(body.events)) {
          throw new HttpError(400, 'Meet requires name and events[]');
        }
        return json(res, 201, createMeet(store, body));
      }

      // GET /meets
      if (method === 'GET' && url.pathname === '/meets') {
        return json(
          res,
          200,
          [...store.meets.values()].map((m) => ({
            id: m.id,
            name: m.name,
            date: m.date,
            laneCount: m.laneCount,
            heatCount: flatHeats(m).length,
            currentHeatIndex: m.currentHeatIndex,
          })),
        );
      }

      // GET /swimmers?q=
      if (method === 'GET' && url.pathname === '/swimmers') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const all = [...store.swimmers.values()];
        return json(res, 200, q ? all.filter((s) => s.name.toLowerCase().includes(q)) : all);
      }

      // POST /follows — parent follows a swimmer for alerts.
      if (method === 'POST' && url.pathname === '/follows') {
        const body = await readBody(req);
        if (!body.swimmerId || !body.deviceToken) {
          throw new HttpError(400, 'Follow requires swimmerId and deviceToken');
        }
        if (!store.swimmers.has(body.swimmerId)) {
          throw new HttpError(404, `Swimmer ${body.swimmerId} not found`);
        }
        const follow: Follow = {
          id: store.newId(),
          swimmerId: body.swimmerId,
          deviceToken: body.deviceToken,
          racesBefore: body.racesBefore ?? 3,
          alertedKeys: [],
        };
        store.follows.set(follow.id, follow);
        store.persist();
        return json(res, 201, follow);
      }

      // GET /follows
      if (method === 'GET' && url.pathname === '/follows') {
        return json(res, 200, [...store.follows.values()]);
      }

      // POST /cameras — register a camera covering one lane (phone on the
      // fence) or many (wide end-of-pool shot with per-lane crops).
      if (method === 'POST' && url.pathname === '/cameras') {
        const body = await readBody(req);
        if (!body.deviceId || !body.meetId) {
          throw new HttpError(400, 'Camera requires deviceId and meetId');
        }
        const meet = getMeet(body.meetId);
        const lanes = parseLanes(body);
        for (const lane of lanes) {
          if (!Number.isInteger(lane) || lane < 1 || lane > meet.laneCount) {
            throw new HttpError(400, `Lane ${lane} must be 1..${meet.laneCount}`);
          }
        }
        const kind = (body.kind ?? (lanes.length > 1 ? 'wide' : 'phone')) as CameraKind;
        let crops: Record<number, CropRect> | undefined = body.crops;
        if (!crops && lanes.length > 1) crops = autoColumnCrops(lanes);
        if (crops) {
          for (const [lane, c] of Object.entries(crops)) {
            for (const v of [c.x, c.y, c.w, c.h]) {
              if (typeof v !== 'number' || v < 0 || v > 1) {
                throw new HttpError(400, `Crop for lane ${lane} must use normalized 0..1 values`);
              }
            }
          }
        }
        const reg = {
          deviceId: String(body.deviceId),
          meetId: meet.id,
          lanes,
          kind,
          label: body.label,
          crops,
          clockOffsetMs: body.clockOffsetMs,
          registeredAt: Date.now(),
        };
        store.cameras.set(reg.deviceId, reg);
        store.persist();
        stream.broadcast(meet.id, 'cameras', store.camerasForMeet(meet.id));
        return json(res, 201, reg);
      }

      // POST /videos/upload?meetId&deviceId&startTs[&endTs][&ext] — binary
      // body is the recording itself; the startTs (server clock, from the
      // camera's timesynced clock) is what lets clips be cut precisely.
      if (method === 'POST' && url.pathname === '/videos/upload') {
        const meet = getMeet(url.searchParams.get('meetId') ?? '');
        const deviceId = url.searchParams.get('deviceId');
        const startTs = Number(url.searchParams.get('startTs'));
        if (!deviceId || !Number.isFinite(startTs)) {
          throw new HttpError(400, 'deviceId and startTs query params required');
        }
        const ext = (url.searchParams.get('ext') ?? 'mp4').toLowerCase();
        if (!VIDEO_EXTS.has(ext)) {
          throw new HttpError(400, `ext must be one of: ${[...VIDEO_EXTS].join(', ')}`);
        }
        const id = store.newId();
        const path = join(mediaDir, 'videos', `${id}.${ext}`);
        mkdirSync(dirname(path), { recursive: true });
        await pipeline(req, createWriteStream(path));
        const endTsRaw = url.searchParams.get('endTs');
        const video: SourceVideo = {
          id,
          meetId: meet.id,
          deviceId,
          startTs,
          endTs: endTsRaw ? Number(endTsRaw) : undefined,
          path,
          createdAt: Date.now(),
        };
        store.videos.set(id, video);
        store.persist();
        return json(res, 201, { ...video, path: undefined, bytes: statSync(path).size });
      }

      // GET /clips/:id/video — stream a generated clip (Range-aware so
      // browsers can scrub).
      if (method === 'GET' && parts[0] === 'clips' && parts[2] === 'video' && parts.length === 3) {
        const clip = store.clips.get(parts[1]);
        if (!clip?.path) throw new HttpError(404, 'Clip video not found on this server');
        let size: number;
        try {
          size = statSync(clip.path).size;
        } catch {
          throw new HttpError(404, 'Clip file missing from disk');
        }
        const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
        const start = range?.[1] ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(range ? 206 : 200, {
          'content-type': 'video/mp4',
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
          ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
          'access-control-allow-origin': '*',
        });
        createReadStream(clip.path, { start, end }).pipe(res);
        return;
      }

      // POST /clips — a camera reports a finished clip's metadata.
      if (method === 'POST' && url.pathname === '/clips') {
        const body = await readBody(req);
        const meet = getMeet(body.meetId);
        const flat = findHeat(meet, body.eventNumber, body.heatNumber);
        const entry = flat.heat.entries.find((e) => e.lane === body.lane);
        const clip: Clip = {
          id: store.newId(),
          meetId: meet.id,
          eventNumber: flat.eventNumber,
          heatNumber: flat.heatNumber,
          lane: body.lane,
          swimmerId: entry?.swimmerId,
          deviceId: String(body.deviceId ?? 'unknown'),
          startTs: body.startTs,
          endTs: body.endTs,
          uri: body.uri,
          unofficialMs: unofficialMs(flat.heat, body.lane),
          createdAt: Date.now(),
        };
        store.clips.set(clip.id, clip);
        store.persist();
        stream.broadcast(meet.id, 'clip', clip);
        return json(res, 201, clip);
      }

      // Meet-scoped routes: /meets/:id/...
      if (parts[0] === 'meets' && parts.length >= 2) {
        const meet = getMeet(parts[1]);

        if (method === 'GET' && parts.length === 2) {
          return json(res, 200, { ...meet, current: currentHeat(meet) });
        }

        if (method === 'GET' && parts[2] === 'stream') {
          stream.subscribe(meet.id, res);
          return;
        }

        if (method === 'GET' && parts[2] === 'cameras') {
          return json(res, 200, store.camerasForMeet(meet.id));
        }

        if (method === 'GET' && parts[2] === 'clips') {
          return json(res, 200, store.clipsForMeet(meet.id).map((c) => ({ ...c, path: undefined })));
        }

        if (method === 'GET' && parts[2] === 'videos') {
          return json(res, 200, store.videosForMeet(meet.id).map((v) => ({ ...v, path: undefined })));
        }

        if (method === 'GET' && parts[2] === 'upnext') {
          const swimmerId = url.searchParams.get('swimmerId');
          if (!swimmerId) throw new HttpError(400, 'swimmerId query param required');
          return json(res, 200, upcomingSwims(meet, swimmerId).map((s) => ({
            eventNumber: s.flat.eventNumber,
            eventName: s.flat.eventName,
            heatNumber: s.flat.heatNumber,
            lane: s.lane,
            racesAway: s.racesAway,
          })));
        }

        // POST /meets/:id/advance — deck operator moves to the next heat.
        if (method === 'POST' && parts[2] === 'advance') {
          const cur = advance(meet);
          await alertAndBroadcast(meet);
          store.persist();
          return json(res, 200, { currentHeatIndex: meet.currentHeatIndex, current: cur });
        }

        // POST /meets/:id/position {eventNumber, heatNumber} — jump/reorder.
        if (method === 'POST' && parts[2] === 'position') {
          const body = await readBody(req);
          const cur = setPosition(meet, body.eventNumber, body.heatNumber);
          await alertAndBroadcast(meet);
          store.persist();
          return json(res, 200, { currentHeatIndex: meet.currentHeatIndex, current: cur });
        }

        // /meets/:id/events/:ev/heats/:heat/(horn|touch|clip)
        if (parts[2] === 'events' && parts[4] === 'heats' && parts.length === 7) {
          const flat = findHeat(meet, Number(parts[3]), Number(parts[5]));
          const action = parts[6];

          if (method === 'POST' && action === 'horn') {
            const body = await readBody(req);
            const ts = typeof body.ts === 'number' ? body.ts : Date.now();
            recordHorn(flat.heat, ts);
            store.persist();
            stream.broadcast(meet.id, 'horn', {
              eventNumber: flat.eventNumber,
              heatNumber: flat.heatNumber,
              ts,
            });
            return json(res, 200, { hornTs: ts });
          }

          if (method === 'POST' && action === 'touch') {
            const body = await readBody(req);
            if (typeof body.lane !== 'number') throw new HttpError(400, 'lane required');
            const ts = typeof body.ts === 'number' ? body.ts : Date.now();
            const elapsed = recordTouch(flat.heat, body.lane, ts);
            store.persist();
            stream.broadcast(meet.id, 'touch', {
              eventNumber: flat.eventNumber,
              heatNumber: flat.heatNumber,
              lane: body.lane,
              ts,
              unofficialMs: elapsed,
              unofficial: elapsed !== undefined ? formatSwimTime(elapsed) : undefined,
            });
            return json(res, 200, {
              lane: body.lane,
              touchTs: ts,
              unofficialMs: elapsed,
              unofficial: elapsed !== undefined ? formatSwimTime(elapsed) : undefined,
            });
          }

          // POST .../generate-clips {lanes?} — cut per-lane clip files out of
          // uploaded source videos (one wide camera yields one clip per lane
          // via its crop regions; single-lane cameras yield their lane's clip).
          if (method === 'POST' && action === 'generate-clips') {
            if (!ffmpegAvailable()) {
              throw new HttpError(503, 'ffmpeg is not installed on this server');
            }
            if (flat.heat.hornTs === undefined) {
              throw new HttpError(409, 'No horn recorded for this heat yet');
            }
            const body = await readBody(req);
            const requested: number[] = Array.isArray(body.lanes)
              ? body.lanes.map(Number)
              : flat.heat.entries.map((e) => e.lane);
            const cameras = store.camerasForMeet(meet.id);
            const videos = store.videosForMeet(meet.id);
            const results: Array<{ lane: number; status: string; clip?: Clip; reason?: string }> = [];

            for (const lane of requested) {
              const window = clipWindow(flat.heat, lane)!;
              const laneCams = cameras.filter((c) => c.lanes.includes(lane));
              if (laneCams.length === 0) {
                results.push({ lane, status: 'skipped', reason: 'no camera covers this lane' });
                continue;
              }
              const source = findCoveringVideo(videos, new Set(laneCams.map((c) => c.deviceId)), window);
              if (!source?.path) {
                results.push({ lane, status: 'skipped', reason: 'no uploaded video covers the race window' });
                continue;
              }
              const camera = laneCams.find((c) => c.deviceId === source.deviceId)!;
              const clipId = store.newId();
              const outPath = join(mediaDir, 'clips', `${clipId}.mp4`);
              try {
                await cutClip({
                  sourcePath: source.path,
                  sourceStartTs: source.startTs,
                  window,
                  crop: camera.crops?.[lane],
                  outPath,
                });
              } catch (err) {
                results.push({ lane, status: 'error', reason: (err as Error).message });
                continue;
              }
              const entry = flat.heat.entries.find((e) => e.lane === lane);
              const clip: Clip = {
                id: clipId,
                meetId: meet.id,
                eventNumber: flat.eventNumber,
                heatNumber: flat.heatNumber,
                lane,
                swimmerId: entry?.swimmerId,
                deviceId: source.deviceId,
                startTs: Math.max(window.startTs, source.startTs),
                endTs: window.endTs,
                uri: `/clips/${clipId}/video`,
                path: outPath,
                sourceVideoId: source.id,
                unofficialMs: unofficialMs(flat.heat, lane),
                createdAt: Date.now(),
              };
              store.clips.set(clip.id, clip);
              stream.broadcast(meet.id, 'clip', { ...clip, path: undefined });
              results.push({ lane, status: 'generated', clip: { ...clip, path: undefined } });
            }
            store.persist();
            return json(res, 200, { results });
          }

          if (method === 'GET' && action === 'clip') {
            const lane = Number(url.searchParams.get('lane'));
            if (!Number.isInteger(lane)) throw new HttpError(400, 'lane query param required');
            const window = clipWindow(flat.heat, lane);
            if (!window) throw new HttpError(409, 'No horn recorded for this heat yet');
            return json(res, 200, window);
          }
        }
      }

      throw new HttpError(404, `No route for ${method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HttpError) return json(res, err.status, { error: err.message });
      console.error(err);
      return json(res, 500, { error: 'Internal server error' });
    }
  });

  return { server, store };
}
