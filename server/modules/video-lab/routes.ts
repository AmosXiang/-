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

export type VideoLabDeps = {
  readDb: ReadDb;
  submitVideoTask: (input: SubmitVideoTaskInput) => Promise<{ taskId: string }>;
  isProviderConfigured: (providerId: string) => boolean;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestBody(req: Request): Record<string, unknown> {
  return isObject(req.body) ? req.body : {};
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

function findProjectAndShot(readDb: ReadDb, projectId: string, shotId: string): { project: any; shot: any } {
  const projects = readDb()?.generated_scripts;
  if (!Array.isArray(projects)) {
    throw new VideoLabError(422, 'Stored generated_scripts data is unavailable.', 'PROJECT_DATA_INVALID');
  }
  const project = projects.find((item: any) => String(item?.id) === projectId);
  if (!project) {
    throw new VideoLabError(404, `Project '${projectId}' not found.`, 'PROJECT_NOT_FOUND');
  }
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
    throw new VideoLabError(422, `Provider '${providerId}' is not available in Video Lab M1.`, 'PROVIDER_UNKNOWN');
  }
  return capability;
}

export function registerVideoLabModule(
  app: Express,
  deps: VideoLabDeps,
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
}
