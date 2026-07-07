import type { Heat, Meet, Swimmer } from '../src/types.js';

let nextId = 0;
export function swimmer(name: string, team = 'DOLPHINS'): Swimmer {
  return { id: `sw-${nextId++}-${name}`, name, team };
}

export function heat(number: number, entries: Array<[Swimmer, number]>): Heat {
  return {
    number,
    entries: entries.map(([s, lane]) => ({ swimmerId: s.id, lane })),
    touches: {},
  };
}

/**
 * A small two-event meet:
 *   Event 1 "50 Free"  — heats 1, 2
 *   Event 2 "100 Back" — heats 1, 2, 3
 * Flat order: [E1H1, E1H2, E2H1, E2H2, E2H3] (indexes 0..4)
 */
export function sampleMeet(swimmers: {
  emma: Swimmer;
  liam: Swimmer;
  ava: Swimmer;
}): Meet {
  return {
    id: 'meet-1',
    name: 'City Invitational',
    laneCount: 8,
    currentHeatIndex: -1,
    events: [
      {
        number: 1,
        name: '50 Free',
        heats: [
          heat(1, [[swimmers.liam, 4]]),
          heat(2, [[swimmers.emma, 3]]),
        ],
      },
      {
        number: 2,
        name: '100 Back',
        heats: [
          heat(1, [[swimmers.ava, 5]]),
          heat(2, []),
          heat(3, [[swimmers.emma, 6]]),
        ],
      },
    ],
  };
}
