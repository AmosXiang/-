import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { applyShotRecipeRecords, buildRecipeFingerprint } from './recipeFingerprint.ts';

const base = {
  provider: 'comfyui_local',
  model: 'flux2-klein-4b.safetensors',
  workflowPresetId: '01_klein_character_master',
  styleContractVersion: 3,
  styleAnchorVersion: 2,
  params: { width: 1024, height: 1024, steps: 20, cfg: 5, loraStrength: 0.654 },
};

test('same recipe is stable across calls and object key order', () => {
  const first = buildRecipeFingerprint(base);
  const second = buildRecipeFingerprint({
    ...base,
    params: { loraStrength: 0.654, cfg: 5, steps: 20, height: 1024, width: 1024 },
  });
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint.length, 16);
  assert.deepEqual(first.params, { cfg: 5, height: 1024, loraStrength: 0.65, steps: 20, width: 1024 });
});

test('same recipe hash is stable across independent Node processes', () => {
  const source = `import('./server/providers/imageGen/recipeFingerprint.ts').then(m=>process.stdout.write(m.buildRecipeFingerprint(${JSON.stringify(base)}).fingerprint))`;
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--eval', source], {
    cwd: process.cwd(), encoding: 'utf8', windowsHide: true,
  });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /^[0-9a-f]{16}$/);
});

test('prompt, seed, request id and timestamps never affect the recipe fingerprint', () => {
  const first = buildRecipeFingerprint({ ...base, prompt: 'shot A', seed: 1, requestId: 'a', timestamp: '2026-01-01' });
  const second = buildRecipeFingerprint({ ...base, prompt: 'shot B', seed: 999, requestId: 'b', timestamp: '2027-01-01' });
  assert.equal(first.fingerprint, second.fingerprint);
});

test('every visual recipe field changes the fingerprint', () => {
  const fingerprint = buildRecipeFingerprint(base).fingerprint;
  const variants = [
    { ...base, provider: 'agnes' },
    { ...base, model: 'other-model' },
    { ...base, workflowPresetId: 'other-preset' },
    { ...base, styleContractVersion: 4 },
    { ...base, styleAnchorVersion: 3 },
    { ...base, params: { ...base.params, width: 1280 } },
    { ...base, params: { ...base.params, loraStrength: 0.7 } },
  ];
  for (const variant of variants) assert.notEqual(buildRecipeFingerprint(variant).fingerprint, fingerprint);
});

test('explicit null and missing optional recipe facts remain distinct', () => {
  const missingPreset = buildRecipeFingerprint({ ...base, workflowPresetId: undefined });
  const nullPreset = buildRecipeFingerprint({ ...base, workflowPresetId: null });
  const missingAnchor = buildRecipeFingerprint({ ...base, styleAnchorVersion: undefined });
  const nullAnchor = buildRecipeFingerprint({ ...base, styleAnchorVersion: null });
  assert.notEqual(missingPreset.fingerprint, nullPreset.fingerprint);
  assert.notEqual(missingAnchor.fingerprint, nullAnchor.fingerprint);
});

test('ComfyUI recipe stamping changes only shot provenance, not workflow snapshots', () => {
  const workflow = { '1': { class_type: 'KSampler', inputs: { steps: 20, cfg: 5, seed: 123 } } };
  const before = JSON.stringify(workflow);
  const store: any = { generated_scripts: [{ id: 'p1', newShots: [{ id: 's1' }, { id: 's2' }] }] };
  const recipe = buildRecipeFingerprint(base);
  const updated = applyShotRecipeRecords(store, 'p1', [{ shotId: 's1', recipe, styleAnchorVersion: 2 }]);
  assert.equal(updated, 1);
  assert.deepEqual(store.generated_scripts[0].newShots[0].gen_recipe, recipe);
  assert.equal(store.generated_scripts[0].newShots[0].gen_style_anchor_version, 2);
  assert.equal(JSON.stringify(workflow), before);

  applyShotRecipeRecords(store, 'p1', [{ shotId: 's1', recipe: { ...recipe, styleAnchorVersion: null }, styleAnchorVersion: null }]);
  assert.equal('gen_style_anchor_version' in store.generated_scripts[0].newShots[0], false);
});
