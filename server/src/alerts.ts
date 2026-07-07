import { upcomingSwims } from './meets.js';
import type { AlertMessage, Follow, Meet, Swimmer } from './types.js';

/**
 * Pluggable push delivery. Production uses Expo's push API (works for both
 * iOS and Android via the Expo app); tests inject a fake.
 */
export interface PushSender {
  send(message: AlertMessage): Promise<void>;
}

export class ExpoPushSender implements PushSender {
  constructor(private endpoint = 'https://exp.host/--/api/v2/push/send') {}

  async send(message: AlertMessage): Promise<void> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: message.deviceToken,
        title: message.title,
        body: message.body,
        sound: 'default',
        priority: 'high',
        data: {
          meetId: message.meetId,
          swimmerId: message.swimmerId,
          eventNumber: message.eventNumber,
          heatNumber: message.heatNumber,
          lane: message.lane,
          racesAway: message.racesAway,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Expo push failed: ${res.status} ${await res.text()}`);
    }
  }
}

/** Logs instead of pushing; used in dev and as the default when no sender is configured. */
export class ConsolePushSender implements PushSender {
  async send(message: AlertMessage): Promise<void> {
    console.log(`[push -> ${message.deviceToken}] ${message.title}: ${message.body}`);
  }
}

function alertKey(meetId: string, eventNumber: number, heatNumber: number, swimmerId: string): string {
  return `${meetId}:${eventNumber}:${heatNumber}:${swimmerId}`;
}

function describe(racesAway: number): string {
  if (racesAway === 0) return 'is UP NOW';
  if (racesAway === 1) return 'is up next race';
  return `is up in ${racesAway} races`;
}

/**
 * Compute which alerts are due for the meet's current position. A follow
 * fires when a followed swimmer is within `racesBefore` races (inclusive)
 * and that entry hasn't been alerted for that follow yet. Mutates each
 * fired follow's `alertedKeys` so re-running after every heat advance is
 * idempotent.
 */
export function computeDueAlerts(
  meet: Meet,
  follows: Follow[],
  swimmers: Map<string, Swimmer>,
): AlertMessage[] {
  const due: AlertMessage[] = [];
  if (meet.currentHeatIndex < 0) return due;

  for (const follow of follows) {
    const swimmer = swimmers.get(follow.swimmerId);
    if (!swimmer) continue;

    for (const swim of upcomingSwims(meet, follow.swimmerId)) {
      if (swim.racesAway > follow.racesBefore) continue;
      const key = alertKey(meet.id, swim.flat.eventNumber, swim.flat.heatNumber, follow.swimmerId);
      if (follow.alertedKeys.includes(key)) continue;
      follow.alertedKeys.push(key);
      due.push({
        followId: follow.id,
        deviceToken: follow.deviceToken,
        swimmerId: swimmer.id,
        swimmerName: swimmer.name,
        meetId: meet.id,
        eventNumber: swim.flat.eventNumber,
        eventName: swim.flat.eventName,
        heatNumber: swim.flat.heatNumber,
        lane: swim.lane,
        racesAway: swim.racesAway,
        title: `${swimmer.name} ${describe(swim.racesAway)}`,
        body: `Event ${swim.flat.eventNumber} ${swim.flat.eventName} — Heat ${swim.flat.heatNumber}, Lane ${swim.lane}`,
      });
    }
  }
  return due;
}

/** Compute and deliver due alerts; delivery failures are logged, not fatal. */
export async function dispatchAlerts(
  meet: Meet,
  follows: Follow[],
  swimmers: Map<string, Swimmer>,
  sender: PushSender,
): Promise<AlertMessage[]> {
  const due = computeDueAlerts(meet, follows, swimmers);
  await Promise.all(
    due.map((msg) =>
      sender.send(msg).catch((err) => {
        console.error(`push to ${msg.deviceToken} failed:`, err);
      }),
    ),
  );
  return due;
}
