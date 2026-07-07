import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { PushSender } from '../src/alerts.js';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import type { AlertMessage } from '../src/types.js';

class FakePushSender implements PushSender {
  sent: AlertMessage[] = [];
  async send(message: AlertMessage): Promise<void> {
    this.sent.push(message);
  }
}

const push = new FakePushSender();
const { server } = createApp(new Store(), push);
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

test('full meet-day flow: import, follow, advance, horn, touch, clip', async () => {
  // 1. Import a heat sheet.
  const meet = await api('POST', '/meets', {
    name: 'Regional Champs',
    laneCount: 6,
    events: [
      {
        number: 1,
        name: '100 Fly',
        heats: [
          { number: 1, entries: [{ swimmer: { name: 'Noah P', team: 'WAVES' }, lane: 3 }] },
          { number: 2, entries: [{ swimmer: { name: 'Mia K', team: 'WAVES' }, lane: 4, seedTime: '1:05.20' }] },
        ],
      },
      {
        number: 2,
        name: '50 Breast',
        heats: [{ number: 1, entries: [{ swimmer: { name: 'Mia K', team: 'WAVES' }, lane: 2 }] }],
      },
    ],
  });
  assert.equal(meet.currentHeatIndex, -1);

  // 2. Parent finds and follows Mia, alert 1 race before.
  const [mia] = await api('GET', '/swimmers?q=mia');
  assert.equal(mia.name, 'Mia K');
  await api('POST', '/follows', { swimmerId: mia.id, deviceToken: 'ExponentPushToken[mom]', racesBefore: 1 });

  // 3. Register a lane camera after a timesync exchange.
  const t0 = Date.now();
  const sync = await api('POST', '/timesync', { clientSendTs: t0 });
  assert.equal(sync.clientSendTs, t0);
  assert.ok(sync.serverReceiveTs <= sync.serverSendTs);
  await api('POST', '/cameras', { deviceId: 'iphone-lane4', meetId: meet.id, lane: 4, kind: 'phone', clockOffsetMs: 3 });

  // 4. Meet starts: E1H1 up. Mia (E1H2) is 1 away -> push fires.
  await api('POST', `/meets/${meet.id}/advance`);
  assert.equal(push.sent.length, 1);
  assert.match(push.sent[0].title, /Mia K is up next race/);
  assert.equal(push.sent[0].lane, 4);

  // 5. Advance to Mia's heat; her E2H1 swim is now 1 away -> second push, but no duplicate for E1H2.
  await api('POST', `/meets/${meet.id}/advance`);
  assert.equal(push.sent.length, 2);
  assert.equal(push.sent[1].eventNumber, 2);

  // 6. Horn fires, Mia touches: unofficial time comes back formatted.
  const hornTs = 5_000_000;
  await api('POST', `/meets/${meet.id}/events/1/heats/2/horn`, { ts: hornTs });
  const touch = await api('POST', `/meets/${meet.id}/events/1/heats/2/touch`, { lane: 4, ts: hornTs + 65_320 });
  assert.equal(touch.unofficialMs, 65_320);
  assert.equal(touch.unofficial, '1:05.32');

  // 7. Clip window covers pre-roll to post-roll.
  const clip = await api('GET', `/meets/${meet.id}/events/1/heats/2/clip?lane=4`);
  assert.equal(clip.startTs, hornTs - 5_000);
  assert.equal(clip.endTs, hornTs + 65_320 + 4_000);
  assert.equal(clip.provisionalEnd, false);

  // 8. Camera reports the finished clip; server attaches swimmer + unofficial time.
  const saved = await api('POST', '/clips', {
    meetId: meet.id,
    eventNumber: 1,
    heatNumber: 2,
    lane: 4,
    deviceId: 'iphone-lane4',
    startTs: clip.startTs,
    endTs: clip.endTs,
    uri: 'file:///clips/e1h2-lane4.mp4',
  });
  assert.equal(saved.swimmerId, mia.id);
  assert.equal(saved.unofficialMs, 65_320);

  const clips = await api('GET', `/meets/${meet.id}/clips`);
  assert.equal(clips.length, 1);

  // 9. Deck advances past her heat; upnext now shows only the 50 Breast swim,
  //    and dedupe means no duplicate push for the already-alerted E2H1 entry.
  await api('POST', `/meets/${meet.id}/advance`);
  assert.equal(push.sent.length, 2);
  const upnext = await api('GET', `/meets/${meet.id}/upnext?swimmerId=${mia.id}`);
  assert.deepEqual(upnext, [
    { eventNumber: 2, eventName: '50 Breast', heatNumber: 1, lane: 2, racesAway: 0 },
  ]);
});

