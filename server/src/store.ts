import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CameraRegistration, Clip, Follow, Meet, Swimmer } from './types.js';

interface StoreData {
  meets: Meet[];
  swimmers: Swimmer[];
  follows: Follow[];
  cameras: CameraRegistration[];
  clips: Clip[];
}

/**
 * In-memory store with optional JSON-file persistence. Deliberately
 * dependency-free so the server runs anywhere; swap for Postgres/SQLite
 * behind this same interface when the deployment grows up.
 */
export class Store {
  meets = new Map<string, Meet>();
  swimmers = new Map<string, Swimmer>();
  follows = new Map<string, Follow>();
  cameras = new Map<string, CameraRegistration>();
  clips = new Map<string, Clip>();

  constructor(private filePath?: string) {
    if (filePath && existsSync(filePath)) this.load(filePath);
  }

  newId(): string {
    return randomUUID();
  }

  /** Find or create a swimmer by name+team so meet imports dedupe naturally. */
  upsertSwimmer(name: string, team?: string, age?: number): Swimmer {
    for (const s of this.swimmers.values()) {
      if (s.name === name && (s.team ?? '') === (team ?? '')) return s;
    }
    const swimmer: Swimmer = { id: this.newId(), name, team, age };
    this.swimmers.set(swimmer.id, swimmer);
    return swimmer;
  }

  camerasForMeet(meetId: string): CameraRegistration[] {
    return [...this.cameras.values()].filter((c) => c.meetId === meetId);
  }

  clipsForMeet(meetId: string): Clip[] {
    return [...this.clips.values()].filter((c) => c.meetId === meetId);
  }

  persist(): void {
    if (!this.filePath) return;
    const data: StoreData = {
      meets: [...this.meets.values()],
      swimmers: [...this.swimmers.values()],
      follows: [...this.follows.values()],
      cameras: [...this.cameras.values()],
      clips: [...this.clips.values()],
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(data, null, 2));
  }

  private load(path: string): void {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoreData;
    for (const m of data.meets ?? []) this.meets.set(m.id, m);
    for (const s of data.swimmers ?? []) this.swimmers.set(s.id, s);
    for (const f of data.follows ?? []) this.follows.set(f.id, f);
    for (const c of data.cameras ?? []) this.cameras.set(c.deviceId, c);
    for (const c of data.clips ?? []) this.clips.set(c.id, c);
  }
}
