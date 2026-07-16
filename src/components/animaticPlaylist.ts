import type { Shot } from '../types.ts';

export type AnimaticItem = {
  shotId: string;
  durationSec: number;
  imageUrl?: string;
  videoUrl?: string;
  finalVideoTaskId?: string;
};

export type AnimaticPosition = {
  index: number;
  elapsedSec: number;
};

const DEFAULT_DURATION_SEC = 3;

function playableDuration(durationSec: number | undefined): number {
  return typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0
    ? durationSec
    : DEFAULT_DURATION_SEC;
}

export function buildAnimaticPlaylist(shots: Shot[]): AnimaticItem[] {
  return shots.flatMap(shot => {
    if (!shot.id) return [];

    const imageUrl = shot.finalizedImageUrl ?? shot.generatedImageUrl ?? shot.imageUrl;
    const item: AnimaticItem = {
      shotId: shot.id,
      durationSec: playableDuration(shot.durationSec),
    };
    if (imageUrl !== undefined) item.imageUrl = imageUrl;

    // Intentionally do not copy legacy shot.videoUrl. A finalized video source
    // will only be supplied through the M2 AnimaticItem contract.
    return [item];
  });
}

export function nextIndex(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, current) + 1, total - 1);
}

export function previousIndex(current: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(current, total - 1) - 1);
}

export function elapsedToShot(items: AnimaticItem[], seconds: number): AnimaticPosition {
  if (items.length === 0) return { index: 0, elapsedSec: 0 };

  const totalDuration = items.reduce((sum, item) => sum + item.durationSec, 0);
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const clampedSeconds = Math.min(safeSeconds, totalDuration);
  let offset = 0;

  for (let index = 0; index < items.length; index += 1) {
    const duration = items[index].durationSec;
    if (clampedSeconds < offset + duration || index === items.length - 1) {
      return {
        index,
        elapsedSec: Math.min(duration, Math.max(0, clampedSeconds - offset)),
      };
    }
    offset += duration;
  }

  return { index: items.length - 1, elapsedSec: items[items.length - 1].durationSec };
}
