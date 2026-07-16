import crypto from 'node:crypto';

import type { GenerationModes, VideoProviderCapability } from './capability.ts';

export type VideoGenerationMode = keyof GenerationModes;
export type MotionStrength = 'static' | 'natural' | 'extreme';
export type AspectAdaptMode = 'crop' | 'letterbox';

export type MotionPrompt = {
  subjectScene: string;
  action?: string;
  cameraMove?: string;
  environment?: string;
  continuity?: string;
  prohibitions?: string;
};

export type AspectDecision = {
  aspectRatio: string;
  adaptMode: AspectAdaptMode;
};

export type ResolvedVideoAspect = {
  projectAspect: string;
  effectiveAspectRatio: string;
  source: 'style_contract' | 'user_adaptation';
  adaptMode?: AspectAdaptMode;
};

export type ValidatedVideoParameters = {
  mode: VideoGenerationMode;
  durationSec: number;
  fps: number;
  resolution: string;
  width: number;
  height: number;
  numFrames: number;
  motionPrompt: MotionPrompt;
  motionStrength: MotionStrength;
  negativePrompt?: string;
  seed: number;
};

export type VideoGenerationSnapshot = {
  schemaVersion: 1;
  provider: string;
  mode: VideoGenerationMode;
  parameters: {
    durationSec: number;
    fps: number;
    resolution: string;
    width: number;
    height: number;
    numFrames: number;
    motionStrength: MotionStrength;
    negativePrompt?: string;
  };
  aspect: ResolvedVideoAspect;
  motionPrompt: MotionPrompt;
  prompt: string;
  seed: number;
  styleContractVersion: number;
};

export const VIDEO_DURATION_FRAMES: Record<number, number> = {
  3: 81,
  5: 121,
  10: 241,
  18: 441,
};

export const MOTION_STRENGTH_PHRASES: Record<MotionStrength, string> = {
  static: 'locked-off composition with minimal motion',
  natural: 'natural, restrained motion',
  extreme: 'dynamic, high-intensity motion',
};

