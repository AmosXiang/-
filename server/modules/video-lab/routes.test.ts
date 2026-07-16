import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { AGNES_VIDEO_CAPABILITY, type VideoProviderCapability } from './capability.ts';
import {
  registerVideoLabModule,
  type SubmitVideoTaskInput,
  type VideoLabDeps,
  type VideoTaskRow,
} from './routes.ts';
import { assembleVideoPrompt, type MotionPrompt } from './workflow.ts';

const FIXTURE_PROVIDER: VideoProviderCapability = {
  ...AGNES_VIDEO_CAPABILITY,
  id: 'fixture-all-modes',
  label: 'Fixture All Modes',
  supportedModes: { textToVideo: true, imageToVideo: true, firstLastFrame: true },
  durations: [...AGNES_VIDEO_CAPABILITY.durations],
  resolutions: [...AGNES_VIDEO_CAPABILITY.resolutions],
  aspectRatios: [...AGNES_VIDEO_CAPABILITY.aspectRatios],
  fpsOptions: [...AGNES_VIDEO_CAPABILITY.fpsOptions],
};

type Fixture = ReturnType<typeof createFixture>;

function project(id: string, width: number, height: number) {
  return {
    id,
    newShots: [
      {
        id: `${id}-shot-1`,
        description: 'Opening shot',
        optimizedPrompt: 'Optimized opening shot',
        cameraPromptUsed: 'Slow push in',
      },
      { id: `${id}-shot-2`, description: 'Closing shot' },
    ],
    styleContract: {
      version: 7,
      locked: true,
      updatedAt: '2026-07-16T00:00:00.000Z',
      storyboardPresetId: 'pure_klein',
      styleOverlay: 'cinematic',
      width,
      height,
      loraStrength: 1,
    },
  };
}

function createFixture(configuredProviders = ['agnes']) {
  const store = {
    generated_scripts: [
      project('project-3x2', 1152, 768),
      project('project-wide', 1920, 1080),
    ],
  };
  const configured = new Set(configuredProviders);
  const submissions: SubmitVideoTaskInput[] = [];
  const videoTasks: VideoTaskRow[] = [];
  const readableLocalPaths = new Set<string>();
  let mutateCalls = 0;
  const deps: VideoLabDeps = {
    readDb: () => store,
    isProviderConfigured: providerId => configured.has(providerId),
    submitVideoTask: async input => {
      submissions.push(input);
      return { taskId: `task-${submissions.length}` };
    },
    mutateDb: mutator => {
      mutateCalls += 1;
      mutator(store);
    },
    listVideoTasksByShot: shotId => videoTasks.filter(row => row.shot_id === shotId),
    getVideoTask: taskId => videoTasks.find(row => row.id === taskId),
    isLocalVideoReadable: localPath => readableLocalPaths.has(localPath),
  };
  return {
    store,
    configured,
    submissions,
    videoTasks,
    readableLocalPaths,
    get mutateCalls() { return mutateCalls; },
    deps,
  };
}

async function withServer(
  fixture: Fixture,
  run: (baseUrl: string) => Promise<void>,
  capabilities?: VideoProviderCapability[],
) {
  const app = express();
  app.use(express.json());
  registerVideoLabModule(app, fixture.deps, capabilities);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function validBody(projectId = 'project-3x2', overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    shotId: `${projectId}-shot-1`,
    provider: 'agnes',
    mode: 'textToVideo',
    durationSec: 5,
    fps: 24,
    resolution: '1152x768',
    motionPrompt: {
      subjectScene: 'A traveler waits at a rain-soaked station.',
      action: 'The traveler turns toward an arriving train.',
      cameraMove: 'Slow push in.',
      environment: 'Rain falls and steam drifts across the platform.',
      continuity: 'Keep the traveler and station layout consistent.',
      prohibitions: 'Do not add people or cut away.',
    },
    motionStrength: 'natural',
    seed: 42,
    ...overrides,
  };
}

