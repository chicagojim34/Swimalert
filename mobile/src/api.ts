/** Thin client for the Swimalert server. Set SERVER_URL to your LAN address at the pool. */
export const SERVER_URL = 'http://192.168.1.100:4000';

async function request(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(SERVER_URL + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  listMeets: () => request('GET', '/meets'),
  getMeet: (id: string) => request('GET', `/meets/${id}`),
  searchSwimmers: (q: string) => request('GET', `/swimmers?q=${encodeURIComponent(q)}`),
  follow: (swimmerId: string, deviceToken: string, racesBefore: number) =>
    request('POST', '/follows', { swimmerId, deviceToken, racesBefore }),
  upnext: (meetId: string, swimmerId: string) =>
    request('GET', `/meets/${meetId}/upnext?swimmerId=${swimmerId}`),
  registerCamera: (deviceId: string, meetId: string, lane: number, clockOffsetMs: number) =>
    request('POST', '/cameras', { deviceId, meetId, lane, kind: 'phone', clockOffsetMs }),
  clipWindow: (meetId: string, ev: number, heat: number, lane: number) =>
    request('GET', `/meets/${meetId}/events/${ev}/heats/${heat}/clip?lane=${lane}`),
  reportClip: (clip: {
    meetId: string;
    eventNumber: number;
    heatNumber: number;
    lane: number;
    deviceId: string;
    startTs: number;
    endTs: number;
    uri: string;
  }) => request('POST', '/clips', clip),
  timesyncOnce: async () => {
    const clientSendTs = Date.now();
    const s = await request('POST', '/timesync', { clientSendTs });
    const clientReceiveTs = Date.now();
    return { ...s, clientReceiveTs };
  },
};

/**
 * NTP-style offset estimation (mirror of server/src/timesync.ts): run a few
 * exchanges, keep the one with the lowest round-trip delay.
 * serverTime = Date.now() + offset.
 */
export async function estimateClockOffset(samples = 5): Promise<number> {
  let best: { offset: number; delay: number } | null = null;
  for (let i = 0; i < samples; i++) {
    const s = await api.timesyncOnce();
    const offset = (s.serverReceiveTs - s.clientSendTs + (s.serverSendTs - s.clientReceiveTs)) / 2;
    const delay = s.clientReceiveTs - s.clientSendTs - (s.serverSendTs - s.serverReceiveTs);
    if (!best || delay < best.delay) best = { offset, delay };
  }
  return best!.offset;
}