export class VideoLabError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'VideoLabError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(source: Record<string, unknown>, field: keyof MotionPrompt): string | undefined {
  const value = source[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new VideoLabError(422, `${field} must be a string.`, 'MOTION_PROMPT_INVALID', { field });
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseMotionPrompt(value: unknown): MotionPrompt {
  if (!isObject(value)) {
    throw new VideoLabError(422, 'motionPrompt must be an object.', 'MOTION_PROMPT_INVALID');
  }
  const subjectScene = optionalText(value, 'subjectScene');
  if (!subjectScene) {
    throw new VideoLabError(422, 'motionPrompt.subjectScene must not be empty.', 'SUBJECT_SCENE_REQUIRED', {
      field: 'subjectScene',
    });
  }
  const result: MotionPrompt = { subjectScene };
  for (const field of ['action', 'cameraMove', 'environment', 'continuity', 'prohibitions'] as const) {
    const text = optionalText(value, field);
    if (text) result[field] = text;
  }
  return result;
}

function parseResolution(value: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new VideoLabError(422, 'resolution must use WIDTHxHEIGHT format.', 'PARAM_OUT_OF_CAPABILITY', {
      parameter: 'resolution',
      value,
    });
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function assertCapabilityValue<T extends string | number>(
  parameter: string,
  value: unknown,
  allowed: T[],
): T {
  if (!allowed.includes(value as T)) {
    throw new VideoLabError(422, `${parameter} is outside the selected provider capability.`, 'PARAM_OUT_OF_CAPABILITY', {
      parameter,
      value,
      allowed,
    });
  }
  return value as T;
}

export function assertModeSupported(
  capability: VideoProviderCapability,
  value: unknown,
): VideoGenerationMode {
  const mode = String(value || '') as VideoGenerationMode;
  if (!Object.hasOwn(capability.supportedModes, mode) || capability.supportedModes[mode] !== true) {
    throw new VideoLabError(422, `Mode '${mode || '(empty)'}' is not supported by ${capability.id}.`, 'MODE_UNSUPPORTED', {
      supportedModes: capability.supportedModes,
    });
  }
  return mode;
}

export function createVideoSeed(): number {
  return Number(BigInt(`0x${crypto.randomBytes(8).toString('hex')}`) % 9_007_199_254_740_991n);
}

export function validateVideoParameters(
  body: Record<string, unknown>,
  capability: VideoProviderCapability,
): ValidatedVideoParameters {
  const mode = assertModeSupported(capability, body.mode);
  const durationSec = assertCapabilityValue('durationSec', body.durationSec, capability.durations);
  const fps = assertCapabilityValue('fps', body.fps, capability.fpsOptions);
  const resolution = assertCapabilityValue('resolution', body.resolution, capability.resolutions);
  const { width, height } = parseResolution(resolution);
  const numFrames = VIDEO_DURATION_FRAMES[durationSec];
  if (!numFrames) {
    throw new VideoLabError(422, 'durationSec has no frame mapping in the M1 pipeline.', 'PARAM_OUT_OF_CAPABILITY', {
      parameter: 'durationSec',
      value: durationSec,
      allowed: Object.keys(VIDEO_DURATION_FRAMES).map(Number),
    });
  }

  const motionStrength = String(body.motionStrength || '') as MotionStrength;
  if (!Object.hasOwn(MOTION_STRENGTH_PHRASES, motionStrength)) {
    throw new VideoLabError(422, 'motionStrength must be static, natural, or extreme.', 'MOTION_STRENGTH_INVALID', {
      allowed: Object.keys(MOTION_STRENGTH_PHRASES),
    });
  }

  let negativePrompt: string | undefined;
  if (body.negativePrompt !== undefined && body.negativePrompt !== null && body.negativePrompt !== '') {
    if (typeof body.negativePrompt !== 'string') {
      throw new VideoLabError(422, 'negativePrompt must be a string.', 'NEGATIVE_PROMPT_INVALID');
    }
    negativePrompt = body.negativePrompt.trim() || undefined;
  }

  const seed = body.seed === undefined || body.seed === null || body.seed === ''
    ? createVideoSeed()
    : body.seed;
  if (typeof seed !== 'number' || !Number.isSafeInteger(seed) || seed < 0) {
    throw new VideoLabError(422, 'seed must be a non-negative safe integer.', 'SEED_INVALID');
  }

  return {
    mode,
    durationSec,
    fps,
    resolution,
    width,
    height,
    numFrames,
    motionPrompt: parseMotionPrompt(body.motionPrompt),
    motionStrength,
    ...(negativePrompt ? { negativePrompt } : {}),
    seed,
  };
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b > 0) [a, b] = [b, a % b];
  return a;
}

export function aspectRatioFromDimensions(width: number, height: number): string {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new VideoLabError(422, 'Style contract dimensions cannot form an aspect ratio.', 'STYLE_CONTRACT_ASPECT_INVALID', {
      width,
      height,
    });
  }
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

export function resolveVideoAspect(
  projectAspect: string,
  capability: VideoProviderCapability,
  value: unknown,
): ResolvedVideoAspect {
  if (capability.aspectRatios.includes(projectAspect)) {
    return {
      projectAspect,
      effectiveAspectRatio: projectAspect,
      source: 'style_contract',
    };
  }

  if (value === undefined || value === null) {
    throw new VideoLabError(409, 'The selected provider does not support the project aspect ratio.', 'ASPECT_UNSUPPORTED', {
      projectAspect,
      supportedAspectRatios: capability.aspectRatios,
    });
  }
  if (!isObject(value)) {
    throw new VideoLabError(422, 'aspectDecision must be an object.', 'ASPECT_DECISION_INVALID');
  }
  const aspectRatio = String(value.aspectRatio || '');
  const adaptMode = String(value.adaptMode || '') as AspectAdaptMode;
  if (!capability.aspectRatios.includes(aspectRatio) || !['crop', 'letterbox'].includes(adaptMode)) {
    throw new VideoLabError(422, 'aspectDecision must select a supported ratio and adaptation mode.', 'ASPECT_DECISION_INVALID', {
      supportedAspectRatios: capability.aspectRatios,
      allowedAdaptModes: ['crop', 'letterbox'],
    });
  }
  return {
    projectAspect,
    effectiveAspectRatio: aspectRatio,
    source: 'user_adaptation',
    adaptMode,
  };
}

export function assembleVideoPrompt(motionPrompt: MotionPrompt, motionStrength: MotionStrength): string {
  return [
    `Subject and scene: ${motionPrompt.subjectScene}`,
    motionPrompt.action ? `Action: ${motionPrompt.action}` : '',
    `Motion intensity: ${MOTION_STRENGTH_PHRASES[motionStrength]}`,
    motionPrompt.cameraMove ? `Camera movement: ${motionPrompt.cameraMove}` : '',
    motionPrompt.environment ? `Environment motion: ${motionPrompt.environment}` : '',
    motionPrompt.continuity ? `Continuity constraints: ${motionPrompt.continuity}` : '',
    motionPrompt.prohibitions ? `Prohibited changes: ${motionPrompt.prohibitions}` : '',
  ].filter(Boolean).join('\n');
}

export function buildVideoGenerationSnapshot(input: {
  provider: string;
  parameters: ValidatedVideoParameters;
  aspect: ResolvedVideoAspect;
  prompt: string;
  styleContractVersion: number;
}): VideoGenerationSnapshot {
  const { parameters } = input;
  return {
    schemaVersion: 1,
    provider: input.provider,
    mode: parameters.mode,
    parameters: {
      durationSec: parameters.durationSec,
      fps: parameters.fps,
      resolution: parameters.resolution,
      width: parameters.width,
      height: parameters.height,
      numFrames: parameters.numFrames,
      motionStrength: parameters.motionStrength,
      ...(parameters.negativePrompt ? { negativePrompt: parameters.negativePrompt } : {}),
    },
    aspect: { ...input.aspect },
    motionPrompt: { ...parameters.motionPrompt },
    prompt: input.prompt,
    seed: parameters.seed,
    styleContractVersion: input.styleContractVersion,
  };
}
