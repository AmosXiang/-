import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type FfprobeCommandSource = 'FFPROBE_PATH' | 'FFMPEG_PATH_SIBLING' | 'PATH';

export type FfprobeCommandResolution = {
  command: string;
  source: FfprobeCommandSource;
  warning: string | null;
};

export type VideoProbeResult = {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
};

export type FfprobeAvailability = {
  available: boolean;
  errorCode: string | null;
};

type ResolveFfprobeCommandOptions = {
  ffprobePath?: string | null;
  ffmpegPath?: string | null;
  fileExists?: (candidate: string) => boolean;
};

function configuredPathWarning(command: string, fileExists: (candidate: string) => boolean): string | null {
  const looksLikePath = path.isAbsolute(command) || command.includes('/') || command.includes('\\');
  if (!looksLikePath || fileExists(command)) return null;
  return 'FFPROBE_PATH points to a file that does not exist; startup self-check will disable video metadata probing.';
}

export function resolveFfprobeCommand({
  ffprobePath,
  ffmpegPath,
  fileExists = fs.existsSync,
}: ResolveFfprobeCommandOptions): FfprobeCommandResolution {
  const explicit = ffprobePath?.trim();
  if (explicit) {
    return {
      command: explicit,
      source: 'FFPROBE_PATH',
      warning: configuredPathWarning(explicit, fileExists),
    };
  }

  const configuredFfmpeg = ffmpegPath?.trim();
  if (configuredFfmpeg) {
    const ffmpegBasename = path.basename(configuredFfmpeg);
    const ffprobeBasename = ffmpegBasename.replace(/^ffmpeg/i, 'ffprobe');
    const sibling = path.join(path.dirname(configuredFfmpeg), ffprobeBasename);
    if (ffprobeBasename !== ffmpegBasename && fileExists(sibling)) {
      return { command: sibling, source: 'FFMPEG_PATH_SIBLING', warning: null };
    }

    return {
      command: 'ffprobe',
      source: 'PATH',
      warning: 'No ffprobe sibling exists beside FFMPEG_PATH; falling back to ffprobe on PATH.',
    };
  }

  return { command: 'ffprobe', source: 'PATH', warning: null };
}

export function checkFfprobeAvailability(
  command: string,
  execute: typeof execFileSync = execFileSync,
): FfprobeAvailability {
  try {
    execute(command, ['-version'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    return { available: true, errorCode: null };
  } catch (error: any) {
    return {
      available: false,
      errorCode: String(error?.code || error?.status || error?.name || 'unknown'),
    };
  }
}

function parseFrameRate(value: unknown): number {
  const raw = String(value ?? '').trim();
  if (!raw) return NaN;
  const ratio = raw.split('/');
  if (ratio.length === 2) {
    const numerator = Number(ratio[0]);
    const denominator = Number(ratio[1]);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
      ? numerator / denominator
      : NaN;
  }
  return Number(raw);
}

export function parseFfprobeOutput(output: string): VideoProbeResult | null {
  try {
    const stream = JSON.parse(output)?.streams?.[0];
    if (!stream) return null;
    const width = Number(stream.width);
    const height = Number(stream.height);
    const fps = parseFrameRate(stream.r_frame_rate);
    const durationSec = Number(stream.duration);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null;
    if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(durationSec) || durationSec < 0) return null;
    return { width, height, fps, durationSec };
  } catch {
    return null;
  }
}
