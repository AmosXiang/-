import assert from 'node:assert/strict';
import test from 'node:test';
import type { Shot } from '../types.ts';
import {
  buildAnimaticPlaylist,
  elapsedToShot,
  nextIndex,
  previousIndex,
} from './animaticPlaylist.ts';

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    timestamp: '00:00',
    timeSeconds: 0,
    movement: 'static',
    composition: 'medium',
    emotion: 'calm',
    description: 'Test shot',
    ...overrides,
  };
}

test('buildAnimaticPlaylist applies the finalized/generated/source image priority', () => {
  const items = buildAnimaticPlaylist([
    shot({ id: 'final', finalizedImageUrl: '/final.png', generatedImageUrl: '/generated.png', imageUrl: '/source.png' }),
    shot({ id: 'generated', generatedImageUrl: '/generated.png', imageUrl: '/source.png' }),
    shot({ id: 'source', imageUrl: '/source.png' }),
    shot({ id: 'empty' }),
  ]);

  assert.deepEqual(items.map(item => item.imageUrl), ['/final.png', '/generated.png', '/source.png', undefined]);
});

test('buildAnimaticPlaylist preserves positive duration and falls back to three seconds', () => {
  const items = buildAnimaticPlaylist([
    shot({ id: 'valid', durationSec: 4.5 }),
    shot({ id: 'missing', durationSec: undefined }),
    shot({ id: 'zero', durationSec: 0 }),
    shot({ id: 'negative', durationSec: -2 }),
    shot({ id: 'nan', durationSec: Number.NaN }),
  ]);

  assert.deepEqual(items.map(item => item.durationSec), [4.5, 3, 3, 3, 3]);
});

test('buildAnimaticPlaylist skips shots without an id', () => {
  assert.deepEqual(buildAnimaticPlaylist([shot({ id: undefined }), shot({ id: 'kept' })]).map(item => item.shotId), ['kept']);
});

test('buildAnimaticPlaylist never forwards the legacy shot videoUrl', () => {
  const [item] = buildAnimaticPlaylist([shot({ videoUrl: '/legacy-kling.mp4' })]);
  assert.equal(item.videoUrl, undefined);
  assert.ok(!Object.hasOwn(item, 'videoUrl'));
});

test('buildAnimaticPlaylist accepts an empty array', () => {
  assert.deepEqual(buildAnimaticPlaylist([]), []);
});

test('nextIndex and previousIndex clamp at playlist boundaries', () => {
  assert.equal(nextIndex(0, 3), 1);
  assert.equal(nextIndex(2, 3), 2);
  assert.equal(nextIndex(0, 0), 0);
  assert.equal(previousIndex(2, 3), 1);
  assert.equal(previousIndex(0, 3), 0);
  assert.equal(previousIndex(0, 0), 0);
});

test('elapsedToShot maps total elapsed time to weighted playlist segments', () => {
  const items = [
    { shotId: 'one', durationSec: 2 },
    { shotId: 'two', durationSec: 5 },
    { shotId: 'three', durationSec: 3 },
  ];

  assert.deepEqual(elapsedToShot(items, -1), { index: 0, elapsedSec: 0 });
  assert.deepEqual(elapsedToShot(items, 1.5), { index: 0, elapsedSec: 1.5 });
  assert.deepEqual(elapsedToShot(items, 2), { index: 1, elapsedSec: 0 });
  assert.deepEqual(elapsedToShot(items, 8), { index: 2, elapsedSec: 1 });
  assert.deepEqual(elapsedToShot(items, 99), { index: 2, elapsedSec: 3 });
  assert.deepEqual(elapsedToShot([], 2), { index: 0, elapsedSec: 0 });
});
