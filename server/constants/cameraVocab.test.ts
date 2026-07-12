import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAMERA_H,
  CAMERA_V,
  CAMERA_ZOOM,
  CAMERA_H_KEYS,
  CAMERA_V_KEYS,
  CAMERA_ZOOM_KEYS,
  CAMERA_INSTRUCTION_TEMPLATE,
  renderCameraInstruction,
  cameraHAngleFromFront,
  isLargeAngleFromFront,
  isCameraH,
  isCameraV,
  isCameraZoom,
} from './cameraVocab.ts';

// 验收 2:确定性编译,无任何外部请求。渲染是纯函数;此处强制断言:
// 测试运行期间任何 fetch 调用都视为失败。
test('renderCameraInstruction never performs network calls', () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((..._args: any[]) => {
    fetchCalls += 1;
    throw new Error('network access is forbidden in cameraVocab');
  }) as any;
  try {
    for (const h of CAMERA_H_KEYS) {
      for (const v of CAMERA_V_KEYS) {
        for (const z of CAMERA_ZOOM_KEYS) {
          renderCameraInstruction(h, v, z);
        }
      }
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vocabulary cardinality is 8 x 4 x 5', () => {
  assert.equal(CAMERA_H_KEYS.length, 8);
  assert.equal(CAMERA_V_KEYS.length, 4);
  assert.equal(CAMERA_ZOOM_KEYS.length, 5);
});

// 验收 2:覆盖全部 8×4×5 = 160 组合的短语渲染。
test('all 160 combinations render the exact template phrase', () => {
  let combinations = 0;
  for (const h of CAMERA_H_KEYS) {
    for (const v of CAMERA_V_KEYS) {
      for (const z of CAMERA_ZOOM_KEYS) {
        const rendered = renderCameraInstruction(h, v, z);
        const expected =
          `Rotate the camera to the ${CAMERA_H[h]}, ${CAMERA_V[v]}, ${CAMERA_ZOOM[z]}.\n` +
          "Keep the character's identity, outfit, pose intent, lighting, props and set unchanged.";
        assert.equal(rendered, expected, `mismatch for ${h}/${v}/${z}`);
        // 短语只允许来自映射表,不允许出现未替换的占位符
        assert.ok(!rendered.includes('{H}') && !rendered.includes('{V}') && !rendered.includes('{Z}'));
        combinations += 1;
      }
    }
  }
  assert.equal(combinations, 160);
});

// 验收 1 的基础:同参数重复渲染字节级一致。
test('repeated rendering is byte-identical', () => {
  for (const h of CAMERA_H_KEYS) {
    for (const v of CAMERA_V_KEYS) {
      for (const z of CAMERA_ZOOM_KEYS) {
        const first = Buffer.from(renderCameraInstruction(h, v, z), 'utf8');
        const second = Buffer.from(renderCameraInstruction(h, v, z), 'utf8');
        assert.ok(first.equals(second), `bytes differ for ${h}/${v}/${z}`);
      }
    }
  }
});

test('template is defined in a single place and used verbatim', () => {
  const rendered = renderCameraInstruction('front', 'eye', 'medium');
  const expected = CAMERA_INSTRUCTION_TEMPLATE
    .replace('{H}', CAMERA_H.front)
    .replace('{V}', CAMERA_V.eye)
    .replace('{Z}', CAMERA_ZOOM.medium);
  assert.equal(rendered, expected);
});

test('invalid enum keys throw instead of degrading silently', () => {
  assert.throws(() => renderCameraInstruction('diagonal' as any, 'eye', 'medium'), /Unknown cameraH/);
  assert.throws(() => renderCameraInstruction('front', 'bird' as any, 'medium'), /Unknown cameraV/);
  assert.throws(() => renderCameraInstruction('front', 'eye', 'macro' as any), /Unknown cameraZoom/);
});

test('type guards accept only known keys', () => {
  assert.ok(isCameraH('back_left') && !isCameraH('overhead') && !isCameraH(1));
  assert.ok(isCameraV('elevated') && !isCameraV('worm'));
  assert.ok(isCameraZoom('medium_cu') && !isCameraZoom('macro'));
});

// 大角度规则:与主帧(front)角度差 > 90° 的 back / back_left / back_right 触发 warning。
test('large-angle detection matches the >90 degree rule', () => {
  const expectations: Record<string, [number, boolean]> = {
    front: [0, false],
    front_right: [45, false],
    right: [90, false],
    back_right: [135, true],
    back: [180, true],
    back_left: [135, true],
    left: [90, false],
    front_left: [45, false],
  };
  for (const h of CAMERA_H_KEYS) {
    const [angle, large] = expectations[h];
    assert.equal(cameraHAngleFromFront(h), angle, `angle for ${h}`);
    assert.equal(isLargeAngleFromFront(h), large, `large-angle flag for ${h}`);
  }
});
