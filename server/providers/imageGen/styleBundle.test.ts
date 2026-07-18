import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendStyleBundleSummary,
  buildStyleBundle,
  composeAgnesPrompt,
  summarizeStyleBundle,
  type ImageStyleContext,
} from './styleBundle.ts';

const context: ImageStyleContext = {
  contractVersion: 3,
  styleOverlay: '  cinematic teal rain  ',
  sceneId: 'scene-1',
  sceneOverlay: '  wet neon station platform  ',
  width: 1280,
  height: 720,
  presetId: '01_klein_character_master',
  loraStrength: 0.65,
  styleAnchorUrl: '/uploads/style-anchors/p1-2.png',
  styleAnchorVersion: 2,
};

test('composeAgnesPrompt appends project then scene overlays after the optimized prompt', () => {
  const bundle = buildStyleBundle(context);
  const result = composeAgnesPrompt('optimized shot prompt', bundle);

  assert.equal(result.prompt, [
    'optimized shot prompt',
    'Project art direction style overlay (style only; preserve shot content and composition): cinematic teal rain',
    'Scene reference (environment only; preserve shot content, composition and characters): wet neon station platform',
  ].join('\n\n'));
  assert.deepEqual(result.injected, { style: true, scene: true });
});

test('composeAgnesPrompt uses the same includes de-duplication semantics as ComfyUI', () => {
  const bundle = buildStyleBundle(context);
  const prompt = 'optimized shot prompt with cinematic teal rain and wet neon station platform';

  assert.deepEqual(composeAgnesPrompt(prompt, bundle), {
    prompt,
    injected: { style: false, scene: false },
  });
});

test('composeAgnesPrompt omits empty overlays and is a no-op without a bundle', () => {
  const emptyBundle = buildStyleBundle({
    ...context,
    styleOverlay: ' ',
    sceneId: null,
    sceneOverlay: '',
  });

  assert.deepEqual(composeAgnesPrompt('optimized shot prompt', emptyBundle), {
    prompt: 'optimized shot prompt',
    injected: { style: false, scene: false },
  });
  assert.deepEqual(composeAgnesPrompt('optimized shot prompt', null), {
    prompt: 'optimized shot prompt',
    injected: { style: false, scene: false },
  });
});

test('version zero remains auditable and summary dimensions reflect the provider request', () => {
  const bundle = buildStyleBundle({ ...context, contractVersion: 0 });
  const composed = composeAgnesPrompt('optimized shot prompt', bundle);
  const summary = summarizeStyleBundle(bundle, composed.injected, 640, 384);

  assert.deepEqual(summary, {
    contractVersion: 0,
    sceneId: 'scene-1',
    styleOverlayLen: 'cinematic teal rain'.length,
    sceneOverlayLen: 'wet neon station platform'.length,
    width: 640,
    height: 384,
    presetId: '01_klein_character_master',
    loraStrength: 0.65,
    styleAnchorVersion: 2,
    injected: { style: true, scene: true },
  });
  assert.deepEqual(appendStyleBundleSummary({ remote_url: 'https://example.invalid/image.png' }, summary), {
    remote_url: 'https://example.invalid/image.png',
    styleBundle: summary,
  });
});