function post(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/video-lab/shot-tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function videoTask(overrides: Partial<VideoTaskRow> = {}): VideoTaskRow {
  return {
    id: 'take-1',
    shot_id: 'project-3x2-shot-1',
    status: 'completed',
    local_path: '/uploads/video-tasks/take-1.mp4',
    download_error: null,
    created_at: '2026-07-16T01:00:00.000Z',
    ...overrides,
  };
}

function finalVideo(baseUrl: string, shotId: string, taskId: string | null, projectId = 'project-3x2') {
  return fetch(`${baseUrl}/api/video-lab/shots/${encodeURIComponent(shotId)}/final-video?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId }),
  });
}

function validBatchBody(projectId = 'project-3x2', overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    shotIds: [`${projectId}-shot-1`, `${projectId}-shot-2`],
    provider: 'agnes',
    durationSec: 5,
    fps: 24,
    resolution: '1152x768',
    motionStrength: 'natural',
    confirmed: true,
    ...overrides,
  };
}

function postBatch(baseUrl: string, body: unknown) {
  return fetch(`${baseUrl}/api/video-lab/batch-shot-tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET providers returns the static Agnes shape with the configured flag', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/video-lab/providers`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      providers: [{ ...AGNES_VIDEO_CAPABILITY, configured: true }],
    });
  });
});

test('project, shot, provider, and configuration checks are ordered and machine-readable', async () => {
  const fixture = createFixture([]);
  await withServer(fixture, async baseUrl => {
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [validBody('missing-project'), 404, 'PROJECT_NOT_FOUND'],
      [validBody('project-3x2', { shotId: 'missing-shot' }), 404, 'SHOT_NOT_FOUND'],
      [validBody('project-3x2', { provider: 'missing-provider' }), 422, 'PROVIDER_UNKNOWN'],
      [validBody(), 422, 'PROVIDER_NOT_CONFIGURED'],
    ];
    for (const [body, status, code] of cases) {
      const response = await post(baseUrl, body);
      assert.equal(response.status, status, code);
      assert.equal((await response.json() as any).code, code);
    }
    assert.equal(fixture.submissions.length, 0);
  });
});

test('mode validation rejects Agnes image modes and accepts all three modes on a test-only fixture provider', async () => {
  const fixture = createFixture(['agnes', FIXTURE_PROVIDER.id]);
  await withServer(fixture, async baseUrl => {
    for (const mode of ['imageToVideo', 'firstLastFrame']) {
      const response = await post(baseUrl, validBody('project-3x2', { mode }));
      assert.equal(response.status, 422);
      const data: any = await response.json();
      assert.equal(data.code, 'MODE_UNSUPPORTED');
      assert.deepEqual(data.supportedModes, AGNES_VIDEO_CAPABILITY.supportedModes);
    }

    for (const mode of ['textToVideo', 'imageToVideo', 'firstLastFrame']) {
      const response = await post(baseUrl, validBody('project-3x2', {
        provider: FIXTURE_PROVIDER.id,
        mode,
      }));
      assert.equal(response.status, 201, mode);
      assert.equal((await response.json() as any).snapshot.mode, mode);
    }
    assert.equal(fixture.submissions.length, 3);
  }, [AGNES_VIDEO_CAPABILITY, FIXTURE_PROVIDER]);
});

test('duration, fps, and resolution must each match the selected capability enum', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    for (const [parameter, value] of [
      ['durationSec', 4],
      ['fps', 30],
      ['resolution', '1920x1080'],
    ] as const) {
      const response = await post(baseUrl, validBody('project-3x2', { [parameter]: value }));
      assert.equal(response.status, 422, parameter);
      const data: any = await response.json();
      assert.equal(data.code, 'PARAM_OUT_OF_CAPABILITY');
      assert.equal(data.parameter, parameter);
    }
    assert.equal(fixture.submissions.length, 0);
  });
});

