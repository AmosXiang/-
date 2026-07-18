import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { buildRecipeFingerprint } from '../../providers/imageGen/recipeFingerprint.ts';
import { buildStyleGate } from './styleGate.ts';

function recipe(loraStrength = 0.8) {
  return buildRecipeFingerprint({
    provider: 'agnes',
    model: 'agnes-image-2.1-flash',
    workflowPresetId: null,
    styleContractVersion: 2,
    styleAnchorVersion: 3,
    params: { width: 1280, height: 720, loraStrength },
  });
}

async function solidImage(filePath: string, color: { r: number; g: number; b: number }) {
  await sharp({ create: { width: 16, height: 12, channels: 3, background: color } }).png().toFile(filePath);
}

test('missing approved recipe yields null matches and never creates recipe drift', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-gate-no-baseline-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const imagePath = path.join(tempDir, 'shot.png');
  await solidImage(imagePath, { r: 200, g: 30, b: 20 });
  const generatedRecipe = recipe();
  const shot = {
    id: 'shot-1',
    gen_recipe: generatedRecipe,
    gen_style_contract_version: 2,
    styleApproved: { approvedFingerprint: generatedRecipe.fingerprint, approvedAt: '2026-07-18T00:00:00.000Z' },
  };
  const gate = await buildStyleGate({ styleContract: { version: 2 }, newShots: [shot] }, [shot], [imagePath]);
  assert.equal(gate.approvedRecipeMissing, true);
  assert.equal(gate.details[0].recipeMatches, null);
  assert.equal(gate.details[0].anchorCurrent, true, 'no project anchor is current by definition');
  assert.equal(gate.recipeDrift, 0);
  assert.equal(gate.needsAttention, 0);

  const nullVersionShot = { ...shot, id: 'shot-null-version', gen_style_contract_version: null };
  const nullVersionGate = await buildStyleGate(
    { styleContract: { version: 0 }, newShots: [nullVersionShot] },
    [nullVersionShot],
    [imagePath],
  );
  assert.equal(nullVersionGate.details[0].contractCurrent, false, 'missing provenance never aliases legacy version zero');
});

test('style gate detects version drift, recipe drift, invalid approval, and damaged or missing images', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-gate-criteria-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const redPath = path.join(tempDir, 'red.png');
  const bluePath = path.join(tempDir, 'blue.png');
  const corruptPath = path.join(tempDir, 'corrupt.png');
  await solidImage(redPath, { r: 230, g: 20, b: 20 });
  await solidImage(bluePath, { r: 20, g: 20, b: 230 });
  fs.writeFileSync(corruptPath, 'not-an-image');

  const baseline = recipe();
  const drifted = recipe(0.65);
  const shots = [
    {
      id: 'shot-a', gen_recipe: baseline, gen_style_contract_version: 2, gen_style_anchor_version: 3,
      styleApproved: { approvedFingerprint: baseline.fingerprint, approvedAt: '2026-07-18T00:00:00.000Z' },
    },
    {
      id: 'shot-b', gen_recipe: drifted, gen_style_contract_version: 1, gen_style_anchor_version: 3,
      styleApproved: { approvedFingerprint: baseline.fingerprint, approvedAt: '2026-07-18T00:00:00.000Z' },
    },
    {
      id: 'shot-c', gen_recipe: baseline, gen_style_contract_version: 2, gen_style_anchor_version: 2,
      styleApproved: { approvedFingerprint: baseline.fingerprint, approvedAt: '2026-07-18T00:00:00.000Z' },
    },
    {
      id: 'shot-d', gen_recipe: baseline, gen_style_contract_version: 2, gen_style_anchor_version: 3,
      styleApproved: { approvedFingerprint: baseline.fingerprint, approvedAt: '2026-07-18T00:00:00.000Z' },
    },
  ];
  const script = {
    styleContract: { version: 2 },
    styleAnchor: { version: 3 },
    approvedRecipe: {
      fingerprint: baseline.fingerprint,
      recipe: baseline,
      setFromShotId: 'shot-a',
      setAt: '2026-07-18T00:00:00.000Z',
    },
    newShots: shots,
  };
  const gate = await buildStyleGate(script, shots, [redPath, bluePath, corruptPath, null]);
  assert.deepEqual({
    contractStale: gate.contractStale,
    anchorStale: gate.anchorStale,
    recipeDrift: gate.recipeDrift,
    undecodable: gate.undecodable,
    unapproved: gate.unapproved,
    colorOutliers: gate.colorOutliers,
    needsAttention: gate.needsAttention,
  }, {
    contractStale: 1,
    anchorStale: 1,
    recipeDrift: 1,
    undecodable: 2,
    unapproved: 1,
    colorOutliers: 1,
    needsAttention: 3,
  });
  assert.equal(gate.details[0].recipeMatches, true, 'the gate consumes the exact P1-A fingerprint');
  assert.equal(gate.details[1].recipeMatches, false);
  assert.equal(gate.details[1].styleApprovedValid, false, 'a changed fingerprint invalidates prior approval');
  assert.equal(gate.details[2].imageDecodable, false, 'corrupt local bytes fail Sharp decoding');
  assert.equal(gate.details[3].imageDecodable, false, 'missing local images fail deterministically');
});

test('color histogram outliers remain warnings and never enter hard attention counts', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-gate-color-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const redPath = path.join(tempDir, 'red.png');
  const bluePath = path.join(tempDir, 'blue.png');
  await solidImage(redPath, { r: 240, g: 10, b: 10 });
  await solidImage(bluePath, { r: 10, g: 10, b: 240 });
  const baseline = recipe();
  const approved = { approvedFingerprint: baseline.fingerprint, approvedAt: '2026-07-18T00:00:00.000Z' };
  const shots = [
    { id: 'shot-a', gen_recipe: baseline, gen_style_contract_version: 2, gen_style_anchor_version: 3, styleApproved: approved },
    { id: 'shot-b', gen_recipe: baseline, gen_style_contract_version: 2, gen_style_anchor_version: 3, styleApproved: approved },
  ];
  const gate = await buildStyleGate({
    styleContract: { version: 2 },
    styleAnchor: { version: 3 },
    approvedRecipe: { fingerprint: baseline.fingerprint, recipe: baseline, setFromShotId: 'shot-a', setAt: '' },
    newShots: shots,
  }, shots, [redPath, bluePath]);
  assert.equal(gate.colorOutliers, 1);
  assert.equal(gate.needsAttention, 0);
  assert.equal(gate.details[1].colorOutlier, true);
  assert.equal(gate.details[1].needsAttention, false);
  assert.deepEqual(gate.details[1].warnings, ['color_outlier']);
});
