import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ImageGenRouter } from './router.ts';

const router = new ImageGenRouter(path.resolve('config/imageGenRouting.json'));

test('routing order is master, character, then Agnes', () => {
  assert.deepEqual(router.route({ isMaster: true, hasCharacter: true }), { provider: 'comfyui_local', reason: 'master_frame_local' });
  assert.deepEqual(router.route({ isMaster: false, hasCharacter: true }), { provider: 'comfyui_local', reason: 'has_character_local' });
  assert.deepEqual(router.route({ isMaster: false, hasCharacter: false }), { provider: 'agnes', reason: 'default_agnes' });
  assert.deepEqual(router.route({ isMaster: true, hasCharacter: true, forceProvider: 'agnes' }), { provider: 'agnes', reason: 'forced' });
});
