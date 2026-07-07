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

export type CameraKind = 'phone' | 'mtp' | 'wide';

/**
 * A crop region within a camera's frame, normalized 0..1 (so it works at any
 * resolution). Used to cut a per-lane view out of a single wide shot —
 * the soccer-camera model applied to a pool.
 */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A camera assigned to one or more lanes for a meet. A phone on the fence
 * covers one lane; a wide end-of-pool camera covers all of them, with a
 * per-lane crop for digital zoom.
 */
export interface CameraRegistration {
  deviceId: string;
  meetId: string;
  lanes: number[];
  kind: CameraKind;
  label?: string;
  /** Per-lane crop regions within this camera's frame (omit for full frame). */
  crops?: Record<number, CropRect>;
  /** Client-estimated clock offset vs server (ms), reported after timesync. */
  clockOffsetMs?: number;
  registeredAt: number;
}

/** A continuous source recording uploaded/registered by a camera; clips are cut from these. */
export interface SourceVideo {
  id: string;
  meetId: string;
  deviceId: string;
  /** Server-clock time of the video's first frame. */
  startTs: number;
  /** Server-clock end (set when the recording stops/uploads). */
  endTs?: number;
  /** Absolute path on the server, when the file was uploaded here. */
  path?: string;
  /** External location when not uploaded (e.g. still on the capture device). */
  uri?: string;
  createdAt: number;
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
  /** Where the video can be fetched from (server route or device-local reference). */
  uri?: string;
  /** Absolute path of the generated clip file on the server, when it lives here. */
  path?: string;
  /** Source video this clip was cut from, when generated server-side. */
  sourceVideoId?: string;
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
