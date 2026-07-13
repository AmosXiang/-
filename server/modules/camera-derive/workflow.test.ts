import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CAMERA_DERIVE_PRESET_ID,
  CAMERA_DERIVE_WORKFLOW_FILE,
  CameraDeriveError,
  loadCameraDeriveWorkflow,
  buildCameraDeriveSnapshot,
  cameraDeriveTaskNodeMappings,
} from './workflow.ts';

function validWorkflow() {
  return {
    '10': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' }, _meta: { title: 'INPUT_master_image' } },
    '20': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { prompt: 'placeholder', clip: ['30', 0] }, _meta: { title: 'INPUT_camera_instruction' } },
    '40': { class_type: 'KSampler', inputs: { seed: 0, steps: 4 }, _meta: { title: 'INPUT_seed' } },
    '50': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2512_fp8_e4m3fn.safetensors' } },
    '90': { class_type: 'SaveImage', inputs: { images: ['60', 0] } },
  };
}

function makeBaseDir(workflow: unknown): string {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-derive-test-'));
  const filePath = path.join(baseDir, CAMERA_DERIVE_WORKFLOW_FILE);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (workflow !== undefined) fs.writeFileSync(filePath, typeof workflow === 'string' ? workflow : JSON.stringify(workflow));
  return baseDir;
}

test('missing workflow file raises 503 WORKFLOW_NOT_INSTALLED', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-derive-empty-'));
  assert.throws(
    () => loadCameraDeriveWorkflow(baseDir),
    (error: any) => error instanceof CameraDeriveError && error.status === 503 && error.code === 'WORKFLOW_NOT_INSTALLED',
  );
});

test('valid workflow resolves node mappings by title', () => {
  const bundle = loadCameraDeriveWorkflow(makeBaseDir(validWorkflow()));
  assert.deepEqual(bundle.mappings, {
    loadImageNodeId: '10',
    loadImageInputKey: 'image',
    promptNodeId: '20',
    promptInputKey: 'prompt',
    seedNodeId: '40',
    seedInputKey: 'seed',
    saveImageNodeId: '90',
  });
  assert.equal(bundle.modelName, 'qwen_image_edit_2512_fp8_e4m3fn.safetensors');
});

test('missing INPUT_ title fails loudly with the titles it saw', () => {
  const workflow = validWorkflow() as any;
  delete workflow['20']._meta;
  assert.throws(
    () => loadCameraDeriveWorkflow(makeBaseDir(workflow)),
    (error: any) => error instanceof CameraDeriveError
      && error.code === 'WORKFLOW_NODE_TITLE_MISSING'
      && error.message.includes('INPUT_camera_instruction'),
  );
});

test('duplicate INPUT_ title is rejected', () => {
  const workflow = validWorkflow() as any;
  workflow['41'] = { class_type: 'KSampler', inputs: { seed: 1 }, _meta: { title: 'INPUT_seed' } };
  assert.throws(
    () => loadCameraDeriveWorkflow(makeBaseDir(workflow)),
    (error: any) => error instanceof CameraDeriveError && error.code === 'WORKFLOW_NODE_TITLE_DUPLICATE',
  );
});

test('non-API-format export is rejected with guidance', () => {
  assert.throws(
    () => loadCameraDeriveWorkflow(makeBaseDir('[1,2,3]')),
    (error: any) => error instanceof CameraDeriveError && error.code === 'WORKFLOW_NOT_API_FORMAT',
  );
});

test('LoadImage class mismatch on INPUT_master_image is rejected', () => {
  const workflow = validWorkflow() as any;
  workflow['10'].class_type = 'LoadImageMask';
  assert.throws(
    () => loadCameraDeriveWorkflow(makeBaseDir(workflow)),
    (error: any) => error instanceof CameraDeriveError && error.code === 'WORKFLOW_NODE_CLASS_MISMATCH',
  );
});

test('snapshot injects instruction and seed without mutating the bundle', () => {
  const bundle = loadCameraDeriveWorkflow(makeBaseDir(validWorkflow()));
  const instruction = 'Rotate the camera to the back view, eye-level shot, medium shot.\n'
    + "Keep the character's identity, outfit, pose intent, lighting, props and set unchanged.";
  const snapshot = buildCameraDeriveSnapshot(bundle, instruction, 12345);
  assert.equal(snapshot['20'].inputs!.prompt, instruction);
  assert.equal(snapshot['40'].inputs!.seed, 12345);
  // 原 bundle 不被污染
  assert.equal(bundle.workflow['20'].inputs!.prompt, 'placeholder');
  assert.equal(bundle.workflow['40'].inputs!.seed, 0);
  // 同参数重复构建字节级一致(验收 1 的前提)
  const again = buildCameraDeriveSnapshot(bundle, instruction, 12345);
  assert.equal(JSON.stringify(snapshot), JSON.stringify(again));
});

test('cameraDeriveTaskNodeMappings restores mappings only for the derive preset', () => {
  const bundle = loadCameraDeriveWorkflow(makeBaseDir(validWorkflow()));
  const presetParametersJson = JSON.stringify({ cameraDerive: { nodeMappings: bundle.mappings } });
  assert.deepEqual(
    cameraDeriveTaskNodeMappings({ workflowPresetId: CAMERA_DERIVE_PRESET_ID, presetParametersJson }),
    bundle.mappings,
  );
  assert.equal(cameraDeriveTaskNodeMappings({ workflowPresetId: '02_klein_pulid_identity', presetParametersJson }), null);
  assert.equal(cameraDeriveTaskNodeMappings({ workflowPresetId: CAMERA_DERIVE_PRESET_ID, presetParametersJson: 'not json' }), null);
});
