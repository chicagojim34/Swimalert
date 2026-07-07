import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ClipWindow } from './timing.js';
import type { CropRect, SourceVideo } from './types.js';

/**
 * Cuts race clips out of continuous source recordings with ffmpeg.
 *
 * The single-wide-camera model (how Veo/Pixellot cover a soccer pitch)
 * applied to a pool: one camera records the whole race, the source video
 * carries a server-clock start timestamp, and each lane's clip is a
 * time-slice (horn pre-roll → touch post-roll) plus an optional crop of
 * that lane's slice of the frame — digital zoom, no extra hardware.
 */

let ffmpegChecked: boolean | null = null;

/** True when ffmpeg is on PATH. Cached; call resetFfmpegCheck() in tests. */
export function ffmpegAvailable(): boolean {
  if (ffmpegChecked === null) {
    ffmpegChecked = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  }
  return ffmpegChecked;
}

export interface CutSpec {
  sourcePath: string;
  /** Server-clock timestamp of the source video's first frame. */
  sourceStartTs: number;
  /** Server-clock window to extract. */
  window: { startTs: number; endTs: number };
  /** Normalized crop for the lane's slice of the frame; omit for full frame. */
  crop?: CropRect;
  outPath: string;
}

/**
 * Build the ffmpeg argument list for a cut. Pure function so tests can
 * verify seek math and filters without running ffmpeg.
 */
export function buildFfmpegArgs(spec: CutSpec): string[] {
  const offsetSec = Math.max(0, (spec.window.startTs - spec.sourceStartTs) / 1000);
  const durationSec = (spec.window.endTs - Math.max(spec.window.startTs, spec.sourceStartTs)) / 1000;
  if (durationSec <= 0) throw new Error('Clip window ends before the source video starts');

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', offsetSec.toFixed(3),
    '-i', spec.sourcePath,
    '-t', durationSec.toFixed(3),
  ];

  if (spec.crop) {
    const { x, y, w, h } = spec.crop;
    for (const [name, v] of Object.entries({ x, y, w, h })) {
      if (v < 0 || v > 1 || Number.isNaN(v)) throw new Error(`Crop ${name}=${v} outside 0..1`);
    }
    // Expression-based crop works at any source resolution; round to even
    // pixel counts because H.264 requires them.
    args.push(
      '-vf',
      `crop=floor(in_w*${w}/2)*2:floor(in_h*${h}/2)*2:floor(in_w*${x}/2)*2:floor(in_h*${y}/2)*2`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-c:a', 'aac',
    );
  } else {
    // No re-frame needed: stream-copy is instant and lossless.
    args.push('-c', 'copy');
  }

  args.push('-movflags', '+faststart', '-y', spec.outPath);
  return args;
}

/** Run the cut. Resolves when the clip file is written. */
export function cutClip(spec: CutSpec): Promise<void> {
  if (!ffmpegAvailable()) {
    return Promise.reject(new Error('ffmpeg not found on PATH — install it to generate clips'));
  }
  mkdirSync(dirname(spec.outPath), { recursive: true });
  const args = buildFfmpegArgs(spec);
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/**
 * Pick the source video that best covers a clip window: it must start at or
 * before the window start, and among candidates the latest-starting one wins
 * (tightest coverage, least seeking).
 */
export function findCoveringVideo(
  videos: SourceVideo[],
  deviceIds: Set<string>,
  window: ClipWindow,
): SourceVideo | undefined {
  let best: SourceVideo | undefined;
  for (const v of videos) {
    if (!deviceIds.has(v.deviceId) || !v.path) continue;
    if (v.startTs > window.startTs) continue;
    if (v.endTs !== undefined && v.endTs < window.endTs) continue;
    if (!best || v.startTs > best.startTs) best = v;
  }
  return best;
}