test('supported project aspect inherits directly and records a complete immutable submission snapshot', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await post(baseUrl, validBody('project-3x2', {
      negativePrompt: 'flicker, identity drift',
    }));
    assert.equal(response.status, 201);
    const data: any = await response.json();
    assert.equal(data.taskId, 'task-1');
    assert.deepEqual(data.snapshot, {
      schemaVersion: 1,
      provider: 'agnes',
      mode: 'textToVideo',
      parameters: {
        durationSec: 5,
        fps: 24,
        resolution: '1152x768',
        width: 1152,
        height: 768,
        numFrames: 121,
        motionStrength: 'natural',
        negativePrompt: 'flicker, identity drift',
      },
      aspect: {
        projectAspect: '3:2',
        effectiveAspectRatio: '3:2',
        source: 'style_contract',
      },
      motionPrompt: validBody().motionPrompt,
      prompt: [
        'Subject and scene: A traveler waits at a rain-soaked station.',
        'Action: The traveler turns toward an arriving train.',
        'Motion intensity: natural, restrained motion',
        'Camera movement: Slow push in.',
        'Environment motion: Rain falls and steam drifts across the platform.',
        'Continuity constraints: Keep the traveler and station layout consistent.',
        'Prohibited changes: Do not add people or cut away.',
      ].join('\n'),
      seed: 42,
      styleContractVersion: 7,
    });
    assert.deepEqual(fixture.submissions[0], {
      shotId: 'project-3x2-shot-1',
      provider: 'agnes',
      prompt: data.snapshot.prompt,
      negativePrompt: 'flicker, identity drift',
      seed: 42,
      numFrames: 121,
      frameRate: 24,
      generationSnapshotJson: JSON.stringify(data.snapshot),
    });
  });
});

test('unsupported project aspect returns the normal-path 409 with supported ratios', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await post(baseUrl, validBody('project-wide'));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'The selected provider does not support the project aspect ratio.',
      code: 'ASPECT_UNSUPPORTED',
      projectAspect: '16:9',
      supportedAspectRatios: ['3:2'],
    });
    assert.equal(fixture.submissions.length, 0);
  });
});

test('an explicit crop or letterbox decision is applied and recorded as user adaptation', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    for (const adaptMode of ['crop', 'letterbox'] as const) {
      const response = await post(baseUrl, validBody('project-wide', {
        aspectDecision: { aspectRatio: '3:2', adaptMode },
      }));
      assert.equal(response.status, 201, adaptMode);
      assert.deepEqual((await response.json() as any).snapshot.aspect, {
        projectAspect: '16:9',
        effectiveAspectRatio: '3:2',
        source: 'user_adaptation',
        adaptMode,
      });
    }
    assert.equal(fixture.submissions.length, 2);
  });
});

test('assembleVideoPrompt preserves six-part order, skips empty fields, and injects strength before camera movement', () => {
  const motionPrompt: MotionPrompt = {
    subjectScene: 'A lighthouse above dark water.',
    action: 'The keeper raises a lantern.',
    cameraMove: 'Orbit clockwise.',
    environment: '',
    continuity: 'Keep the same keeper and lighthouse.',
    prohibitions: 'No cuts.',
  };
  assert.equal(assembleVideoPrompt(motionPrompt, 'extreme'), [
    'Subject and scene: A lighthouse above dark water.',
    'Action: The keeper raises a lantern.',
    'Motion intensity: dynamic, high-intensity motion',
    'Camera movement: Orbit clockwise.',
    'Continuity constraints: Keep the same keeper and lighthouse.',
    'Prohibited changes: No cuts.',
  ].join('\n'));
});

test('empty subjectScene is rejected before submission', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await post(baseUrl, validBody('project-3x2', {
      motionPrompt: { subjectScene: '   ', cameraMove: 'Pan left.' },
    }));
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      error: 'motionPrompt.subjectScene must not be empty.',
      code: 'SUBJECT_SCENE_REQUIRED',
      field: 'subjectScene',
    });
    assert.equal(fixture.submissions.length, 0);
  });
});