test('SSE stream delivers horn and touch events to subscribed cameras', async () => {
  const meet = await api('POST', '/meets', {
    name: 'Stream Test',
    events: [
      { number: 1, name: '50 Free', heats: [{ number: 1, entries: [{ swimmer: { name: 'Zoe' }, lane: 1 }] }] },
    ],
  });

  const controller = new AbortController();
  const res = await fetch(`${base}/meets/${meet.id}/stream`, { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  async function readUntil(eventType: string): Promise<any> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const marker = `event: ${eventType}\n`;
      const idx = buffer.indexOf(marker);
      if (idx !== -1) {
        const dataLine = buffer.slice(idx + marker.length);
        const nl = dataLine.indexOf('\n');
        if (nl !== -1 && dataLine.startsWith('data: ')) {
          return JSON.parse(dataLine.slice(6, nl));
        }
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    throw new Error(`Timed out waiting for SSE event ${eventType}`);
  }

  await api('POST', `/meets/${meet.id}/events/1/heats/1/horn`, { ts: 42_000 });
  const horn = await readUntil('horn');
  assert.equal(horn.ts, 42_000);

  await api('POST', `/meets/${meet.id}/events/1/heats/1/touch`, { lane: 1, ts: 42_000 + 30_500 });
  const touch = await readUntil('touch');
  assert.equal(touch.lane, 1);
  assert.equal(touch.unofficial, '30.50');

  controller.abort();
});

test('CSV heat-sheet import creates a meet with deduped swimmers', async () => {
  const csv = [
    'Event,Event Name,Heat,Lane,Swimmer,Team,Seed',
    '1,Girls 100 IM,1,3,Ivy Q,ORCAS,1:15.00',
    '1,Girls 100 IM,1,4,June W,ORCAS,1:14.20',
    '2,Girls 50 Fly,1,4,Ivy Q,ORCAS,',
  ].join('\n');
  const res = await fetch(`${base}/meets/import/csv?name=CSV%20Meet&laneCount=6`, {
    method: 'POST',
    headers: { 'content-type': 'text/csv' },
    body: csv,
  });
  const meet = await res.json();
  assert.equal(res.status, 201);
  assert.equal(meet.name, 'CSV Meet');
  assert.equal(meet.laneCount, 6);
  assert.equal(meet.events.length, 2);
  // Ivy appears in both events as the same swimmer record.
  assert.equal(meet.events[0].heats[0].entries[0].swimmerId, meet.events[1].heats[0].entries[0].swimmerId);

  // Bad CSV -> 400 with the parser's message.
  const bad = await fetch(`${base}/meets/import/csv?name=Bad`, {
    method: 'POST',
    body: 'heat,lane,name\n1,1,A',
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /missing a "event" column/);
});

test('deck console is served at /', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /Deck Console/);
});

test('validation errors surface as 400s', async () => {
  await assert.rejects(
    api('POST', '/meets', {
      name: 'Bad Meet',
      laneCount: 4,
      events: [
        { number: 1, name: '50 Free', heats: [{ number: 1, entries: [{ swimmer: { name: 'X' }, lane: 9 }] }] },
      ],
    }),
    /500|lane 9 outside/,
  );
  await assert.rejects(api('POST', '/follows', { swimmerId: 'nope', deviceToken: 't' }), /not found/);
});
