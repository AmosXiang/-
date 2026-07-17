import type { Express, Request, Response } from 'express';

import {
  resolveEffectiveStyleContract,
  StyleContractError,
  type ReadDb,
} from '../style-contract/index.ts';
import {
  VIDEO_PROVIDER_CAPABILITIES,
  type VideoProviderCapability,
} from './capability.ts';
import {
  VideoLabError,
  aspectRatioFromDimensions,
  assembleVideoPrompt,
  buildVideoGenerationSnapshot,
  resolveVideoAspect,
  validateVideoParameters,
} from './workflow.ts';

export type SubmitVideoTaskInput = {
  shotId: string;
  provider: string;
  prompt: string;
  negativePrompt?: string;
  seed: number;
  numFrames: number;
  frameRate: number;
  generationSnapshotJson: string;
};

export type VideoTaskRow = {
  id: string;
  shot_id: string | null;
  status: string;
  local_path?: string | null;
  download_error?: string | null;
  created_at: string;
  [key: string]: unknown;
};

type VideoLabM1Deps = {
  readDb: ReadDb;
  submitVideoTask: (input: SubmitVideoTaskInput) => Promise<{ taskId: string }>;
  isProviderConfigured: (providerId: string) => boolean;
};

type VideoLabM2Deps = {
  mutateDb: (mutator: (db: any) => void) => void | Promise<void>;
  listVideoTasksByShot: (shotId: string) => VideoTaskRow[];
  getVideoTask: (taskId: string) => VideoTaskRow | undefined;
  isLocalVideoReadable: (localPath: string) => boolean;
};

type VideoLabM3Deps = {
  redownloadVideo: (taskId: string) => Promise<{ ok: boolean; error?: string }>;
  deleteVideoTaskRow: (taskId: string) => void;
};

export type VideoLabDeps = VideoLabM1Deps & VideoLabM2Deps & VideoLabM3Deps;

// The registration shape stays transitional until the server.ts follow-up
// lands; M2/M3 routes reject unwired dependencies explicitly with a 503.
type VideoLabRegistrationDeps = VideoLabM1Deps & Partial<VideoLabM2Deps & VideoLabM3Deps>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestBody(req: Request): Record<string, unknown> {
  return isObject(req.body) ? req.body : {};
}

function queryText(req: Request, field: string): string {
  const value = req.query[field];
  return typeof value === 'string' ? value : '';
}

function sendError(res: Response, error: unknown) {
  if (error instanceof VideoLabError) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
  }
  if (error instanceof StyleContractError) {
    return res.status(error.status).json({ error: error.message, code: error.code, ...error.details });
  }
  const message = error instanceof Error ? error.message : 'Unknown Video Lab error.';
  return res.status(500).json({ error: message, code: 'VIDEO_LAB_INTERNAL_ERROR' });
}

function projectsFrom(readDb: ReadDb): any[] {
  const projects = readDb()?.generated_scripts;
  if (!Array.isArray(projects)) {
    throw new VideoLabError(422, 'Stored generated_scripts data is unavailable.', 'PROJECT_DATA_INVALID');
  }
  return projects;
}

function findProject(readDb: ReadDb, projectId: string): any {
  const project = projectsFrom(readDb).find((item: any) => String(item?.id) === projectId);
  if (!project) {
    throw new VideoLabError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  }
  return project;
}

function findProjectAndShot(readDb: ReadDb, projectId: string, shotId: string): { project: any; shot: any } {
  const project = findProject(readDb, projectId);
  const shots = Array.isArray(project.newShots) ? project.newShots : [];
  const shot = shots.find((item: any) => String(item?.id) === shotId);
  if (!shot) {
    throw new VideoLabError(404, `Shot '${shotId}' not found in project '${projectId}'.`, 'SHOT_NOT_FOUND');
  }
  return { project, shot };
}

function capabilityById(capabilities: VideoProviderCapability[], providerId: string): VideoProviderCapability {
  const capability = capabilities.find(item => item.id === providerId);
  if (!capability) {
    throw new VideoLabError(422, `Provider '${providerId}' is not available in Video Lab.`, 'PROVIDER_UNKNOWN');
  }
  return capability;
}

function requireDependency<T>(value: T | undefined, name: string, milestone: 2 | 3 = 2): T {
  if (value === undefined) {
    throw new VideoLabError(503, `Video Lab M${milestone} dependency '${name}' is not wired.`, `VIDEO_LAB_M${milestone}_NOT_CONFIGURED`, {
      dependency: name,
    });
  }
  return value;
}

