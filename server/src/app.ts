import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dispatchAlerts, type PushSender } from './alerts.js';
import { advance, currentHeat, findHeat, flatHeats, setPosition, upcomingSwims, validateProgram } from './meets.js';
import { Store } from './store.js';
import { clipWindow, formatSwimTime, recordHorn, recordTouch, unofficialMs } from './timing.js';
import type { CameraKind, Clip, Follow, Meet, SwimEvent } from './types.js';

interface ProgramEntryInput {
  swimmer: { name: string; team?: string; age?: number };
  lane: number;
  seedTime?: string;
}

interface ProgramInput {
  name: string;
  date?: string;
  laneCount?: number;
  events: Array<{
    number: number;
    name: string;
    heats: Array<{ number: number; entries: ProgramEntryInput[] }>;
  }>;
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

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
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

export function createApp(store: Store, pushSender: PushSender): App {
  const stream = new MeetStream();

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

      // POST /meets — import a meet program (heat sheet as JSON).
      if (method === 'POST' && url.pathname === '/meets') {
        const body = (await readBody(req)) as ProgramInput;
        if (!body.name || !Array.isArray(body.events)) {
          throw new HttpError(400, 'Meet requires name and events[]');
        }
        const laneCount = body.laneCount ?? 8;
        const events: SwimEvent[] = body.events.map((ev) => ({
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
          name: body.name,
          date: body.date,
          laneCount,
          events,
          currentHeatIndex: -1,
        };
        store.meets.set(meet.id, meet);
        store.persist();
        return json(res, 201, meet);
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

      // POST /cameras — register a camera (phone or MTP station) on a lane.
      if (method === 'POST' && url.pathname === '/cameras') {
        const body = await readBody(req);
        if (!body.deviceId || !body.meetId || typeof body.lane !== 'number') {
          throw new HttpError(400, 'Camera requires deviceId, meetId, lane');
        }
        const meet = getMeet(body.meetId);
        if (body.lane < 1 || body.lane > meet.laneCount) {
          throw new HttpError(400, `Lane must be 1..${meet.laneCount}`);
        }
        const reg = {
          deviceId: String(body.deviceId),
          meetId: meet.id,
          lane: body.lane as number,
          kind: (body.kind ?? 'phone') as CameraKind,
          label: body.label,
          clockOffsetMs: body.clockOffsetMs,
          registeredAt: Date.now(),
        };
        store.cameras.set(reg.deviceId, reg);
        store.persist();
        stream.broadcast(meet.id, 'cameras', store.camerasForMeet(meet.id));
        return json(res, 201, reg);
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
          return json(res, 200, store.clipsForMeet(meet.id));
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