test('GET shot tasks verifies project ownership and returns newest takes first', async () => {
  const fixture = createFixture();
  fixture.videoTasks.push(
    videoTask({ id: 'older', created_at: '2026-07-16T01:00:00.000Z' }),
    videoTask({ id: 'newer', created_at: '2026-07-16T03:00:00.000Z' }),
    videoTask({ id: 'middle', created_at: '2026-07-16T02:00:00.000Z' }),
    videoTask({ id: 'other-shot', shot_id: 'project-3x2-shot-2' }),
  );
  await withServer(fixture, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/video-lab/shots/project-3x2-shot-1/tasks?projectId=project-3x2`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).tasks.map((row: any) => row.id), ['newer', 'middle', 'older']);

    for (const [projectId, shotId, code] of [
      ['missing-project', 'project-3x2-shot-1', 'PROJECT_NOT_FOUND'],
      ['project-3x2', 'missing-shot', 'SHOT_NOT_FOUND'],
    ]) {
      const missing = await fetch(`${baseUrl}/api/video-lab/shots/${shotId}/tasks?projectId=${projectId}`);
      assert.equal(missing.status, 404);
      assert.equal((await missing.json() as any).code, code);
    }
  });
});

test('final-video rejects all five unsafe take states without mutating the project', async () => {
  const fixture = createFixture();
  fixture.videoTasks.push(
    videoTask({ id: 'wrong-shot', shot_id: 'project-3x2-shot-2' }),
    videoTask({ id: 'still-running', status: 'in_progress' }),
    videoTask({ id: 'not-downloaded', local_path: null, download_error: 'disk full' }),
    videoTask({ id: 'missing-file', local_path: '/uploads/video-tasks/missing.mp4' }),
  );
  await withServer(fixture, async baseUrl => {
    const cases = [
      ['unknown-take', 'TAKE_NOT_FOUND'],
      ['wrong-shot', 'TAKE_SHOT_MISMATCH'],
      ['still-running', 'TAKE_NOT_COMPLETED'],
      ['not-downloaded', 'TAKE_NOT_DOWNLOADED'],
      ['missing-file', 'TAKE_FILE_MISSING'],
    ] as const;
    for (const [taskId, code] of cases) {
      const response = await finalVideo(baseUrl, 'project-3x2-shot-1', taskId);
      assert.equal(response.status, 422, code);
      const data: any = await response.json();
      assert.equal(data.code, code);
      if (code === 'TAKE_NOT_DOWNLOADED') assert.equal(data.download_error, 'disk full');
    }
    assert.equal(fixture.mutateCalls, 0);
    assert.equal((fixture.store.generated_scripts[0].newShots[0] as any).finalVideoTaskId, undefined);
  });
});

test('final-video writes a readable local take and null removes the JSON field', async () => {
  const fixture = createFixture();
  const row = videoTask({ id: 'gold-take' });
  fixture.videoTasks.push(row);
  fixture.readableLocalPaths.add(String(row.local_path));
  await withServer(fixture, async baseUrl => {
    const selected = await finalVideo(baseUrl, 'project-3x2-shot-1', 'gold-take');
    assert.equal(selected.status, 200);
    assert.equal((await selected.json() as any).shot.finalVideoTaskId, 'gold-take');
    assert.equal((fixture.store.generated_scripts[0].newShots[0] as any).finalVideoTaskId, 'gold-take');

    const cleared = await finalVideo(baseUrl, 'project-3x2-shot-1', null);
    assert.equal(cleared.status, 200);
    assert.equal(Object.hasOwn((await cleared.json() as any).shot, 'finalVideoTaskId'), false);
    assert.equal(Object.hasOwn(fixture.store.generated_scripts[0].newShots[0], 'finalVideoTaskId'), false);
    assert.equal(fixture.mutateCalls, 2);
  });
});

test('batch generation requires confirmed true and performs zero submissions otherwise', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    for (const confirmed of [false, undefined]) {
      const response = await postBatch(baseUrl, validBatchBody('project-3x2', { confirmed }));
      assert.equal(response.status, 422);
      assert.equal((await response.json() as any).code, 'BATCH_NOT_CONFIRMED');
    }
    assert.equal(fixture.submissions.length, 0);
  });
});

test('batch generation rejects oversized, foreign, and promptless selections before submission', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const oversized = await postBatch(baseUrl, validBatchBody('project-3x2', {
      shotIds: Array.from({ length: 101 }, (_, index) => `shot-${index}`),
    }));
    assert.equal(oversized.status, 422);
    assert.equal((await oversized.json() as any).code, 'BATCH_TOO_LARGE');

    const foreign = await postBatch(baseUrl, validBatchBody('project-3x2', {
      shotIds: ['project-3x2-shot-1', 'project-wide-shot-1'],
    }));
    assert.equal(foreign.status, 404);
    assert.deepEqual((await foreign.json() as any).missingShotIds, ['project-wide-shot-1']);

    fixture.store.generated_scripts[0].newShots[1].description = '   ';
    const promptless = await postBatch(baseUrl, validBatchBody());
    assert.equal(promptless.status, 422);
    const promptlessData: any = await promptless.json();
    assert.equal(promptlessData.code, 'SHOTS_MISSING_PROMPT');
    assert.deepEqual(promptlessData.missingShotIds, ['project-3x2-shot-2']);
    assert.equal(fixture.submissions.length, 0);
  });
});

test('batch generation shares the M1 aspect decision gate', async () => {
  const fixture = createFixture();
  await withServer(fixture, async baseUrl => {
    const response = await postBatch(baseUrl, validBatchBody('project-wide'));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'The selected provider does not support the project aspect ratio.',
      code: 'ASPECT_UNSUPPORTED',
      projectAspect: '16:9',
      supportedAspectRatios: ['3:2'],
    });
    assert.equal(fixture.submissions.length, 0);
  });
});

test('batch generation continues after a per-shot failure and gives each shot an independent seed and snapshot', async () => {
  const fixture = createFixture();
  fixture.deps.submitVideoTask = async input => {
    fixture.submissions.push(input);
    if (input.shotId === 'project-3x2-shot-1') throw new Error('provider rejected opening shot');
    return { taskId: 'closing-task' };
  };
  await withServer(fixture, async baseUrl => {
    const response = await postBatch(baseUrl, validBatchBody('project-3x2', {
      shotIds: ['project-3x2-shot-1', 'project-3x2-shot-1', 'project-3x2-shot-2'],
    }));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      submitted: [{ shotId: 'project-3x2-shot-2', taskId: 'closing-task' }],
      failed: [{ shotId: 'project-3x2-shot-1', error: 'provider rejected opening shot' }],
    });
    assert.equal(fixture.submissions.length, 2);
    assert.notEqual(fixture.submissions[0].seed, fixture.submissions[1].seed);

    const openingSnapshot = JSON.parse(fixture.submissions[0].generationSnapshotJson);
    const closingSnapshot = JSON.parse(fixture.submissions[1].generationSnapshotJson);
    assert.equal(openingSnapshot.seed, fixture.submissions[0].seed);
    assert.equal(closingSnapshot.seed, fixture.submissions[1].seed);
    assert.deepEqual(openingSnapshot.motionPrompt, {
      subjectScene: 'Optimized opening shot',
      cameraMove: 'Slow push in',
    });
    assert.deepEqual(closingSnapshot.motionPrompt, { subjectScene: 'Closing shot' });
  });
});

test('batch generation reports 502 only when every independent submission fails', async () => {
  const fixture = createFixture();
  fixture.deps.submitVideoTask = async input => {
    fixture.submissions.push(input);
    throw new Error(`failed ${input.shotId}`);
  };
  await withServer(fixture, async baseUrl => {
    const response = await postBatch(baseUrl, validBatchBody());
    assert.equal(response.status, 502);
    const data: any = await response.json();
    assert.deepEqual(data.submitted, []);
    assert.deepEqual(data.failed.map((item: any) => item.shotId), [
      'project-3x2-shot-1',
      'project-3x2-shot-2',
    ]);
    assert.equal(fixture.submissions.length, 2);
  });
});