function shotPromptText(shot: any): string {
  const optimized = typeof shot?.optimizedPrompt === 'string' ? shot.optimizedPrompt.trim() : '';
  const description = typeof shot?.description === 'string' ? shot.description.trim() : '';
  return optimized || description;
}

function cameraPromptText(shot: any): string | undefined {
  const value = typeof shot?.cameraPromptUsed === 'string' ? shot.cameraPromptUsed.trim() : '';
  return value || undefined;
}

export function registerVideoLabModule(
  app: Express,
  deps: VideoLabRegistrationDeps,
  capabilities: VideoProviderCapability[] = VIDEO_PROVIDER_CAPABILITIES,
): void {
  app.get('/api/video-lab/providers', (_req: Request, res: Response) => {
    try {
      return res.json({
        providers: capabilities.map(capability => ({
          ...capability,
          supportedModes: { ...capability.supportedModes },
          durations: [...capability.durations],
          resolutions: [...capability.resolutions],
          aspectRatios: [...capability.aspectRatios],
          fpsOptions: [...capability.fpsOptions],
          configured: deps.isProviderConfigured(capability.id),
        })),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.get('/api/video-lab/shots/:shotId/tasks', (req: Request, res: Response) => {
    try {
      const projectId = queryText(req, 'projectId');
      const shotId = String(req.params.shotId || '');
      findProjectAndShot(deps.readDb, projectId, shotId);
      const listVideoTasksByShot = requireDependency(deps.listVideoTasksByShot, 'listVideoTasksByShot');
      const tasks = [...listVideoTasksByShot(shotId)].sort((left, right) => {
        const leftTime = Date.parse(left.created_at) || 0;
        const rightTime = Date.parse(right.created_at) || 0;
        return rightTime - leftTime;
      });
      return res.json({ tasks });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.put('/api/video-lab/shots/:shotId/final-video', async (req: Request, res: Response) => {
    try {
      const projectId = queryText(req, 'projectId');
      const shotId = String(req.params.shotId || '');
      findProjectAndShot(deps.readDb, projectId, shotId);
      const body = requestBody(req);
      const taskId = body.taskId;
      if (taskId !== null && (typeof taskId !== 'string' || !taskId.trim())) {
        throw new VideoLabError(422, 'taskId must be a non-empty string or null.', 'TAKE_ID_INVALID');
      }

      if (typeof taskId === 'string') {
        const getVideoTask = requireDependency(deps.getVideoTask, 'getVideoTask');
        const row = getVideoTask(taskId);
        if (!row) {
          throw new VideoLabError(422, `Video take '${taskId}' was not found.`, 'TAKE_NOT_FOUND', { taskId });
        }
        if (String(row.shot_id || '') !== shotId) {
          throw new VideoLabError(422, `Video take '${taskId}' belongs to another shot.`, 'TAKE_SHOT_MISMATCH', {
            taskId,
            taskShotId: row.shot_id,
          });
        }
        if (row.status !== 'completed') {
          throw new VideoLabError(422, `Video take '${taskId}' is not completed.`, 'TAKE_NOT_COMPLETED', {
            taskId,
            status: row.status,
          });
        }
        const localPath = typeof row.local_path === 'string' ? row.local_path.trim() : '';
        if (!localPath) {
          throw new VideoLabError(422, `Video take '${taskId}' has not been downloaded.`, 'TAKE_NOT_DOWNLOADED', {
            taskId,
            download_error: row.download_error || null,
          });
        }
        const isLocalVideoReadable = requireDependency(deps.isLocalVideoReadable, 'isLocalVideoReadable');
        if (!isLocalVideoReadable(localPath)) {
          throw new VideoLabError(422, `The local file for video take '${taskId}' is missing or unreadable.`, 'TAKE_FILE_MISSING', {
            taskId,
          });
        }
      }

      const mutateDb = requireDependency(deps.mutateDb, 'mutateDb');
      let updatedShot: any;
      await Promise.resolve(mutateDb(db => {
        const result = findProjectAndShot(() => db, projectId, shotId);
        if (taskId === null) delete result.shot.finalVideoTaskId;
        else result.shot.finalVideoTaskId = taskId;
        updatedShot = result.shot;
      }));
      return res.json({ shot: updatedShot });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/video-lab/tasks/:taskId/retry-download', async (req: Request, res: Response) => {
    try {
      const projectId = queryText(req, 'projectId');
      const taskId = String(req.params.taskId || '');
      const getVideoTask = requireDependency(deps.getVideoTask, 'getVideoTask');
      const row = getVideoTask(taskId);
      if (!row) {
        throw new VideoLabError(404, `Video task '${taskId}' was not found.`, 'TASK_NOT_FOUND', { taskId });
      }
      findProjectAndShot(deps.readDb, projectId, String(row.shot_id || ''));
      if (row.status !== 'completed') {
        throw new VideoLabError(422, `Video task '${taskId}' is not completed.`, 'TASK_NOT_COMPLETED', {
          taskId,
          status: row.status,
        });
      }
      const localPath = typeof row.local_path === 'string' ? row.local_path.trim() : '';
      const downloadError = typeof row.download_error === 'string' ? row.download_error.trim() : '';
      if (localPath && !downloadError) {
        throw new VideoLabError(409, `Video task '${taskId}' is already downloaded.`, 'ALREADY_DOWNLOADED', { taskId });
      }
      const videoUrl = typeof row.video_url === 'string' ? row.video_url.trim() : '';
      if (!videoUrl) {
        throw new VideoLabError(422, `Video task '${taskId}' has no remote URL.`, 'NO_REMOTE_URL', { taskId });
      }

      const redownloadVideo = requireDependency(deps.redownloadVideo, 'redownloadVideo', 3);
      const result = await redownloadVideo(taskId);
      const task = getVideoTask(taskId) || row;
      if (!result.ok) {
        return res.status(502).json({
          error: result.error || 'Video download failed.',
          code: 'VIDEO_DOWNLOAD_FAILED',
          task,
        });
      }
      return res.json({ task });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.delete('/api/video-lab/tasks/:taskId', (req: Request, res: Response) => {
    try {
      const projectId = queryText(req, 'projectId');
      const taskId = String(req.params.taskId || '');
      const getVideoTask = requireDependency(deps.getVideoTask, 'getVideoTask');
      const row = getVideoTask(taskId);
      if (!row) {
        throw new VideoLabError(404, `Video task '${taskId}' was not found.`, 'TASK_NOT_FOUND', { taskId });
      }
      const { project } = findProjectAndShot(deps.readDb, projectId, String(row.shot_id || ''));
      if (row.status === 'in_progress') {
        throw new VideoLabError(422, `Video take '${taskId}' is still in progress.`, 'TAKE_IN_PROGRESS', { taskId });
      }
      const projectShots = Array.isArray(project.newShots) ? project.newShots : [];
      if (projectShots.some((shot: any) => String(shot?.finalVideoTaskId || '') === taskId)) {
        throw new VideoLabError(422, `Video take '${taskId}' is a final take.`, 'TAKE_IS_FINAL', { taskId });
      }

      const deleteVideoTaskRow = requireDependency(deps.deleteVideoTaskRow, 'deleteVideoTaskRow', 3);
      deleteVideoTaskRow(taskId);
      return res.json({ deleted: taskId });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/video-lab/shot-tasks', async (req: Request, res: Response) => {
    try {
      const body = requestBody(req);
      const projectId = String(body.projectId || '');
      const shotId = String(body.shotId || '');

      // Validation order is intentional: project/shot, provider/configuration,
      // mode/capability parameters, then project aspect inheritance.
      findProjectAndShot(deps.readDb, projectId, shotId);
      const providerId = String(body.provider || '');
      const capability = capabilityById(capabilities, providerId);
      if (!deps.isProviderConfigured(providerId)) {
        throw new VideoLabError(422, `Provider '${providerId}' is not configured.`, 'PROVIDER_NOT_CONFIGURED', {
          provider: providerId,
        });
      }

      const parameters = validateVideoParameters(body, capability);
      const styleContract = resolveEffectiveStyleContract(deps.readDb, projectId);
      const projectAspect = aspectRatioFromDimensions(styleContract.width, styleContract.height);
      const aspect = resolveVideoAspect(projectAspect, capability, body.aspectDecision);
      const prompt = assembleVideoPrompt(parameters.motionPrompt, parameters.motionStrength);
      const snapshot = buildVideoGenerationSnapshot({
        provider: providerId,
        parameters,
        aspect,
        prompt,
        styleContractVersion: styleContract.version,
      });

      let result: { taskId: string };
      try {
        result = await deps.submitVideoTask({
          shotId,
          provider: providerId,
          prompt,
          ...(parameters.negativePrompt ? { negativePrompt: parameters.negativePrompt } : {}),
          seed: parameters.seed,
          numFrames: parameters.numFrames,
          frameRate: parameters.fps,
          generationSnapshotJson: JSON.stringify(snapshot),
        });
      } catch (error) {
        throw new VideoLabError(502, error instanceof Error ? error.message : 'Video task submission failed.', 'VIDEO_TASK_SUBMIT_FAILED');
      }

      return res.status(201).json({ taskId: result.taskId, snapshot });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/video-lab/batch-shot-tasks', async (req: Request, res: Response) => {
    try {
      const body = requestBody(req);
      if (body.confirmed !== true) {
        throw new VideoLabError(422, 'Batch generation requires explicit confirmation.', 'BATCH_NOT_CONFIRMED');
      }
      if (!Array.isArray(body.shotIds) || body.shotIds.length === 0) {
        throw new VideoLabError(422, 'shotIds must contain at least one shot.', 'BATCH_SHOTS_REQUIRED');
      }
      const shotIds = [...new Set(body.shotIds.map(value => String(value || '')).filter(Boolean))];
      if (shotIds.length === 0) {
        throw new VideoLabError(422, 'shotIds must contain at least one shot.', 'BATCH_SHOTS_REQUIRED');
      }
      if (shotIds.length > 100) {
        throw new VideoLabError(422, 'A Video Lab batch may contain at most 100 shots.', 'BATCH_TOO_LARGE', {
          count: shotIds.length,
          maximum: 100,
        });
      }

      const projectId = String(body.projectId || '');
      const project = findProject(deps.readDb, projectId);
      const projectShots = Array.isArray(project.newShots) ? project.newShots : [];
      const shotsById = new Map(projectShots.map((shot: any) => [String(shot?.id || ''), shot]));
      const missingShotIds = shotIds.filter(shotId => !shotsById.has(shotId));
      if (missingShotIds.length > 0) {
        throw new VideoLabError(404, 'One or more batch shots were not found in the project.', 'SHOTS_NOT_FOUND', {
          missingShotIds,
        });
      }

      const providerId = String(body.provider || '');
      const capability = capabilityById(capabilities, providerId);
      if (!deps.isProviderConfigured(providerId)) {
        throw new VideoLabError(422, `Provider '${providerId}' is not configured.`, 'PROVIDER_NOT_CONFIGURED', {
          provider: providerId,
        });
      }

      const missingPromptShotIds = shotIds.filter(shotId => !shotPromptText(shotsById.get(shotId)));
      if (missingPromptShotIds.length > 0) {
        throw new VideoLabError(422, 'One or more batch shots have no usable video prompt.', 'SHOTS_MISSING_PROMPT', {
          missingShotIds: missingPromptShotIds,
        });
      }

      const styleContract = resolveEffectiveStyleContract(deps.readDb, projectId);
      const projectAspect = aspectRatioFromDimensions(styleContract.width, styleContract.height);
      const aspect = resolveVideoAspect(projectAspect, capability, body.aspectDecision);
      const prepared = shotIds.map(shotId => {
        const shot = shotsById.get(shotId);
        const parameters = validateVideoParameters({
          ...body,
          mode: 'textToVideo',
          motionPrompt: {
            subjectScene: shotPromptText(shot),
            ...(cameraPromptText(shot) ? { cameraMove: cameraPromptText(shot) } : {}),
          },
          seed: undefined,
        }, capability);
        const prompt = assembleVideoPrompt(parameters.motionPrompt, parameters.motionStrength);
        const snapshot = buildVideoGenerationSnapshot({
          provider: providerId,
          parameters,
          aspect,
          prompt,
          styleContractVersion: styleContract.version,
        });
        return { shotId, parameters, prompt, snapshot };
      });

      const submitted: Array<{ shotId: string; taskId: string }> = [];
      const failed: Array<{ shotId: string; error: string }> = [];
      for (const item of prepared) {
        try {
          const result = await deps.submitVideoTask({
            shotId: item.shotId,
            provider: providerId,
            prompt: item.prompt,
            ...(item.parameters.negativePrompt ? { negativePrompt: item.parameters.negativePrompt } : {}),
            seed: item.parameters.seed,
            numFrames: item.parameters.numFrames,
            frameRate: item.parameters.fps,
            generationSnapshotJson: JSON.stringify(item.snapshot),
          });
          submitted.push({ shotId: item.shotId, taskId: result.taskId });
        } catch (error) {
          failed.push({
            shotId: item.shotId,
            error: error instanceof Error ? error.message : 'Video task submission failed.',
          });
        }
      }

      return res.status(submitted.length > 0 ? 201 : 502).json({ submitted, failed });
    } catch (error) {
      return sendError(res, error);
    }
  });
}
