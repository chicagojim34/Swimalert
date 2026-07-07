/**
 * NTP-style clock synchronization between cameras/phones and the server.
 *
 * Flow: the client stamps t0 and POSTs it; the server stamps t1 on receive
 * and t2 on send; the client stamps t3 on response arrival, then calls
 * estimateOffset. Applying `serverTime = localTime + offset` puts every
 * device on the server clock, which is what makes multi-camera clips and
 * horn/touch timestamps line up.
 *
 * Phones on WiFi typically land within ±10–30 ms after a few samples —
 * comfortably inside one frame at 30/60 fps and far better than needed for
 * unofficial timing (official timing pads resolve to 0.01 s but nobody
 * expects that from a phone clip).
 */

export interface TimesyncSample {
  clientSendTs: number; // t0, client clock
  serverReceiveTs: number; // t1, server clock
  serverSendTs: number; // t2, server clock
  clientReceiveTs: number; // t3, client clock
}

/** Classic NTP offset: ((t1 - t0) + (t2 - t3)) / 2. Positive = server ahead of client. */
export function estimateOffset(s: TimesyncSample): number {
  return ((s.serverReceiveTs - s.clientSendTs) + (s.serverSendTs - s.clientReceiveTs)) / 2;
}

/** Round-trip delay of a sample; lower delay ⇒ more trustworthy offset. */
export function roundTripDelay(s: TimesyncSample): number {
  return (s.clientReceiveTs - s.clientSendTs) - (s.serverSendTs - s.serverReceiveTs);
}

/**
 * Combine several samples into one offset by trusting the sample with the
 * smallest round-trip delay (standard practice: it has the least queuing
 * noise). Clients should collect ~5 samples at registration time.
 */
export function bestOffset(samples: TimesyncSample[]): number {
  if (samples.length === 0) throw new Error('bestOffset requires at least one sample');
  let best = samples[0];
  for (const s of samples) {
    if (roundTripDelay(s) < roundTripDelay(best)) best = s;
  }
  return estimateOffset(best);
}
