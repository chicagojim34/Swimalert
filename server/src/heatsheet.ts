import type { SwimEvent } from './types.js';

/**
 * CSV heat-sheet import. Meet Manager, Team Unify, and plain spreadsheets can
 * all produce a flat "one row per entry" CSV; this maps it into the meet
 * program model. Column headers are matched case-insensitively against
 * common aliases, so "Event #", "event", and "Ev" all work.
 *
 * Required columns: event, heat, lane, swimmer name.
 * Optional: event name, team, seed time, age.
 */

export interface ProgramEntryInput {
  swimmer: { name: string; team?: string; age?: number };
  lane: number;
  seedTime?: string;
}

export interface ProgramEventInput {
  number: number;
  name: string;
  heats: Array<{ number: number; entries: ProgramEntryInput[] }>;
}

const HEADER_ALIASES: Record<string, string[]> = {
  event: ['event', 'event#', 'event #', 'ev', 'event number', 'event_number', 'eventnum'],
  eventName: ['event name', 'eventname', 'event_name', 'description', 'stroke', 'race'],
  heat: ['heat', 'ht', 'heat #', 'heat number'],
  lane: ['lane', 'ln', 'lane #'],
  name: ['swimmer', 'name', 'athlete', 'swimmer name', 'athlete name'],
  team: ['team', 'club', 'squad'],
  seedTime: ['seed', 'seed time', 'seedtime', 'seed_time', 'entry time'],
  age: ['age'],
};

/** Minimal RFC-4180-ish CSV parser: quoted fields, embedded commas/quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully blank rows (trailing newlines, spacer lines).
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function mapHeaders(headerRow: string[]): Map<string, number> {
  const mapped = new Map<string, number>();
  headerRow.forEach((raw, idx) => {
    const key = raw.trim().toLowerCase();
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(key) && !mapped.has(canonical)) mapped.set(canonical, idx);
    }
  });
  return mapped;
}

/** Parse a heat-sheet CSV into meet program events. Throws with row numbers on bad data. */
export function parseHeatSheetCsv(text: string): ProgramEventInput[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('CSV needs a header row and at least one entry row');

  const cols = mapHeaders(rows[0]);
  for (const required of ['event', 'heat', 'lane', 'name'] as const) {
    if (!cols.has(required)) {
      throw new Error(
        `CSV is missing a "${required}" column (accepted headers: ${HEADER_ALIASES[required].join(', ')})`,
      );
    }
  }

  const cell = (row: string[], key: string): string => {
    const idx = cols.get(key);
    return idx === undefined ? '' : (row[idx] ?? '').trim();
  };

  const events = new Map<number, ProgramEventInput>();

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const rowNum = r + 1;
    const eventNumber = Number(cell(row, 'event'));
    const heatNumber = Number(cell(row, 'heat'));
    const lane = Number(cell(row, 'lane'));
    const name = cell(row, 'name');
    if (!Number.isInteger(eventNumber) || eventNumber < 1) {
      throw new Error(`Row ${rowNum}: bad event number "${cell(row, 'event')}"`);
    }
    if (!Number.isInteger(heatNumber) || heatNumber < 1) {
      throw new Error(`Row ${rowNum}: bad heat number "${cell(row, 'heat')}"`);
    }
    if (!Number.isInteger(lane) || lane < 1) {
      throw new Error(`Row ${rowNum}: bad lane "${cell(row, 'lane')}"`);
    }
    if (!name) throw new Error(`Row ${rowNum}: missing swimmer name`);

    let event = events.get(eventNumber);
    if (!event) {
      event = { number: eventNumber, name: cell(row, 'eventName') || `Event ${eventNumber}`, heats: [] };
      events.set(eventNumber, event);
    } else if (event.name.startsWith('Event ') && cell(row, 'eventName')) {
      event.name = cell(row, 'eventName'); // later row supplied the real name
    }

    let heat = event.heats.find((h) => h.number === heatNumber);
    if (!heat) {
      heat = { number: heatNumber, entries: [] };
      event.heats.push(heat);
    }

    const ageRaw = cell(row, 'age');
    heat.entries.push({
      swimmer: {
        name,
        team: cell(row, 'team') || undefined,
        age: ageRaw ? Number(ageRaw) : undefined,
      },
      lane,
      seedTime: cell(row, 'seedTime') || undefined,
    });
  }

  return [...events.values()].sort((a, b) => a.number - b.number);
}
