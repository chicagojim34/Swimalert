/** Core domain types shared across the Swimalert server. */

export interface Swimmer {
  id: string;
  name: string;
  team?: string;
  age?: number;
}

/** One swimmer's entry in a heat, tied to a lane. */
export interface Entry {
  swimmerId: string;
  lane: number;
  seedTime?: string;
}

export interface Heat {
  number: number;
  entries: Entry[];
  /** Server-clock timestamp (ms) of the starting horn, once fired. */
  hornTs?: number;
  /** Server-clock touch timestamps (ms) keyed by lane number. */
  touches: Record<number, number>;
}

export interface SwimEvent {
  number: number;
  name: string;
  heats: Heat[];
}

export interface Meet {
  id: string;
  name: string;
  date?: string;
  /** Number of lanes in the pool (default 8). */
  laneCount: number;
  events: SwimEvent[];
  /**
   * Index into the flattened heat order (see flatHeats). -1 means the meet
   * has not started yet; the first heat becomes current at index 0.
   */
  currentHeatIndex: number;
}

/** A parent following a swimmer for "you're up soon" alerts. */
export interface Follow {
  id: string;
  swimmerId: string;
  /** Expo push token (or any opaque token the push sender understands). */
  deviceToken: string;
  /** Alert when the swimmer is this many races (heats) away or closer. */
  racesBefore: number;
  /** Keys of entries already alerted, to avoid duplicate pushes. */
  alertedKeys: string[];
}

export type CameraKind = 'phone' | 'mtp';

/** A camera (phone or MTP capture station) assigned to a lane for a meet. */
export interface CameraRegistration {
  deviceId: string;
  meetId: string;
  lane: number;
  kind: CameraKind;
  label?: string;
  /** Client-estimated clock offset vs server (ms), reported after timesync. */
  clockOffsetMs?: number;
  registeredAt: number;
}

/** Metadata for a recorded clip (video files live on the capture device or blob storage). */
export interface Clip {
  id: string;
  meetId: string;
  eventNumber: number;
  heatNumber: number;
  lane: number;
  swimmerId?: string;
  deviceId: string;
  /** Server-clock window the clip covers. */
  startTs: number;
  endTs: number;
  /** Where the video can be fetched from (device-local path or upload URL). */
  uri?: string;
  /** Unofficial horn-to-touch time in ms, if timing was captured. */
  unofficialMs?: number;
  createdAt: number;
}

/** A heat in flattened program order, used for races-away math. */
export interface FlatHeat {
  index: number;
  eventNumber: number;
  eventName: string;
  heatNumber: number;
  heat: Heat;
}

export interface AlertMessage {
  followId: string;
  deviceToken: string;
  swimmerId: string;
  swimmerName: string;
  meetId: string;
  eventNumber: number;
  eventName: string;
  heatNumber: number;
  lane: number;
  racesAway: number;
  title: string;
  body: string;
}
