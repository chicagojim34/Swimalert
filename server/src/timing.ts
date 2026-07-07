import type { Heat } from './types.js';

/**
 * Unofficial timing and clip windows.
 *
 * All timestamps are in the server's clock (ms since epoch). Cameras and the
 * horn source translate their local clocks to server time using the offset
 * estimated via timesync.ts, so a clip trimmed on any device lines up with
 * the horn and the touch.
 */

/** Default seconds of video kept before the horn (see the start, the blocks, the dive). */
export const DEFAULT_PRE_ROLL_MS = 5_000;
/** Default seconds kept after the touch (celebration, scoreboard glance). */
export const DEFAULT_POST_ROLL_MS = 4_000;
/** Cap for clip end when a lane never records a touch (missed tap, DQ, relay confusion). */
export const MAX_RACE_MS = 20 * 60_000;

export function recordHorn(heat: Heat, ts: number): void {
  heat.hornTs = ts;
}

/** Record a touch for a lane. Returns the unofficial time in ms, if the horn was captured. */
export function recordTouch(heat: Heat, lane: number, ts: number): number | undefined {
  heat.touches[lane] = ts;
  return unofficialMs(heat, lane);
}

/** Horn-to-touch elapsed time for a lane, or undefined if either end is missing. */
export function unofficialMs(heat: Heat, lane: number): number | undefined {
  const touch = heat.touches[lane];
  if (heat.hornTs === undefined || touch === undefined) return undefined;
  const elapsed = touch - heat.hornTs;
  return elapsed >= 0 ? elapsed : undefined;
}

/** Format elapsed ms as swim-style time: "27.45", "1:04.30", "17:31.02". */
export function formatSwimTime(ms: number): string {
  const totalHundredths = Math.round(ms / 10);
  const hundredths = totalHundredths % 100;
  const totalSeconds = Math.floor(totalHundredths / 100);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60);
  const hh = String(hundredths).padStart(2, '0');
  if (minutes === 0) return `${seconds}.${hh}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${hh}`;
}

export interface ClipWindow {
  startTs: number;
  endTs: number;
  /** True when the end is a fallback (no touch recorded yet). */
  provisionalEnd: boolean;
}

/**
 * The server-clock window a lane's clip should cover: pre-roll before the
 * horn through post-roll after the touch. Without a touch, the end falls
 * back to `maxRaceMs` past the horn so a camera still knows when it may
 * safely stop buffering.
 */
export function clipWindow(
  heat: Heat,
  lane: number,
  opts: { preRollMs?: number; postRollMs?: number; maxRaceMs?: number } = {},
): ClipWindow | undefined {
  if (heat.hornTs === undefined) return undefined;
  const preRoll = opts.preRollMs ?? DEFAULT_PRE_ROLL_MS;
  const postRoll = opts.postRollMs ?? DEFAULT_POST_ROLL_MS;
  const maxRace = opts.maxRaceMs ?? MAX_RACE_MS;
  const touch = heat.touches[lane];
  return {
    startTs: heat.hornTs - preRoll,
    endTs: touch !== undefined ? touch + postRoll : heat.hornTs + maxRace,
    provisionalEnd: touch === undefined,
  };
}
