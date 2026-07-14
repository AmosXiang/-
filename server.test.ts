import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildVideoPrompt,
  assertStoryboardEnrichment,
  publicComfyTask,
  VIDEO_PROVIDER_CONFIG
} from './server.ts';

// Test assertion helper for validation exceptions
function assertRejectsWithSchemaInvalid(shot: any, msg: string) {
  assert.throws(
    () => assertStoryboardEnrichment(shot),
    (err: any) => err.message.includes('STORYBOARD_SCHEMA_INVALID') && err.message.includes(msg)
  );
}

test('assertStoryboardEnrichment schema validation rules', () => {
  // Valid baseline shot
  const validShot = {
    camera: { move: 'static', speed: 'medium', note: 'test camera note' },
    framing: { shotSize: 'medium', angle: 'front' },
    blocking: [
      { characterId: 'char-1', layer: 'midground', position: 'center', gaze: 'camera', outOfFocus: false }
    ],
    durationSec: 5,
    provenance: 'edited'
  };

  // Valid run
  assert.doesNotThrow(() => assertStoryboardEnrichment(validShot));

  // Invalid camera move
  assertRejectsWithSchemaInvalid({ ...validShot, camera: { ...validShot.camera, move: 'fly_in' } }, 'camera');

  // Invalid camera speed
  assertRejectsWithSchemaInvalid({ ...validShot, camera: { ...validShot.camera, speed: 'super_sonic' } }, 'camera');

  // Missing framing
  const missingFraming = { ...validShot };
  delete (missingFraming as any).framing;
  assertRejectsWithSchemaInvalid(missingFraming, 'framing');

  // Invalid framing shot size
  assertRejectsWithSchemaInvalid({ ...validShot, framing: { ...validShot.framing, shotSize: 'extra_large' } }, 'framing');

  // Invalid blocking gaze pattern
  const badGazeShot = {
    ...validShot,
    blocking: [
      { characterId: 'char-1', layer: 'midground', position: 'center', gaze: 'invalid_gaze_value', outOfFocus: false }
    ]
  };
  assertRejectsWithSchemaInvalid(badGazeShot, 'blocking item');

  // Valid at_character gaze pattern
  const goodGazeShot = {
    ...validShot,
    blocking: [
      { characterId: 'char-1', layer: 'midground', position: 'center', gaze: 'at_character:char-2', outOfFocus: false }
    ]
  };
  assert.doesNotThrow(() => assertStoryboardEnrichment(goodGazeShot));

  // Invalid duration
  assertRejectsWithSchemaInvalid({ ...validShot, durationSec: -1 }, 'durationSec');
  assertRejectsWithSchemaInvalid({ ...validShot, durationSec: 0 }, 'durationSec');

  // Invalid provenance
  assertRejectsWithSchemaInvalid({ ...validShot, provenance: 'unknown_source' }, 'provenance');

  // Expected provenance validation match
  assert.doesNotThrow(() => assertStoryboardEnrichment(validShot, 'edited'));
  assert.throws(() => assertStoryboardEnrichment(validShot, 'analyzed'), /provenance must be analyzed/);
});

test('buildVideoPrompt Kling limits and text fallback', () => {
  const shot = {
    description: 'A futuristic city street',
    camera: { move: 'pan', speed: 'slow', note: 'sweeping view' },
    framing: { shotSize: 'wide', angle: 'low' },
    blocking: [
      { characterId: 'hero', layer: 'foreground', position: 'left', gaze: 'away', outOfFocus: false }
    ],
    durationSec: 8,
    provenance: 'edited'
  };

  const result = buildVideoPrompt(shot, 'kling');

  // For Kling, max duration limit is 10s
  assert.ok(VIDEO_PROVIDER_CONFIG.kling.maxDurationSec === 10);
  assert.ok(result.prompt.includes('A futuristic city street'));
  assert.ok(result.prompt.includes('wide shot, low angle'));
  // Text fallback:运镜以文本方式传递
  assert.ok(result.prompt.includes('pan camera, slow speed, sweeping view'));
  assert.ok(result.deliveryNotes.includes('运镜以文本方式传递'));
  assert.deepEqual(result.nativeParams, { durationSec: 8 });

  // Violate Kling's limit (> 10s)
  const longShot = { ...shot, durationSec: 11 };
  assert.throws(
    () => buildVideoPrompt(longShot, 'kling'),
    /DURATION_LIMIT_EXCEEDED: kling max 10s/
  );
});

test('buildVideoPrompt Seedance limits and native params', () => {
  const shot = {
    description: 'A cozy log cabin',
    camera: { move: 'push_in', speed: 'medium', note: 'focusing on fireplace' },
    framing: { shotSize: 'medium_close', angle: 'front' },
    blocking: [
      { characterId: 'grandma', layer: 'midground', position: 'right', gaze: 'camera', outOfFocus: false }
    ],
    durationSec: 12,
    provenance: 'edited'
  };

  const result = buildVideoPrompt(shot, 'seedance');

  // Seedance max duration limit is 12s
  assert.ok(VIDEO_PROVIDER_CONFIG.seedance.maxDurationSec === 12);
  assert.ok(result.prompt.includes('A cozy log cabin'));
  assert.ok(result.prompt.includes('medium_close shot, front angle'));
  
  // Seedance uses native camera moves, so camera details are not in the main prompt string
  assert.ok(!result.prompt.includes('push_in camera'));
  assert.ok(!result.deliveryNotes.includes('运镜以文本方式传递'));
  assert.deepEqual(result.nativeParams, {
    durationSec: 12,
    camera: { move: 'push_in', speed: 'medium', note: 'focusing on fireplace' }
  });

  // Violate Seedance's limit (> 12s)
  const tooLongShot = { ...shot, durationSec: 13 };
  assert.throws(
    () => buildVideoPrompt(tooLongShot, 'seedance'),
    /DURATION_LIMIT_EXCEEDED: seedance max 12s/
  );
});

test('publicComfyTask failReason classification rules', () => {
  const baseTask = {
    id: 'task-123',
    status: 'failed',
    error: '',
    imageUrl: 'http://test.com/img.jpg'
  };

  // Timeout classification
  assert.equal(publicComfyTask({ ...baseTask, error: 'Task timed out after 300s' }).failReason, 'timeout');
  assert.equal(publicComfyTask({ ...baseTask, error: '超时发生，ComfyUI 无响应' }).failReason, 'timeout');
  assert.equal(publicComfyTask({ ...baseTask, stateDetail: 'timeout' }).failReason, 'timeout');

  // Queue lost classification
  assert.equal(publicComfyTask({ ...baseTask, error: 'missing from both queue and history' }).failReason, 'lost_queue');
  assert.equal(publicComfyTask({ ...baseTask, error: '队列中的任务丢失' }).failReason, 'lost_queue');

  // Parameter error classification
  assert.equal(publicComfyTask({ ...baseTask, error: 'Invalid parameter schema validation failed' }).failReason, 'param_error');
  assert.equal(publicComfyTask({ ...baseTask, error: '参数配置不正确' }).failReason, 'param_error');

  // Missing asset/workflow classification
  assert.equal(publicComfyTask({ ...baseTask, error: 'Missing workflow preset: 01_klein' }).failReason, 'missing');
  assert.equal(publicComfyTask({ ...baseTask, error: 'asset front view not found' }).failReason, 'missing');

  // Unknown error classification
  assert.equal(publicComfyTask({ ...baseTask, error: 'Some strange system error' }).failReason, 'unknown');
  
  // Successful tasks return null failReason
  assert.equal(publicComfyTask({ ...baseTask, status: 'succeed' }).failReason, null);
});
