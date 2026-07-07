import type { FlatHeat, Meet, SwimEvent } from './types.js';

/**
 * Flatten a meet's events/heats into program order. Events run in numeric
 * order and heats run in numeric order within an event; the flat index is
 * what "races away" is measured against.
 */
export function flatHeats(meet: Meet): FlatHeat[] {
  const events = [...meet.events].sort((a, b) => a.number - b.number);
  const out: FlatHeat[] = [];
  for (const ev of events) {
    const heats = [...ev.heats].sort((a, b) => a.number - b.number);
    for (const heat of heats) {
      out.push({
        index: out.length,
        eventNumber: ev.number,
        eventName: ev.name,
        heatNumber: heat.number,
        heat,
      });
    }
  }
  return out;
}

/** The heat currently behind the blocks, or null before the meet starts / after it ends. */
export function currentHeat(meet: Meet): FlatHeat | null {
  if (meet.currentHeatIndex < 0) return null;
  return flatHeats(meet)[meet.currentHeatIndex] ?? null;
}

/** Advance the meet to the next heat. Returns the new current heat (null if the meet is over). */
export function advance(meet: Meet): FlatHeat | null {
  const flat = flatHeats(meet);
  if (meet.currentHeatIndex < flat.length) meet.currentHeatIndex += 1;
  return flat[meet.currentHeatIndex] ?? null;
}

/** Jump the meet position to a specific event/heat (deck referees skip and reorder all the time). */
export function setPosition(meet: Meet, eventNumber: number, heatNumber: number): FlatHeat {
  const flat = flatHeats(meet);
  const target = flat.find((f) => f.eventNumber === eventNumber && f.heatNumber === heatNumber);
  if (!target) {
    throw new Error(`No heat found for event ${eventNumber} heat ${heatNumber}`);
  }
  meet.currentHeatIndex = target.index;
  return target;
}

/** Locate a heat by event/heat number, throwing on bad references. */
export function findHeat(meet: Meet, eventNumber: number, heatNumber: number): FlatHeat {
  const found = flatHeats(meet).find(
    (f) => f.eventNumber === eventNumber && f.heatNumber === heatNumber,
  );
  if (!found) throw new Error(`No heat found for event ${eventNumber} heat ${heatNumber}`);
  return found;
}

/**
 * All upcoming swims for a swimmer: entries in heats at or after the current
 * position, annotated with how many races away they are (0 = up right now).
 */
export function upcomingSwims(
  meet: Meet,
  swimmerId: string,
): Array<{ flat: FlatHeat; lane: number; racesAway: number }> {
  const from = Math.max(meet.currentHeatIndex, 0);
  const out: Array<{ flat: FlatHeat; lane: number; racesAway: number }> = [];
  for (const flat of flatHeats(meet)) {
    if (flat.index < from) continue;
    const entry = flat.heat.entries.find((e) => e.swimmerId === swimmerId);
    if (entry) out.push({ flat, lane: entry.lane, racesAway: flat.index - from });
  }
  return out;
}

/** Basic structural validation for imported meet programs. */
export function validateProgram(events: SwimEvent[], laneCount: number): void {
  for (const ev of events) {
    for (const heat of ev.heats) {
      const seen = new Set<number>();
      for (const entry of heat.entries) {
        if (entry.lane < 1 || entry.lane > laneCount) {
          throw new Error(
            `Event ${ev.number} heat ${heat.number}: lane ${entry.lane} outside 1..${laneCount}`,
          );
        }
        if (seen.has(entry.lane)) {
          throw new Error(`Event ${ev.number} heat ${heat.number}: duplicate lane ${entry.lane}`);
        }
        seen.add(entry.lane);
      }
    }
  }
}
