import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { AGNES_VIDEO_CAPABILITY, type VideoProviderCapability } from './capability.ts';
import { registerVideoLabModule, type SubmitVideoTaskInput, type VideoLabDeps } from './routes.ts';
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
      { id: `${id}-shot-1`, description: 'Opening shot' },
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
  const deps: VideoLabDeps = {
    readDb: () => store,
    isProviderConfigured: providerId => configured.has(providerId),
    submitVideoTask: async input => {
      submissions.push(input);
      return { taskId: `task-${submissions.length}` };
    },
  };
  return { store, configured, submissions, deps };
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
